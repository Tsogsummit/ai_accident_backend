# services/ai-detection-service/main.py
from fastapi import FastAPI, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional, List, Dict
import asyncio
import cv2
import numpy as np
from ultralytics import YOLO
from google.cloud import storage, pubsub_v1
import psycopg2
from psycopg2.extras import RealDictCursor
import json
import os
from datetime import datetime
import logging

# Logging setup
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="AI Detection Service")

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# YOLOv8 загвар ачаалах
MODEL_PATH = os.getenv('MODEL_PATH', 'models/yolov8n.pt')
model = YOLO(MODEL_PATH)
logger.info(f"✅ YOLOv8 модель загружен: {MODEL_PATH}")

# Google Cloud Storage
gcs_client = storage.Client(
    project=os.getenv('GCP_PROJECT_ID')
)
bucket_name = os.getenv('GCS_BUCKET_NAME', 'accident-videos')
bucket = gcs_client.bucket(bucket_name)

# PostgreSQL холболт
def get_db_connection():
    return psycopg2.connect(
        host=os.getenv('DB_HOST', 'localhost'),
        port=os.getenv('DB_PORT', '5432'),
        database=os.getenv('DB_NAME', 'accident_db'),
        user=os.getenv('DB_USER', 'postgres'),
        password=os.getenv('DB_PASSWORD', 'postgres')
    )

# Pub/Sub subscriber
subscriber = pubsub_v1.SubscriberClient()
subscription_path = subscriber.subscription_path(
    os.getenv('GCP_PROJECT_ID'),
    'video-processing-sub'
)

class VideoProcessRequest(BaseModel):
    videoId: int
    userId: int
    filePath: str
    latitude: float
    longitude: float
    description: Optional[str] = ""
    timestamp: str

class DetectionResult(BaseModel):
    videoId: int
    confidence: float
    detectedObjects: List[Dict]
    hasAccident: bool
    processedFrames: int
    totalFrames: int

def download_video_from_gcs(file_path: str, local_path: str) -> bool:
    """GCS-ээс бичлэг татаж авах"""
    try:
        blob = bucket.blob(file_path)
        blob.download_to_filename(local_path)
        logger.info(f"📥 Видео загружено: {file_path}")
        return True
    except Exception as e:
        logger.error(f"❌ Ошибка загрузки видео: {e}")
        return False

def extract_frames(video_path: str, interval: int = 2) -> List[np.ndarray]:
    """Бичлэгээс frame-үүд салгах"""
    frames = []
    cap = cv2.VideoCapture(video_path)
    
    if not cap.isOpened():
        logger.error(f"❌ Не удалось открыть видео: {video_path}")
        return frames
    
    fps = cap.get(cv2.CAP_PROP_FPS)
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    frame_interval = int(fps * interval)  # Хоёр секунд тутамд
    
    logger.info(f"📊 FPS: {fps}, Total frames: {total_frames}, Interval: {frame_interval}")
    
    frame_count = 0
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        
        if frame_count % frame_interval == 0:
            frames.append(frame)
        
        frame_count += 1
    
    cap.release()
    logger.info(f"✂️  Извлечено кадров: {len(frames)} из {total_frames}")
    return frames

def detect_accident(frames: List[np.ndarray], confidence_threshold: float = 0.5) -> Dict:
    """YOLOv8 ашиглан осол илрүүлэх"""
    accident_keywords = [
        'car', 'truck', 'bus', 'motorcycle', 
        'person', 'broken', 'damaged', 'crash'
    ]
    
    all_detections = []
    accident_frames = 0
    max_confidence = 0.0
    
    for idx, frame in enumerate(frames):
        # YOLOv8 inference
        results = model(frame, conf=confidence_threshold, verbose=False)
        
        for result in results:
            boxes = result.boxes
            for box in boxes:
                class_id = int(box.cls[0])
                confidence = float(box.conf[0])
                class_name = model.names[class_id]
                
                detection = {
                    'frame': idx,
                    'class': class_name,
                    'confidence': confidence,
                    'bbox': box.xyxy[0].tolist()
                }
                all_detections.append(detection)
                
                # Ослын түлхүүр үг шалгах
                if any(keyword in class_name.lower() for keyword in accident_keywords):
                    if confidence > max_confidence:
                        max_confidence = confidence
                    accident_frames += 1
    
    # Осол байгаа эсэх шалгах
    # Хэрэв 30%-иас дээш frame-д ослын тэмдэг илэрсэн бол
    has_accident = (accident_frames / len(frames)) > 0.3 and max_confidence > 0.6
    
    return {
        'hasAccident': has_accident,
        'confidence': max_confidence,
        'detectedObjects': all_detections,
        'accidentFrames': accident_frames,
        'totalFrames': len(frames)
    }

async def process_video(data: VideoProcessRequest):
    """Бичлэг боловсруулах үндсэн функц"""
    conn = None
    local_video_path = None
    
    try:
        logger.info(f"🎬 Начало обработки видео: {data.videoId}")
        
        conn = get_db_connection()
        cur = conn.cursor(cursor_factory=RealDictCursor)
        
        # 1. Video статус шинэчлэх
        cur.execute("""
            UPDATE videos 
            SET status = 'processing', processing_started_at = NOW()
            WHERE id = %s
        """, (data.videoId,))
        conn.commit()
        
        # 2. GCS-ээс бичлэг татах
        local_video_path = f"/tmp/video_{data.videoId}.mp4"
        if not download_video_from_gcs(data.filePath, local_video_path):
            raise Exception("Видео татаж авахад алдаа гарлаа")
        
        # 3. Frame-үүд салгах
        frames = extract_frames(local_video_path, interval=2)
        if not frames:
            raise Exception("Кадр салгаж чадсангүй")
        
        # 4. AI илрүүлэлт
        detection_result = detect_accident(frames)
        
        logger.info(f"🤖 AI Result: Accident={detection_result['hasAccident']}, Confidence={detection_result['confidence']:.2f}")
        
        # 5. AI detection хадгалах
        cur.execute("""
            INSERT INTO ai_detections (
                video_id, confidence, detected_objects, 
                status, processed_at
            )
            VALUES (%s, %s, %s, %s, NOW())
            RETURNING id
        """, (
            data.videoId,
            detection_result['confidence'],
            json.dumps(detection_result['detectedObjects']),
            'completed'
        ))
        
        detection_id = cur.fetchone()['id']
        
        # 6. Video статус шинэчлэх
        cur.execute("""
            UPDATE videos 
            SET status = 'completed', processing_completed_at = NOW()
            WHERE id = %s
        """, (data.videoId,))
        
        # 7. Хэрэв осол илэрсэн бол Accident үүсгэх
        if detection_result['hasAccident']:
            cur.execute("""
                INSERT INTO accidents (
                    user_id, latitude, longitude, description,
                    severity, status, source, video_id, timestamp,
                    verification_count
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, NOW(), 1)
                RETURNING id
            """, (
                data.userId,
                data.latitude,
                data.longitude,
                data.description or f"AI илэрсэн осол (итгэлцүүр: {detection_result['confidence']:.0%})",
                'moderate' if detection_result['confidence'] > 0.8 else 'minor',
                'confirmed' if detection_result['confidence'] > 0.85 else 'reported',
                'user',
                data.videoId
            ))
            
            accident_id = cur.fetchone()['id']
            logger.info(f"✅ Осол үүсгэгдлээ: accident_id={accident_id}")
        
        conn.commit()
        logger.info(f"✅ Видео боловсруулалт дууслаа: {data.videoId}")
        
    except Exception as e:
        logger.error(f"❌ Алдаа: {e}")
        if conn:
            conn.rollback()
            cur.execute("""
                UPDATE videos 
                SET status = 'failed', error_message = %s
                WHERE id = %s
            """, (str(e), data.videoId))
            conn.commit()
    
    finally:
        # Cleanup
        if local_video_path and os.path.exists(local_video_path):
            os.remove(local_video_path)
        
        if conn:
            conn.close()

# Pub/Sub message handler
def callback(message):
    """Pub/Sub мессеж боловсруулах"""
    try:
        data_dict = json.loads(message.data.decode('utf-8'))
        data = VideoProcessRequest(**data_dict)
        
        # Async process эхлүүлэх
        asyncio.run(process_video(data))
        
        message.ack()
        logger.info(f"✅ Мессеж боловсруулагдлаа: {data.videoId}")
        
    except Exception as e:
        logger.error(f"❌ Callback алдаа: {e}")
        message.nack()

@app.on_event("startup")
async def startup_event():
    """Pub/Sub subscriber эхлүүлэх"""
    logger.info("🚀 AI Detection Service эхэллээ")
    logger.info(f"📡 Pub/Sub subscription: {subscription_path}")
    
    # Background-д subscriber ажиллуулах
    streaming_pull_future = subscriber.subscribe(
        subscription_path, 
        callback=callback
    )
    logger.info("👂 Pub/Sub listener идэвхтэй")

@app.post("/process", response_model=DetectionResult)
async def process_video_endpoint(
    request: VideoProcessRequest,
    background_tasks: BackgroundTasks
):
    """Manual бичлэг боловсруулалт (HTTP endpoint)"""
    background_tasks.add_task(process_video, request)
    return {
        "message": "Бичлэг боловсруулалт эхэллээ",
        "videoId": request.videoId
    }

@app.get("/health")
async def health_check():
    return {
        "status": "healthy",
        "service": "ai-detection-service",
        "model": MODEL_PATH,
        "timestamp": datetime.now().isoformat()
    }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv('PORT', 3004)))