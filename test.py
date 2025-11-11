"""
AI Detection Service - Local Test Script
Бичлэгийг локал файлаас шууд тест хийх
YouTube URL-ээс шууд тест хийх боломжтой
"""
import cv2
import numpy as np
from ultralytics import YOLO
import json
from datetime import datetime
import os
import tempfile
import re

# YOLOv8 модель ачаалах
MODEL_PATH = 'models/yolov8n.pt'  # or your model path
model = YOLO(MODEL_PATH)

def is_youtube_url(url: str) -> bool:
    """YouTube URL эсэхийг шалгах"""
    youtube_regex = r'(https?://)?(www\.)?(youtube|youtu|youtube-nocookie)\.(com|be)/'
    return bool(re.match(youtube_regex, url))

def download_youtube_video(url: str) -> str:
    """YouTube-аас видео татах"""
    try:
        import yt_dlp
        
        print(f"📥 YouTube видео татаж байна...")
        print(f"URL: {url}")
        
        # Түр зуурын файл үүсгэх
        temp_dir = tempfile.gettempdir()
        output_template = os.path.join(temp_dir, 'youtube_video_%(id)s.%(ext)s')
        
        ydl_opts = {
            'format': 'best[ext=mp4]/best',
            'outtmpl': output_template,
            'quiet': False,
            'no_warnings': False,
        }
        
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
            video_path = ydl.prepare_filename(info)
            
        print(f"✅ Видео амжилттай татагдлаа: {video_path}")
        return video_path
        
    except ImportError:
        print("❌ yt-dlp суулгаагүй байна!")
        print("Суулгах: pip install yt-dlp")
        return None
    except Exception as e:
        print(f"❌ Видео татахад алдаа гарлаа: {e}")
        return None

def extract_frames(video_path: str, interval: int = 2):
    """Бичлэгээс frame-үүд салгах"""
    frames = []
    cap = cv2.VideoCapture(video_path)
    
    if not cap.isOpened():
        print(f"❌ Видео нээж чадсангүй: {video_path}")
        return frames
    
    fps = cap.get(cv2.CAP_PROP_FPS)
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    frame_interval = int(fps * interval) if fps > 0 else 30
    
    print(f"📊 FPS: {fps}, Total frames: {total_frames}, Interval: {frame_interval}")
    
    frame_count = 0
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        
        if frame_count % frame_interval == 0:
            frames.append(frame)
        
        frame_count += 1
    
    cap.release()
    print(f"✂️  Салгасан frame: {len(frames)} / {total_frames}")
    return frames

def detect_accident(frames, confidence_threshold: float = 0.5):
    """YOLOv8 ашиглан осол илрүүлэх"""
    accident_keywords = [
        'car', 'truck', 'bus', 'motorcycle', 
        'person', 'bicycle'
    ]
    
    all_detections = []
    accident_frames = 0
    max_confidence = 0.0
    
    print(f"\n🤖 AI илрүүлэлт эхэллээ...")
    print(f"{'Frame':<8} {'Object':<15} {'Confidence':<12} {'Status'}")
    print("-" * 60)
    
    for idx, frame in enumerate(frames):
        try:
            results = model(frame, conf=confidence_threshold, verbose=False)
            
            frame_has_accident_indicators = False
            
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
                        frame_has_accident_indicators = True
                        
                        status = "⚠️  ACCIDENT" if confidence > 0.6 else "⚡ DETECTED"
                        print(f"{idx:<8} {class_name:<15} {confidence:<12.2%} {status}")
            
            if frame_has_accident_indicators:
                accident_frames += 1
                
        except Exception as e:
            print(f"❌ Frame {idx} алдаа: {e}")
            continue
    
    # Үр дүн тооцоолох
    total_frames = len(frames)
    accident_ratio = (accident_frames / total_frames) if total_frames > 0 else 0
    has_accident = accident_ratio > 0.3 and max_confidence > 0.6
    
    print("\n" + "=" * 60)
    print("📊 ДҮГНЭЛТ:")
    print("=" * 60)
    print(f"Нийт frame:           {total_frames}")
    print(f"Ослын тэмдэг илэрсэн: {accident_frames} ({accident_ratio:.1%})")
    print(f"Хамгийн өндөр итгэлцүүр: {max_confidence:.1%}")
    print(f"Осол байгаа эсэх:    {'✅ ТИЙМ' if has_accident else '❌ ҮГҮЙ'}")
    
    if has_accident:
        if max_confidence > 0.85:
            severity = 'ХҮНД (Severe)'
        elif max_confidence > 0.7:
            severity = 'ДУНД (Moderate)'
        else:
            severity = 'ХӨНГӨН (Minor)'
        print(f"Ноцтой байдал:       {severity}")
    
    return {
        'hasAccident': has_accident,
        'confidence': max_confidence,
        'detectedObjects': all_detections,
        'accidentFrames': accident_frames,
        'totalFrames': total_frames,
        'accidentRatio': accident_ratio
    }

def test_video(video_path: str, output_json: str = None):
    """Видео тест хийх (локал файл эсвэл YouTube URL)"""
    print("=" * 60)
    print("🎬 AI DETECTION SERVICE - LOCAL TEST")
    print("=" * 60)
    
    # YouTube URL эсэхийг шалгах
    is_youtube = is_youtube_url(video_path)
    temp_video_path = None
    
    if is_youtube:
        print(f"🌐 YouTube URL илэрлээ")
        print(f"URL: {video_path}")
        
        # YouTube-аас видео татах
        temp_video_path = download_youtube_video(video_path)
        if not temp_video_path:
            print("❌ YouTube видео татаж чадсангүй!")
            return None
        
        video_path = temp_video_path
    else:
        print(f"📁 Локал файл: {video_path}")
    
    print(f"Модель: {MODEL_PATH}")
    print(f"Огноо: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print("=" * 60 + "\n")
    
    # 1. Frame-үүд салгах
    print("⏳ Frame-үүд салгаж байна...")
    frames = extract_frames(video_path, interval=2)
    
    if not frames:
        print("❌ Frame салгаж чадсангүй!")
        # Түр файл устгах
        if temp_video_path and os.path.exists(temp_video_path):
            try:
                os.remove(temp_video_path)
                print(f"🗑️  Түр файл устгалаа: {temp_video_path}")
            except:
                pass
        return None
    
    # 2. AI илрүүлэлт
    result = detect_accident(frames, confidence_threshold=0.5)
    
    # 3. Үр дүнг хадгалах
    if output_json:
        with open(output_json, 'w', encoding='utf-8') as f:
            json.dump(result, f, ensure_ascii=False, indent=2)
        print(f"\n💾 Үр дүн хадгалагдлаа: {output_json}")
    
    # 4. Түр файл устгах
    if temp_video_path and os.path.exists(temp_video_path):
        try:
            os.remove(temp_video_path)
            print(f"🗑️  Түр файл устгалаа: {temp_video_path}")
        except Exception as e:
            print(f"⚠️  Түр файл устгаж чадсангүй: {e}")
    
    return result

if __name__ == "__main__":
    import sys
    
    # Default video path
    DEFAULT_VIDEO_PATH = '/Users/tsogboldbaatar/Desktop/test.mp4'
    
    if len(sys.argv) < 2:
        print("⚙️  Default видео ашиглаж байна...")
        print(f"📁 {DEFAULT_VIDEO_PATH}\n")
        video_path = DEFAULT_VIDEO_PATH
        output_json = None
    else:
        video_path = sys.argv[1]
        output_json = sys.argv[2] if len(sys.argv) > 2 else None
    
    print("\n📖 ХЭРЭГЛЭЭ:")
    print("-" * 60)
    print("1. Default видео:     python test_ai_service.py")
    print("2. Локал файл:        python test_ai_service.py video.mp4")
    print("3. YouTube URL:       python test_ai_service.py https://youtube.com/watch?v=...")
    print("4. Үр дүн хадгалах:   python test_ai_service.py video.mp4 result.json")
    print("-" * 60 + "\n")
    
    result = test_video(video_path, output_json)
    
    if result:
        print("\n✅ Тест амжилттай дууслаа!")
    else:
        print("\n❌ Тест амжилтгүй боллоо!")