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
import requests
import torch
import torch.nn as nn
from torchvision import transforms, models

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

class Track:
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
    VEHICLE_CLASSES = ['car', 'truck', 'bus', 'motorcycle', 'bicycle', 'person']

    def __init__(
        self,
        confidence_threshold: float = 0.30,
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

    def detect_post_accident_scene(self, frame_idx: int) -> List[Dict]:
        """
        Detects 'Accident Already Made' scenarios:
        1. Stationary vehicles (not moving for a while).
        2. People standing near stationary vehicles.
        """
        post_accident_indicators = []
        
        # 1. Identify stationary vehicles
        stationary_vehicles = []
        for track in self.tracks:
            if track.class_name in ['person']:
                continue
                
            # Check if vehicle has been tracked for a while but has low velocity
            if track.age > 10 and track.get_current_velocity() < 2.0:
                stationary_vehicles.append(track)

        # 2. Identify people near stationary vehicles
        people_tracks = [t for t in self.tracks if t.class_name == 'person']
        
        if len(stationary_vehicles) >= 1:
            # Check for clustering of stationary vehicles (e.g. pileup)
            if len(stationary_vehicles) >= 2:
                positions = np.array([t.positions[-1] for t in stationary_vehicles])
                for i in range(len(positions)):
                    for j in range(i + 1, len(positions)):
                        dist = euclidean(positions[i], positions[j])
                        if dist < self.clustering_distance:
                            post_accident_indicators.append({
                                'type': 'stationary_vehicle_cluster',
                                'frame': frame_idx,
                                'vehicle_count': len(stationary_vehicles),
                                'confidence': 0.65
                            })
                            break

            # Check for people near these stationary vehicles
            for vehicle in stationary_vehicles:
                people_nearby = 0
                v_pos = vehicle.positions[-1]
                for person in people_tracks:
                    p_pos = person.positions[-1]
                    dist = euclidean(v_pos, p_pos)
                    if dist < 50.0: # 50 pixels radius
                        people_nearby += 1
                
                if people_nearby > 0:
                     post_accident_indicators.append({
                        'type': 'people_at_scene',
                        'frame': frame_idx,
                        'vehicle_id': vehicle.track_id,
                        'people_count': people_nearby,
                        'confidence': min(0.90, 0.60 + people_nearby * 0.10)
                    })

        return post_accident_indicators

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
            
            # NEW: Post-accident detection
            post_accident = self.detect_post_accident_scene(frame_idx)
            all_indicators.extend(post_accident)
            for p in post_accident:
                suspicious_frames.add(frame_idx)

        total_frames = len(self.frame_detections)
        accident_frame_ratio = len(suspicious_frames) / total_frames if total_frames > 0 else 0
        indicator_weights = {
            'collision': 1.0,
            'sudden_stop': 0.8,
            'erratic_trajectory': 0.75,
            'vehicle_clustering': 0.6,
            'stationary_vehicle_cluster': 0.7,
            'people_at_scene': 0.85
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
            final_confidence > 0.55 or
            (accident_frame_ratio > 0.25 and final_confidence > 0.45) or
            indicator_counts.get('collision', 0) > 0 or
            (indicator_counts.get('erratic_trajectory', 0) > 8 and final_confidence > 0.40) or
            (accident_frame_ratio > 0.65 and final_confidence > 0.35) or
            (indicator_counts.get('people_at_scene', 0) > 5 and final_confidence > 0.40)
        )

        logger.info(f"📈 Accident analysis: confidence={final_confidence:.2f}, frame_ratio={accident_frame_ratio:.2f}, collisions={indicator_counts.get('collision', 0)}, erratic={indicator_counts.get('erratic_trajectory', 0)}, clustering={indicator_counts.get('vehicle_clustering', 0)}")
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
    image: str
    metadata: Optional[Dict] = None

app = FastAPI(title="AI Detection - Optimized", version="2.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class Config:
    MODEL_PATH = os.getenv('MODEL_PATH', '/app/models/yolov8m.pt')
    MODEL_CONFIDENCE = float(os.getenv('AI_CONFIDENCE_THRESHOLD', 0.30))
    FRAME_INTERVAL = float(os.getenv('AI_FRAME_INTERVAL', 0.5))
    MAX_FRAMES = int(os.getenv('AI_MAX_FRAMES', 500))
    IOU_THRESHOLD = float(os.getenv('AI_IOU_THRESHOLD', 0.45))
    MAX_DET = int(os.getenv('AI_MAX_DETECTIONS', 300))

config = Config()

try:
    logger.info(f"Loading YOLOv8m model: {config.MODEL_PATH}")
    model = YOLO(config.MODEL_PATH)
    logger.info("✅ YOLOv8m model loaded successfully (higher accuracy)")
except Exception as e:
    logger.error(f"Failed to load YOLOv8m: {e}")
    logger.info("⚠️ Fallback to YOLOv8n")
    model = YOLO('yolov8n.pt')

def extract_frames(video_path: str, interval: float = 0.5, max_frames: int = 500):
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

def detect_motion(frames, threshold=5.0):
    """Detect if video has significant motion between frames."""
    if len(frames) < 2:
        return False, 0.0

    motion_scores = []
    for i in range(1, min(len(frames), 10)):  # Check first 10 frames
        prev_gray = cv2.cvtColor(frames[i-1], cv2.COLOR_BGR2GRAY)
        curr_gray = cv2.cvtColor(frames[i], cv2.COLOR_BGR2GRAY)

        # Calculate frame difference
        diff = cv2.absdiff(prev_gray, curr_gray)
        motion_score = np.mean(diff)
        motion_scores.append(motion_score)

    avg_motion = np.mean(motion_scores) if motion_scores else 0
    has_motion = avg_motion > threshold

    return has_motion, avg_motion

def detect_accident(frames, confidence_threshold=0.30):
    # First, detect if video has motion
    has_motion, motion_score = detect_motion(frames)
    logger.info(f"🎬 Motion detection: has_motion={has_motion}, score={motion_score:.2f}")

    # Initialize YOLO tracker for vehicle detection (Used for BOTH static and dynamic now)
    tracker = OptimizedVehicleTracker(
        confidence_threshold=confidence_threshold,
        max_age=3,
        min_hits=2,
        collision_iou_threshold=0.05,
        sudden_stop_threshold=-10.0,
        clustering_distance=80.0,
        erratic_angle_threshold=60.0
    )

    total_detections = 0
    vehicle_detections = 0

    for frame_idx, frame in enumerate(frames):
        # Run YOLO detection for vehicle tracking
        results = model(
            frame,
            conf=confidence_threshold,
            iou=config.IOU_THRESHOLD,
            max_det=config.MAX_DET,
            verbose=False
        )
        for result in results:
            boxes = result.boxes
            if len(boxes) == 0:
                continue
            box_coords = boxes.xyxy.cpu().numpy()
            confidences = boxes.conf.cpu().numpy()
            class_ids = boxes.cls.cpu().numpy()
            class_names = [model.names[int(cid)] for cid in class_ids]

            total_detections += len(class_names)
            vehicles = [c for c in class_names if c in ['car', 'truck', 'bus', 'motorcycle', 'bicycle', 'person']]
            vehicle_detections += len(vehicles)

            if frame_idx == 0:
                logger.info(f"🔍 Frame 0 detections: {class_names}")

            tracker.process_frame(
                boxes=box_coords,
                confidences=confidences,
                class_ids=class_ids,
                class_names=class_names,
                frame_idx=frame_idx
            )

    logger.info(f"📊 Total detections: {total_detections}, Vehicles: {vehicle_detections}")

    # Get YOLO tracker results
    yolo_result = tracker.detect_accidents()
    stats = tracker.get_statistics()

    # YOLO only (no classifier)
    return {
        'hasAccident': yolo_result['has_accident'],
        'confidence': float(yolo_result['confidence']),
        'totalFrames': len(frames),
        'confirmedTracks': stats['confirmed_tracks'],
        'suspiciousFrames': yolo_result['suspicious_frames'],
        'indicatorCounts': yolo_result['indicator_counts'],
        'statistics': stats
    }

def notify_users_about_accident(accident_id: int, latitude: float, longitude: float, 
                                 description: str, confidence: float):
    try:
        accident_service_url = os.getenv('ACCIDENT_SERVICE_URL', 'http://accident-service:3002')
        response = requests.post(
            f"{accident_service_url}/accidents/{accident_id}/notify",
            json={
                'radiusMeters': 5000
            },
            timeout=10
        )
        if response.status_code == 200:
            result = response.json()
            logger.info(f"✅ Accident service notified nearby users: {result.get('message', '')}")
        else:
            logger.warning(f"⚠️ Accident service returned {response.status_code}: {response.text}")
    except Exception as e:
        logger.error(f"❌ Error calling accident service: {e}", exc_info=True)

async def process_video_detection(request: VideoDetectionRequest, video_path: str):
    db_conn = None
    try:
        logger.info(f"🎬 Starting video processing: videoId={request.videoId}, filePath={request.filePath}")
        if not video_path or not os.path.exists(video_path):
            logger.warning(f"Video path not provided or doesn't exist, searching...")
            original_path = request.filePath
            paths_to_try = [
                original_path,
                os.path.join('/app', 'uploads', os.path.basename(original_path)),
                os.path.join('/app/uploads', original_path),
                os.path.join('/app/uploads', os.path.basename(original_path)),
                os.path.join('/app', 'uploads', original_path),
            ]
            video_path = None
            for test_path in paths_to_try:
                if os.path.exists(test_path) and os.path.isfile(test_path):
                    video_path = test_path
                    logger.info(f"✅ Found video at: {video_path}")
                    break
        if not video_path or not os.path.exists(video_path):
            error_msg = f"Video file not found: {request.filePath}. Tried multiple paths."
            logger.error(f"❌ {error_msg}")
            raise Exception(error_msg)
        logger.info(f"📹 Extracting frames from: {video_path}")
        frames = extract_frames(video_path, config.FRAME_INTERVAL, config.MAX_FRAMES)
        if len(frames) == 0:
            logger.warning(f"No frames extracted from video: {video_path}")
            raise Exception("Could not extract frames from video")
        logger.info(f"📊 Extracted {len(frames)} frames, running detection...")
        detection_result = detect_accident(frames, config.MODEL_CONFIDENCE)
        has_accident = detection_result['hasAccident']
        confidence = detection_result['confidence']
        logger.info(f"🔍 Detection result: hasAccident={has_accident}, confidence={confidence:.2%}")
        def make_serializable(obj):
            if isinstance(obj, (np.integer, np.int64, np.int32)):
                return int(obj)
            elif isinstance(obj, (np.floating, np.float64, np.float32)):
                return float(obj)
            elif isinstance(obj, np.bool_):
                return bool(obj)
            elif isinstance(obj, np.ndarray):
                return obj.tolist()
            elif isinstance(obj, dict):
                return {k: make_serializable(v) for k, v in obj.items()}
            elif isinstance(obj, (list, tuple)):
                return [make_serializable(item) for item in obj]
            elif isinstance(obj, (set, frozenset)):
                return list(obj)
            else:
                return obj
        detected_objects_data = {
            'hasAccident': bool(has_accident),
            'confidence': float(confidence),
            'totalFrames': int(detection_result.get('totalFrames', 0)),
            'confirmedTracks': int(detection_result.get('confirmedTracks', 0)) if detection_result.get('confirmedTracks') is not None else 0,
            'suspiciousFrames': [int(f) for f in detection_result.get('suspiciousFrames', [])],
            'indicatorCounts': make_serializable(detection_result.get('indicatorCounts', {})),
            'statistics': make_serializable(detection_result.get('statistics', {}))
        }
        detected_objects_json = json.dumps(detected_objects_data)
        db_conn = psycopg2.connect(
            host=os.getenv('DB_HOST', 'localhost'),
            port=os.getenv('DB_PORT', '5432'),
            database=os.getenv('DB_NAME', 'accident_db'),
            user=os.getenv('DB_USER', 'postgres'),
            password=os.getenv('DB_PASSWORD', 'postgres')
        )
        db_conn.autocommit = False
        try:
            cursor = db_conn.cursor()
            video_status = 'completed'
            cursor.execute("""
                UPDATE videos
                SET status = %s,
                    processing_completed_at = NOW()
                WHERE id = %s
            """, (video_status, request.videoId))

            cursor.execute("""
                INSERT INTO ai_detections (
                    video_id, confidence, detected_objects, status, processed_at
                )
                VALUES (%s, %s, %s, %s, NOW())
            """, (request.videoId, confidence, detected_objects_json, 'completed'))

            if has_accident and confidence >= 0.3:
                cursor.execute("""
                    UPDATE accidents
                    SET status = 'confirmed'
                    WHERE video_id = %s AND status = 'reported'
                    RETURNING id, latitude, longitude, description
                """, (request.videoId,))
                accident_result = cursor.fetchone()
                if accident_result:
                    accident_id = accident_result[0]
                    logger.info(f"✅ Accident {accident_id} confirmed")
                    notify_users_about_accident(accident_id, request.latitude, request.longitude, request.description, confidence)
            else:
                if confidence < 0.3:
                    cursor.execute("""
                        UPDATE accidents
                        SET status = 'false_alarm'
                        WHERE video_id = %s AND status = 'reported'
                    """, (request.videoId,))

            db_conn.commit()
            cursor.close()
            logger.info(f"✅ Video {request.videoId} processing completed")
        except Exception as db_err:
            logger.error(f"❌ Failed to update video status on error: {db_err}", exc_info=True)
        finally:
            if db_conn:
                try:
                    db_conn.close()
                except Exception:
                    pass

        return {
            "status": "success",
            "videoId": request.videoId,
            "hasAccident": has_accident,
            "confidence": float(confidence),
            "detected_objects": detected_objects_data
        }
    except Exception as e:
        logger.error(f"❌ Video processing failed: {str(e)}", exc_info=True)
        if db_conn:
            try:
                cursor = db_conn.cursor()
                cursor.execute("""
                    UPDATE videos
                    SET status = 'failed', error_message = %s
                    WHERE id = %s
                """, (str(e), request.videoId))
                db_conn.commit()
                cursor.close()
                logger.info(f"✅ Updated video {request.videoId} status to 'failed'")
            except Exception as db_err:
                logger.error(f"❌ Failed to update video status on error: {db_err}", exc_info=True)
            finally:
                if db_conn:
                    try:
                        db_conn.close()
                    except Exception:
                        pass
        raise

@app.get("/health")
async def health():
    return {
        "status": "healthy",
        "service": "ai-detection-service",
        "version": "3.0.0-yolov8m",
        "model": "YOLOv8m (Medium - Higher Accuracy)",
        "model_path": config.MODEL_PATH,
        "timestamp": datetime.now().isoformat(),
        "config": {
            "confidence_threshold": config.MODEL_CONFIDENCE,
            "iou_threshold": config.IOU_THRESHOLD,
            "max_detections": config.MAX_DET,
            "frame_interval": config.FRAME_INTERVAL
        },
        "improvements": [
            "YOLOv8m model (better accuracy than nano)",
            "Lower confidence threshold (0.30 vs 0.35)",
            "Optimized IOU threshold (0.45)",
            "Higher max detections (300)",
            "Improved accident detection logic",
            "Better collision detection sensitivity"
        ]
    }

@app.post("/detect/video")
async def detect_video_endpoint(request: VideoDetectionRequest, background_tasks: BackgroundTasks):
    try:
        logger.info(f"📹 Processing video detection: videoId={request.videoId}, filePath={request.filePath}")
        original_path = request.filePath
        paths_to_try = [
            original_path,
            os.path.join('/app', 'uploads', os.path.basename(original_path)),
            os.path.join('/app/uploads', original_path),
            os.path.join('/app/uploads', os.path.basename(original_path)),
            os.path.join('/app', 'uploads', original_path),
        ]
        video_path = None
        found_paths = []
        for test_path in paths_to_try:
            found_paths.append(f"  - {test_path} (exists: {os.path.exists(test_path)})")
            if os.path.exists(test_path) and os.path.isfile(test_path):
                video_path = test_path
                break
        if not video_path:
            logger.error(f"❌ Video file not found! Searched paths:\n" + "\n".join(found_paths))
            logger.error(f"   Original filePath from request: {original_path}")
            logger.error(f"   Current working directory: {os.getcwd()}")
            logger.error(f"   /app/uploads exists: {os.path.exists('/app/uploads')}")
            if os.path.exists('/app/uploads'):
                try:
                    files = os.listdir('/app/uploads')
                    logger.error(f"   Files in /app/uploads: {files[:10]}")
                except:
                    pass
            video_path = None
        if video_path:
            logger.info(f"✅ Found video at: {video_path}")
        else:
            logger.warning(f"⚠️ Video path not found, will try in background task")
        try:
            conn = psycopg2.connect(
                host=os.getenv('DB_HOST', 'localhost'),
                port=os.getenv('DB_PORT', '5432'),
                database=os.getenv('DB_NAME', 'accident_db'),
                user=os.getenv('DB_USER', 'postgres'),
                password=os.getenv('DB_PASSWORD', 'postgres')
            )
            cursor = conn.cursor()
            cursor.execute("""
                UPDATE videos
                SET status = 'processing', processing_started_at = NOW()
                WHERE id = %s
            """, (request.videoId,))
            conn.commit()
            cursor.close()
            conn.close()
        except Exception as e:
            logger.error(f"Failed to update video status: {str(e)}")

        background_tasks.add_task(process_video_detection, request, video_path)

        return {
            "status": "processing",
            "message": "Video detection started in background",
            "videoId": request.videoId
        }
    except Exception as e:
        logger.error(f"❌ Error starting video detection: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv('PORT', 3004))
    logger.info(f"🚀 Starting AI Detection Service on port {port}")
    uvicorn.run(app, host="0.0.0.0", port=port)