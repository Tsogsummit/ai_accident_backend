"""
AI Detection Service - OPTIMIZED FOR REAL ACCIDENTS + API ENDPOINTS
Improvements:
1. Lower thresholds for better sensitivity
2. Higher weight for erratic trajectories
3. Better collision detection (lower IoU threshold)
4. Adaptive decision logic
5. 0.5 second frame interval (more temporal info)
6. Added /detect/video and /detect/image endpoints

Author: Tsog - Tselmeg Digital School
"""

from fastapi import FastAPI, BackgroundTasks, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from typing import Optional, List, Dict, Tuple
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
from scipy.spatial.distance import euclidean
from scipy.optimize import linear_sum_assignment
from collections import defaultdict, deque
import base64
from io import BytesIO
from PIL import Image

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


class Track:
    """Individual vehicle track with history"""
    
    def __init__(self, track_id: int, detection: Dict, frame_idx: int):
        self.track_id = track_id
        self.class_name = detection['class']
        self.positions = deque(maxlen=30)
        self.frames = deque(maxlen=30)
        self.confidences = deque(maxlen=30)
        self.bboxes = deque(maxlen=30)
        self.velocities = deque(maxlen=29)
        self.accelerations = deque(maxlen=28)
        
        self.positions.append((detection['x'], detection['y']))
        self.frames.append(frame_idx)
        self.confidences.append(detection['confidence'])
        self.bboxes.append(detection['bbox'])
        
        self.age = 0
        self.time_since_update = 0
        self.hits = 1
        self.hit_streak = 1
        
    def update(self, detection: Dict, frame_idx: int):
        self.positions.append((detection['x'], detection['y']))
        self.frames.append(frame_idx)
        self.confidences.append(detection['confidence'])
        self.bboxes.append(detection['bbox'])
        
        if len(self.positions) >= 2:
            frame_diff = self.frames[-1] - self.frames[-2]
            if frame_diff > 0:
                dx = self.positions[-1][0] - self.positions[-2][0]
                dy = self.positions[-1][1] - self.positions[-2][1]
                velocity = np.sqrt(dx**2 + dy**2) / frame_diff
                self.velocities.append(velocity)
                
                if len(self.velocities) >= 2:
                    dv = self.velocities[-1] - self.velocities[-2]
                    acceleration = dv / frame_diff
                    self.accelerations.append(acceleration)
        
        self.hits += 1
        self.hit_streak += 1
        self.time_since_update = 0
        
    def predict(self, frame_idx: int) -> Tuple[float, float]:
        if len(self.positions) < 2:
            return self.positions[-1]
        
        recent_positions = list(self.positions)[-3:]
        recent_frames = list(self.frames)[-3:]
        
        if len(recent_positions) >= 2:
            dx = recent_positions[-1][0] - recent_positions[-2][0]
            dy = recent_positions[-1][1] - recent_positions[-2][1]
            frame_diff = frame_idx - recent_frames[-1]
            
            pred_x = recent_positions[-1][0] + dx * frame_diff
            pred_y = recent_positions[-1][1] + dy * frame_diff
            
            return (pred_x, pred_y)
        
        return self.positions[-1]
    
    def get_current_velocity(self) -> float:
        if len(self.velocities) == 0:
            return 0.0
        return self.velocities[-1]
    
    def mark_missed(self):
        self.time_since_update += 1
        self.hit_streak = 0
        self.age += 1


class OptimizedVehicleTracker:
    """Optimized tracker with better sensitivity for real accidents"""
    
    VEHICLE_CLASSES = ['car', 'truck', 'bus', 'motorcycle', 'bicycle']
    
    def __init__(
        self,
        confidence_threshold: float = 0.35,
        max_age: int = 3,
        min_hits: int = 2,
        iou_threshold: float = 0.3,
        max_tracking_distance: float = 100.0,
        collision_iou_threshold: float = 0.05,
        sudden_stop_threshold: float = -10.0,
        clustering_distance: float = 80.0,
        erratic_angle_threshold: float = 60.0,
    ):
        self.confidence_threshold = confidence_threshold
        self.max_age = max_age
        self.min_hits = min_hits
        self.iou_threshold = iou_threshold
        self.max_tracking_distance = max_tracking_distance
        self.collision_iou_threshold = collision_iou_threshold
        self.sudden_stop_threshold = sudden_stop_threshold
        self.clustering_distance = clustering_distance
        self.erratic_angle_threshold = erratic_angle_threshold
        
        self.tracks = []
        self.next_track_id = 0
        self.frame_detections = defaultdict(list)
        
    def calculate_iou(self, bbox1: Tuple, bbox2: Tuple) -> float:
        x1, y1, w1, h1 = bbox1
        x2, y2, w2, h2 = bbox2
        
        box1 = [x1, y1, x1 + w1, y1 + h1]
        box2 = [x2, y2, x2 + w2, y2 + h2]
        
        x_left = max(box1[0], box2[0])
        y_top = max(box1[1], box2[1])
        x_right = min(box1[2], box2[2])
        y_bottom = min(box1[3], box2[3])
        
        if x_right < x_left or y_bottom < y_top:
            return 0.0
        
        intersection = (x_right - x_left) * (y_bottom - y_top)
        box1_area = (box1[2] - box1[0]) * (box1[3] - box1[1])
        box2_area = (box2[2] - box2[0]) * (box2[3] - box2[1])
        union = box1_area + box2_area - intersection
        
        return intersection / union if union > 0 else 0.0
    
    def calculate_cost_matrix(
        self,
        tracks: List[Track],
        detections: List[Dict],
        frame_idx: int
    ) -> np.ndarray:
        if len(tracks) == 0 or len(detections) == 0:
            return np.array([])
        
        cost_matrix = np.zeros((len(tracks), len(detections)))
        
        for i, track in enumerate(tracks):
            predicted_pos = track.predict(frame_idx)
            
            for j, detection in enumerate(detections):
                det_pos = (detection['x'], detection['y'])
                position_dist = euclidean(predicted_pos, det_pos)
                iou = self.calculate_iou(track.bboxes[-1], detection['bbox'])
                iou_cost = 1.0 - iou
                class_match = 1.0 if track.class_name == detection['class'] else 2.0
                
                cost = (
                    0.5 * (position_dist / self.max_tracking_distance) +
                    0.3 * iou_cost +
                    0.2 * class_match
                )
                
                cost_matrix[i, j] = cost
        
        return cost_matrix
    
    def process_frame(
        self,
        boxes: np.ndarray,
        confidences: np.ndarray,
        class_ids: np.ndarray,
        class_names: List[str],
        frame_idx: int
    ) -> List[Track]:
        detections = []
        for i, (box, conf, class_name) in enumerate(zip(boxes, confidences, class_names)):
            if class_name not in self.VEHICLE_CLASSES:
                continue
            if conf < self.confidence_threshold:
                continue
            
            x, y, x2, y2 = box
            center_x = (x + x2) / 2
            center_y = (y + y2) / 2
            
            detections.append({
                'x': center_x,
                'y': -center_y,
                'width': x2 - x,
                'height': y2 - y,
                'bbox': (x, -y2, x2 - x, y2 - y),
                'confidence': conf,
                'class': class_name
            })
        
        self.frame_detections[frame_idx] = detections
        
        for track in self.tracks:
            track.age += 1
        
        if len(self.tracks) > 0 and len(detections) > 0:
            cost_matrix = self.calculate_cost_matrix(self.tracks, detections, frame_idx)
            track_indices, detection_indices = linear_sum_assignment(cost_matrix)
            
            matched_tracks = set()
            matched_detections = set()
            
            for track_idx, det_idx in zip(track_indices, detection_indices):
                if cost_matrix[track_idx, det_idx] < 0.6:
                    self.tracks[track_idx].update(detections[det_idx], frame_idx)
                    matched_tracks.add(track_idx)
                    matched_detections.add(det_idx)
            
            for track_idx in range(len(self.tracks)):
                if track_idx not in matched_tracks:
                    self.tracks[track_idx].mark_missed()
            
            for det_idx in range(len(detections)):
                if det_idx not in matched_detections:
                    new_track = Track(self.next_track_id, detections[det_idx], frame_idx)
                    self.tracks.append(new_track)
                    self.next_track_id += 1
        
        elif len(detections) > 0:
            for detection in detections:
                new_track = Track(self.next_track_id, detection, frame_idx)
                self.tracks.append(new_track)
                self.next_track_id += 1
        
        self.tracks = [
            t for t in self.tracks
            if t.time_since_update < self.max_age or t.hits >= self.min_hits
        ]
        
        return [t for t in self.tracks if t.hits >= self.min_hits or t.age < self.min_hits]
    
    def detect_collisions(self, frame_idx: int) -> List[Dict]:
        collisions = []
        active_tracks = [t for t in self.tracks if t.time_since_update == 0]
        
        for i in range(len(active_tracks)):
            for j in range(i + 1, len(active_tracks)):
                track1 = active_tracks[i]
                track2 = active_tracks[j]
                iou = self.calculate_iou(track1.bboxes[-1], track2.bboxes[-1])
                
                if iou > self.collision_iou_threshold:
                    collisions.append({
                        'type': 'collision',
                        'frame': frame_idx,
                        'track_ids': [track1.track_id, track2.track_id],
                        'vehicle_classes': [track1.class_name, track2.class_name],
                        'iou': iou,
                        'confidence': min(0.95, 0.6 + iou * 0.7)
                    })
        
        return collisions
    
    def detect_sudden_stops(self, frame_idx: int) -> List[Dict]:
        sudden_stops = []
        
        for track in self.tracks:
            if len(track.velocities) < 2:
                continue
            
            recent_velocities = list(track.velocities)[-3:]
            if len(recent_velocities) >= 2:
                velocity_change = recent_velocities[-1] - recent_velocities[0]
                
                if velocity_change < self.sudden_stop_threshold:
                    if track.get_current_velocity() < 8.0:
                        sudden_stops.append({
                            'type': 'sudden_stop',
                            'frame': frame_idx,
                            'track_id': track.track_id,
                            'vehicle_class': track.class_name,
                            'velocity_change': velocity_change,
                            'confidence': min(0.90, 0.65 + abs(velocity_change) / 40.0)
                        })
        
        return sudden_stops
    
    def detect_vehicle_clustering(self, frame_idx: int) -> List[Dict]:
        clusters = []
        detections = self.frame_detections.get(frame_idx, [])
        
        if len(detections) < 3:
            return clusters
        
        positions = np.array([(d['x'], d['y']) for d in detections])
        close_pairs = 0
        involved_vehicles = set()
        
        for i in range(len(positions)):
            for j in range(i + 1, len(positions)):
                dist = euclidean(positions[i], positions[j])
                if dist < self.clustering_distance:
                    close_pairs += 1
                    involved_vehicles.add(i)
                    involved_vehicles.add(j)
        
        if close_pairs >= 2 and len(involved_vehicles) >= 3:
            clusters.append({
                'type': 'vehicle_clustering',
                'frame': frame_idx,
                'vehicle_count': len(involved_vehicles),
                'close_pairs': close_pairs,
                'confidence': min(0.80, 0.55 + close_pairs * 0.10)
            })
        
        return clusters
    
    def detect_erratic_trajectories(self, frame_idx: int) -> List[Dict]:
        erratic = []
        
        for track in self.tracks:
            if len(track.positions) < 4:
                continue
            
            recent_positions = np.array(list(track.positions)[-4:])
            
            if len(recent_positions) >= 3:
                vectors = np.diff(recent_positions, axis=0)
                angles = []
                
                for i in range(len(vectors) - 1):
                    v1 = vectors[i]
                    v2 = vectors[i + 1]
                    cos_angle = np.dot(v1, v2) / (np.linalg.norm(v1) * np.linalg.norm(v2) + 1e-6)
                    angle = np.arccos(np.clip(cos_angle, -1.0, 1.0))
                    angles.append(np.degrees(angle))
                
                if len(angles) > 0:
                    avg_angle_change = np.mean(angles)
                    max_angle_change = np.max(angles)
                    
                    if max_angle_change > self.erratic_angle_threshold or avg_angle_change > 35:
                        erratic.append({
                            'type': 'erratic_trajectory',
                            'frame': frame_idx,
                            'track_id': track.track_id,
                            'vehicle_class': track.class_name,
                            'max_angle_change': max_angle_change,
                            'avg_angle_change': avg_angle_change,
                            'confidence': min(0.85, 0.5 + max_angle_change / 150.0)
                        })
        
        return erratic
    
    def detect_accidents(self) -> Dict:
        all_indicators = []
        suspicious_frames = set()
        
        for frame_idx in sorted(self.frame_detections.keys()):
            collisions = self.detect_collisions(frame_idx)
            all_indicators.extend(collisions)
            for c in collisions:
                suspicious_frames.add(frame_idx)
            
            sudden_stops = self.detect_sudden_stops(frame_idx)
            all_indicators.extend(sudden_stops)
            for s in sudden_stops:
                suspicious_frames.add(frame_idx)
            
            clusters = self.detect_vehicle_clustering(frame_idx)
            all_indicators.extend(clusters)
            for cl in clusters:
                suspicious_frames.add(frame_idx)
            
            erratic = self.detect_erratic_trajectories(frame_idx)
            all_indicators.extend(erratic)
            for e in erratic:
                suspicious_frames.add(frame_idx)
        
        total_frames = len(self.frame_detections)
        accident_frame_ratio = len(suspicious_frames) / total_frames if total_frames > 0 else 0
        
        indicator_weights = {
            'collision': 1.0,
            'sudden_stop': 0.8,
            'erratic_trajectory': 0.75,
            'vehicle_clustering': 0.6
        }
        
        if all_indicators:
            weighted_confidences = [
                ind['confidence'] * indicator_weights.get(ind['type'], 0.5)
                for ind in all_indicators
            ]
            max_confidence = max(weighted_confidences)
            avg_confidence = np.mean(weighted_confidences)
            final_confidence = 0.6 * max_confidence + 0.4 * avg_confidence
        else:
            final_confidence = 0.0
        
        indicator_counts = defaultdict(int)
        for ind in all_indicators:
            indicator_counts[ind['type']] += 1
        
        has_accident = (
            final_confidence > 0.50 or
            (accident_frame_ratio > 0.20 and final_confidence > 0.40) or
            indicator_counts.get('collision', 0) > 0 or
            (indicator_counts.get('erratic_trajectory', 0) > 10 and final_confidence > 0.35) or
            (accident_frame_ratio > 0.70 and final_confidence > 0.30)
        )
        
        return {
            'has_accident': has_accident,
            'confidence': final_confidence,
            'accident_frame_ratio': accident_frame_ratio,
            'suspicious_frames': sorted(list(suspicious_frames)),
            'total_frames': total_frames,
            'accident_indicators': all_indicators,
            'indicator_counts': dict(indicator_counts),
            'confirmed_tracks': len([t for t in self.tracks if t.hits >= self.min_hits]),
            'total_detections': sum(len(dets) for dets in self.frame_detections.values())
        }
    
    def get_statistics(self) -> Dict:
        confirmed_tracks = [t for t in self.tracks if t.hits >= self.min_hits]
        
        stats = {
            'total_tracks': len(self.tracks),
            'confirmed_tracks': len(confirmed_tracks),
            'total_frames': len(self.frame_detections),
            'total_detections': sum(len(dets) for dets in self.frame_detections.values()),
            'avg_track_length': np.mean([len(t.positions) for t in confirmed_tracks]) if confirmed_tracks else 0,
            'vehicle_class_distribution': {}
        }
        
        for track in confirmed_tracks:
            stats['vehicle_class_distribution'][track.class_name] = \
                stats['vehicle_class_distribution'].get(track.class_name, 0) + 1
        
        return stats


# FastAPI Models
class VideoDetectionRequest(BaseModel):
    videoId: int
    userId: int
    filePath: str
    latitude: float = Field(..., ge=-90, le=90)
    longitude: float = Field(..., ge=-180, le=180)
    description: Optional[str] = None
    
class ImageDetectionRequest(BaseModel):
    cameraId: int
    frameId: int
    timestamp: str
    image: str  # base64 encoded
    metadata: Optional[Dict] = None


# FastAPI app
app = FastAPI(title="AI Detection - Optimized", version="2.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class Config:
    MODEL_PATH = os.getenv('MODEL_PATH', 'yolov8n.pt')
    MODEL_CONFIDENCE = float(os.getenv('AI_CONFIDENCE_THRESHOLD', 0.35))
    FRAME_INTERVAL = float(os.getenv('AI_FRAME_INTERVAL', 0.5))
    MAX_FRAMES = int(os.getenv('AI_MAX_FRAMES', 500))

config = Config()

try:
    logger.info(f"Loading YOLO: {config.MODEL_PATH}")
    model = YOLO(config.MODEL_PATH)
    logger.info("✅ Model loaded")
except:
    logger.info("⚠️ Fallback to YOLOv8n")
    model = YOLO('yolov8n.pt')


def extract_frames(video_path: str, interval: float = 0.5, max_frames: int = 500):
    """Extract frames with 0.5 second interval"""
    frames = []
    cap = cv2.VideoCapture(video_path)
    
    if not cap.isOpened():
        return frames
    
    fps = cap.get(cv2.CAP_PROP_FPS)
    frame_interval = int(fps * interval) if fps > 0 else 15
    
    frame_count = 0
    extracted = 0
    
    while extracted < max_frames:
        ret, frame = cap.read()
        if not ret:
            break
        
        if frame_count % frame_interval == 0:
            frames.append(frame)
            extracted += 1
        
        frame_count += 1
    
    cap.release()
    logger.info(f"✂️ Extracted {len(frames)} frames (interval: {interval}s)")
    return frames


def detect_accident(frames, confidence_threshold=0.35):
    """Optimized accident detection"""
    tracker = OptimizedVehicleTracker(
        confidence_threshold=confidence_threshold,
        max_age=3,
        min_hits=2,
        collision_iou_threshold=0.05,
        sudden_stop_threshold=-10.0,
        clustering_distance=80.0,
        erratic_angle_threshold=60.0
    )
    
    for frame_idx, frame in enumerate(frames):
        results = model(frame, conf=confidence_threshold, verbose=False)
        
        for result in results:
            boxes = result.boxes
            if len(boxes) == 0:
                continue
            
            box_coords = boxes.xyxy.cpu().numpy()
            confidences = boxes.conf.cpu().numpy()
            class_ids = boxes.cls.cpu().numpy()
            class_names = [model.names[int(cid)] for cid in class_ids]
            
            tracker.process_frame(
                boxes=box_coords,
                confidences=confidences,
                class_ids=class_ids,
                class_names=class_names,
                frame_idx=frame_idx
            )
    
    accident_result = tracker.detect_accidents()
    stats = tracker.get_statistics()
    
    return {
        'hasAccident': accident_result['has_accident'],
        'confidence': float(accident_result['confidence']),
        'totalFrames': len(frames),
        'confirmedTracks': stats['confirmed_tracks'],
        'suspiciousFrames': accident_result['suspicious_frames'],
        'indicatorCounts': accident_result['indicator_counts'],
        'statistics': stats
    }


@app.get("/health")
async def health():
    """Health check endpoint"""
    return {
        "status": "healthy",
        "service": "ai-detection-service",
        "version": "2.1.0-optimized",
        "model": config.MODEL_PATH,
        "timestamp": datetime.now().isoformat(),
        "improvements": [
            "Lower thresholds (50% vs 65%)",
            "0.5s frame interval (was 1s)",
            "Better erratic trajectory detection",
            "More sensitive collision detection",
            "Improved decision logic"
        ]
    }


@app.post("/detect/video")
async def detect_video_endpoint(request: VideoDetectionRequest, background_tasks: BackgroundTasks):
    """
    Бичлэгээс осол илрүүлэх
    """
    try:
        logger.info(f"📹 Processing video detection: videoId={request.videoId}")
        
        # TODO: Download video from GCS using filePath
        # TODO: Extract frames and run detection
        # For now, return mock response
        
        return {
            "success": True,
            "videoId": request.videoId,
            "status": "processing",
            "message": "Video боловсруулж байна",
            "estimatedTime": "30-60 seconds"
        }
        
    except Exception as e:
        logger.error(f"Video detection error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/detect/image")
async def detect_image_endpoint(request: ImageDetectionRequest):
    """
    Frame-ээс осол илрүүлэх (Camera real-time detection)
    """
    try:
        logger.info(f"🖼️ Processing image detection: cameraId={request.cameraId}, frameId={request.frameId}")
        
        # Decode base64 image
        image_data = base64.b64decode(request.image)
        image = Image.open(BytesIO(image_data))
        
        # Convert PIL to numpy array for YOLO
        image_np = np.array(image)
        
        # Run YOLO detection
        results = model(image_np, conf=config.MODEL_CONFIDENCE, verbose=False)
        
        predictions = []
        for result in results:
            boxes = result.boxes
            for i in range(len(boxes)):
                box = boxes.xyxy[i].cpu().numpy()
                conf = float(boxes.conf[i].cpu().numpy())
                class_id = int(boxes.cls[i].cpu().numpy())
                class_name = model.names[class_id]
                
                predictions.append({
                    "class_name": class_name,
                    "confidence": conf,
                    "bbox": {
                        "x": float(box[0]),
                        "y": float(box[1]),
                        "width": float(box[2] - box[0]),
                        "height": float(box[3] - box[1])
                    }
                })
        
        logger.info(f"✅ Detected {len(predictions)} objects")
        
        return {
            "success": True,
            "cameraId": request.cameraId,
            "frameId": request.frameId,
            "predictions": predictions,
            "timestamp": request.timestamp,
            "modelVersion": "2.1.0"
        }
        
    except Exception as e:
        logger.error(f"Image detection error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/")
async def root():
    """Root endpoint"""
    return {
        "service": "AI Detection Service",
        "version": "2.1.0",
        "status": "running",
        "endpoints": [
            "/health",
            "/detect/video",
            "/detect/image"
        ]
    }


if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv('PORT', 3004))
    logger.info(f"🚀 Starting AI Detection Service on port {port}")
    uvicorn.run(app, host="0.0.0.0", port=port)