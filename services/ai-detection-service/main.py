"""
AI Detection Service - UPDATED WITH VEHICLE TRACKING
Credits: Vehicle tracking algorithm adapted from Kaggle notebook by datafan07
URL: https://www.kaggle.com/code/datafan07/car-accident-detection-yolov8
"""

from fastapi import FastAPI, BackgroundTasks, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from typing import Optional, List, Dict
import asyncio
import cv2
import numpy as np
from ultralytics import YOLO
from google.cloud import storage, pubsub_v1
import psycopg2
from psycopg2 import pool
from psycopg2.extras import RealDictCursor
import json
import os
from datetime import datetime
import logging
from contextlib import contextmanager

# Import vehicle tracker
from vehicle_tracker import VehicleTracker

# Logging setup
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

app = FastAPI(
    title="AI Detection Service",
    description="Vehicle tracking and accident detection using YOLOv8"
)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# YOLOv8 model
MODEL_PATH = os.getenv('MODEL_PATH', 'models/yolov8n.pt')
try:
    model = YOLO(MODEL_PATH)
    logger.info(f"✅ YOLOv8 loaded: {MODEL_PATH}")
except Exception as e:
    logger.error(f"❌ Failed to load YOLO: {e}")
    raise

# Google Cloud Storage
gcs_client = storage.Client(project=os.getenv('GCP_PROJECT_ID'))
bucket_name = os.getenv('GCS_BUCKET_NAME', 'accident-videos')
bucket = gcs_client.bucket(bucket_name)

# PostgreSQL Connection Pool
db_pool = None

def create_db_pool():
    global db_pool
    try:
        db_pool = psycopg2.pool.SimpleConnectionPool(
            minconn=1,
            maxconn=20,
            host=os.getenv('DB_HOST', 'localhost'),
            port=os.getenv('DB_PORT', '5432'),
            database=os.getenv('DB_NAME', 'accident_db'),
            user=os.getenv('DB_USER', 'postgres'),
            password=os.getenv('DB_PASSWORD', 'postgres')
        )
        logger.info("✅ Database pool created")
    except Exception as e:
        logger.error(f"❌ Failed to create DB pool: {e}")
        raise

@contextmanager
def get_db_connection():
    conn = None
    try:
        conn = db_pool.getconn()
        yield conn
    finally:
        if conn:
            db_pool.putconn(conn)

# Pub/Sub subscriber
subscriber = pubsub_v1.SubscriberClient()
subscription_path = subscriber.subscription_path(
    os.getenv('GCP_PROJECT_ID'),
    'video-processing-sub'
)


class VideoProcessRequest(BaseModel):
    videoId: int
    userId: Optional[int] = None
    filePath: str
    latitude: float = Field(..., ge=-90, le=90)
    longitude: float = Field(..., ge=-180, le=180)
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
    try:
        blob = bucket.blob(file_path)
        blob.download_to_filename(local_path)
        logger.info(f"📥 Video downloaded: {file_path}")
        return True
    except Exception as e:
        logger.error(f"❌ Download error: {e}")
        return False


def extract_frames(video_path: str, interval: int = 2) -> List[np.ndarray]:
    """Extract frames from video"""
    frames = []
    cap = cv2.VideoCapture(video_path)
    
    if not cap.isOpened():
        logger.error(f"❌ Cannot open video: {video_path}")
        return frames
    
    fps = cap.get(cv2.CAP_PROP_FPS)
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    frame_interval = int(fps * interval) if fps > 0 else 30
    
    logger.info(f"📊 FPS: {fps}, Total: {total_frames}, Interval: {frame_interval}")
    
    frame_count = 0
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        
        if frame_count % frame_interval == 0:
            frames.append(frame)
        
        frame_count += 1
    
    cap.release()
    logger.info(f"✂️ Extracted {len(frames)} frames from {total_frames}")
    return frames


def detect_accident_with_tracking(
    frames: List[np.ndarray],
    confidence_threshold: float = 0.3
) -> Dict:
    """
    Detect accidents using vehicle tracking approach
    Based on Kaggle notebook by datafan07
    """
    logger.info("🚗 Starting vehicle tracking analysis...")
    
    # Initialize tracker
    tracker = VehicleTracker(
        confidence_threshold=confidence_threshold,
        accident_detection_threshold=float(os.getenv('AI_CONFIDENCE_THRESHOLD', 0.6)),
        min_accident_ratio=float(os.getenv('AI_MIN_ACCIDENT_FRAME_RATIO', 0.3))
    )
    
    all_detections = []
    
    # Process each frame
    for frame_idx, frame in enumerate(frames):
        try:
            # YOLO inference
            results = model(frame, conf=confidence_threshold, verbose=False)
            
            for result in results:
                boxes = result.boxes
                
                if len(boxes) == 0:
                    continue
                
                # Extract detection data
                box_coords = boxes.xyxy.cpu().numpy()
                confidences = boxes.conf.cpu().numpy()
                class_ids = boxes.cls.cpu().numpy()
                class_names = [model.names[int(cid)] for cid in class_ids]
                
                # Process detections for this frame
                frame_detections = tracker.process_detection(
                    boxes=box_coords,
                    confidences=confidences,
                    class_ids=class_ids,
                    class_names=class_names,
                    frame_idx=frame_idx
                )
                
                # Accumulate detections
                tracker.accumulate_detections(frame_detections)
                
                # Store for response
                for _, det in frame_detections.iterrows():
                    all_detections.append({
                        'frame': frame_idx,
                        'class': det['class'],
                        'confidence': float(det['confidence']),
                        'bbox': [
                            float(det['x'] - det['width']/2),
                            float(det['y'] + det['height']/2),
                            float(det['width']),
                            float(det['height'])
                        ]
                    })
        
        except Exception as e:
            logger.error(f"Error processing frame {frame_idx}: {e}")
            continue
    
    # Perform vehicle tracking
    logger.info("🔍 Tracking vehicles across frames...")
    tracks = tracker.track_vehicles()
    
    # Detect accidents based on tracking
    logger.info("⚠️ Analyzing for accident patterns...")
    accident_result = tracker.detect_accidents()
    
    # Get statistics
    stats = tracker.get_statistics()
    
    logger.info(
        f"📊 Results: Accident={accident_result['has_accident']}, "
        f"Confidence={accident_result['confidence']:.2f}, "
        f"Tracks={len(tracks)}, "
        f"Detections={len(all_detections)}"
    )
    
    return {
        'hasAccident': accident_result['has_accident'],
        'confidence': accident_result['confidence'],
        'detectedObjects': all_detections,
        'accidentFrames': len(accident_result['suspicious_frames']),
        'totalFrames': len(frames),
        'accidentRatio': accident_result['accident_frame_ratio'],
        'vehicleTracks': len(tracks),
        'suspiciousFrames': accident_result['suspicious_frames'],
        'accidentIndicators': accident_result['accident_indicators'],
        'statistics': stats
    }


async def process_video(data: VideoProcessRequest):
    """Process video with vehicle tracking"""
    local_video_path = None
    
    try:
        logger.info(f"🎬 Processing video: {data.videoId}")
        
        with get_db_connection() as conn:
            cur = conn.cursor(cursor_factory=RealDictCursor)
            
            try:
                # Update status
                cur.execute("""
                    UPDATE videos 
                    SET status = 'processing', processing_started_at = NOW()
                    WHERE id = %s
                """, (data.videoId,))
                conn.commit()
                
                # Download video
                local_video_path = f"/tmp/video_{data.videoId}.mp4"
                if not download_video_from_gcs(data.filePath, local_video_path):
                    raise Exception("Failed to download video")
                
                # Extract frames
                frames = extract_frames(
                    local_video_path,
                    interval=int(os.getenv('AI_FRAME_INTERVAL', 2))
                )
                if not frames:
                    raise Exception("No frames extracted")
                
                # AI detection with tracking
                detection_result = detect_accident_with_tracking(frames)
                
                logger.info(
                    f"🤖 AI Result: Accident={detection_result['hasAccident']}, "
                    f"Confidence={detection_result['confidence']:.2f}, "
                    f"Tracks={detection_result['vehicleTracks']}"
                )
                
                # Save AI detection
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
                    json.dumps({
                        'detections': detection_result['detectedObjects'],
                        'tracks': detection_result['vehicleTracks'],
                        'suspicious_frames': detection_result['suspiciousFrames'],
                        'indicators': detection_result['accidentIndicators'],
                        'statistics': detection_result['statistics']
                    }),
                    'completed'
                ))
                
                detection_id = cur.fetchone()['id']
                
                # Update video status
                cur.execute("""
                    UPDATE videos 
                    SET status = 'completed', processing_completed_at = NOW()
                    WHERE id = %s
                """, (data.videoId,))
                
                # Create accident if detected
                if detection_result['hasAccident']:
                    if detection_result['confidence'] > 0.85:
                        severity = 'severe'
                    elif detection_result['confidence'] > 0.7:
                        severity = 'moderate'
                    else:
                        severity = 'minor'
                    
                    status = 'confirmed' if detection_result['confidence'] > 0.85 else 'reported'
                    
                    description_text = (
                        f"AI илрүүлсэн осол (итгэлцүүр: {detection_result['confidence']:.0%})\n"
                        f"Тээврийн хэрэгслийн хөдөлгөөн: {detection_result['vehicleTracks']}\n"
                        f"Сэжигтэй frame: {len(detection_result['suspiciousFrames'])}"
                    )
                    
                    if data.description:
                        description_text = f"{data.description}\n\n{description_text}"
                    
                    cur.execute("""
                        INSERT INTO accidents (
                            user_id, latitude, longitude, description,
                            severity, status, source, video_id, accident_time,
                            verification_count
                        )
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, NOW(), 1)
                        RETURNING id
                    """, (
                        data.userId,
                        data.latitude,
                        data.longitude,
                        description_text,
                        severity,
                        status,
                        'user' if data.userId else 'camera',
                        data.videoId
                    ))
                    
                    accident_id = cur.fetchone()['id']
                    logger.info(f"✅ Accident created: accident_id={accident_id}")
                
                conn.commit()
                logger.info(f"✅ Video processing complete: {data.videoId}")
                
            except Exception as e:
                conn.rollback()
                raise e
                
    except Exception as e:
        logger.error(f"❌ Error: {e}")
        
        try:
            with get_db_connection() as conn:
                cur = conn.cursor()
                cur.execute("""
                    UPDATE videos 
                    SET status = 'failed', error_message = %s
                    WHERE id = %s
                """, (str(e), data.videoId))
                conn.commit()
        except Exception as db_error:
            logger.error(f"Failed to update status: {db_error}")
    
    finally:
        if local_video_path and os.path.exists(local_video_path):
            try:
                os.remove(local_video_path)
            except Exception:
                pass


def callback(message):
    """Pub/Sub message handler"""
    try:
        data_dict = json.loads(message.data.decode('utf-8'))
        data = VideoProcessRequest(**data_dict)
        
        asyncio.run(process_video(data))
        
        message.ack()
        logger.info(f"✅ Message processed: {data.videoId}")
        
    except Exception as e:
        logger.error(f"❌ Callback error: {e}")
        message.nack()


@app.on_event("startup")
async def startup_event():
    logger.info("🚀 AI Detection Service started")
    logger.info("📝 Credits: Vehicle tracking algorithm by datafan07 (Kaggle)")
    
    create_db_pool()
    
    logger.info(f"📡 Pub/Sub: {subscription_path}")
    streaming_pull_future = subscriber.subscribe(
        subscription_path,
        callback=callback
    )
    logger.info("👂 Pub/Sub listener active")


@app.on_event("shutdown")
async def shutdown_event():
    logger.info("🛑 Shutting down")
    if db_pool:
        db_pool.closeall()


@app.post("/process", response_model=DetectionResult)
async def process_video_endpoint(
    request: VideoProcessRequest,
    background_tasks: BackgroundTasks
):
    """Manual video processing"""
    background_tasks.add_task(process_video, request)
    return {
        "message": "Processing started",
        "videoId": request.videoId
    }


@app.get("/health")
async def health_check():
    health = {
        "status": "healthy",
        "service": "ai-detection-service",
        "model": MODEL_PATH,
        "algorithm": "YOLOv8 + Vehicle Tracking (datafan07)",
        "timestamp": datetime.now().isoformat()
    }
    
    try:
        with get_db_connection() as conn:
            cur = conn.cursor()
            cur.execute("SELECT 1")
            health["database"] = "connected"
    except Exception as e:
        health["database"] = "disconnected"
        health["status"] = "unhealthy"
    
    return health


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=int(os.getenv('PORT', 3004)),
        log_level="info"
    )