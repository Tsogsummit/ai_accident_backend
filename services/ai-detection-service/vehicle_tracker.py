"""
Vehicle Tracking and Accident Detection Module
Based on: https://www.kaggle.com/code/datafan07/car-accident-detection-yolov8
Credits: datafan07 (Kaggle)
Adapted for: Real-time camera and phone video processing
"""

import numpy as np
import pandas as pd
from typing import List, Dict, Tuple
from scipy.spatial.distance import euclidean
import logging

logger = logging.getLogger(__name__)


class VehicleTracker:
    """Track vehicles across frames and detect potential accidents"""
    
    # Vehicle classes to track (from COCO dataset)
    VEHICLE_CLASSES = ['car', 'truck', 'bus', 'motorcycle', 'bicycle']
    
    def __init__(
        self,
        confidence_threshold: float = 0.3,
        accident_detection_threshold: float = 0.6,
        min_accident_ratio: float = 0.3,
        max_tracking_distance: float = 100.0
    ):
        self.confidence_threshold = confidence_threshold
        self.accident_detection_threshold = accident_detection_threshold
        self.min_accident_ratio = min_accident_ratio
        self.max_tracking_distance = max_tracking_distance
        
        # Storage for tracking
        self.detections_df = None
        self.vehicle_tracks = []
        
    def process_detection(
        self,
        boxes: np.ndarray,
        confidences: np.ndarray,
        class_ids: np.ndarray,
        class_names: List[str],
        frame_idx: int
    ) -> pd.DataFrame:
        """
        Process YOLO detections for a single frame
        
        Args:
            boxes: Bounding boxes [x, y, x2, y2]
            confidences: Confidence scores
            class_ids: Class IDs
            class_names: List of class names
            frame_idx: Frame index
            
        Returns:
            DataFrame with vehicle detections
        """
        detections = []
        
        for i, (box, conf, class_id) in enumerate(zip(boxes, confidences, class_ids)):
            class_name = class_names[int(class_id)]
            
            # Filter for vehicles only
            if class_name not in self.VEHICLE_CLASSES:
                continue
                
            # Filter by confidence
            if conf < self.confidence_threshold:
                continue
            
            x, y, x2, y2 = box
            center_x = (x + x2) / 2
            center_y = (y + y2) / 2
            
            detections.append({
                'frame_idx': frame_idx,
                'x': center_x,
                'y': -center_y,  # Invert Y for consistent coordinate system
                'x2': x2,
                'y2': y2,
                'width': x2 - x,
                'height': y2 - y,
                'confidence': conf,
                'class': class_name,
                'detection_id': f"{frame_idx}_{i}"
            })
        
        return pd.DataFrame(detections)
    
    def accumulate_detections(self, frame_detections: pd.DataFrame):
        """Accumulate detections across frames"""
        if self.detections_df is None:
            self.detections_df = frame_detections
        else:
            self.detections_df = pd.concat(
                [self.detections_df, frame_detections],
                ignore_index=True
            )
    
    def track_vehicles(self) -> List[Dict]:
        """
        Track vehicles across frames using simple position-based tracking
        
        Returns:
            List of vehicle tracks
        """
        if self.detections_df is None or len(self.detections_df) == 0:
            return []
        
        # Sort by frame index
        df = self.detections_df.sort_values('frame_idx').reset_index(drop=True)
        
        tracks = []
        track_id = 0
        assigned = set()
        
        # Group by frame
        for frame_idx in df['frame_idx'].unique():
            frame_detections = df[df['frame_idx'] == frame_idx]
            
            for _, detection in frame_detections.iterrows():
                det_id = detection['detection_id']
                
                if det_id in assigned:
                    continue
                
                # Start new track
                track = {
                    'track_id': track_id,
                    'class': detection['class'],
                    'positions': [(detection['x'], detection['y'])],
                    'frames': [frame_idx],
                    'confidences': [detection['confidence']],
                    'bboxes': [(
                        detection['x'] - detection['width']/2,
                        detection['y'] + detection['height']/2,
                        detection['width'],
                        detection['height']
                    )]
                }
                
                assigned.add(det_id)
                
                # Try to extend track to next frames
                current_pos = (detection['x'], detection['y'])
                current_frame = frame_idx
                
                for next_frame_idx in range(frame_idx + 1, df['frame_idx'].max() + 1):
                    next_detections = df[
                        (df['frame_idx'] == next_frame_idx) &
                        (df['class'] == detection['class'])
                    ]
                    
                    if len(next_detections) == 0:
                        continue
                    
                    # Find closest detection
                    min_dist = float('inf')
                    closest_det = None
                    closest_idx = None
                    
                    for idx, next_det in next_detections.iterrows():
                        next_det_id = next_det['detection_id']
                        if next_det_id in assigned:
                            continue
                        
                        next_pos = (next_det['x'], next_det['y'])
                        dist = euclidean(current_pos, next_pos)
                        
                        if dist < min_dist and dist < self.max_tracking_distance:
                            min_dist = dist
                            closest_det = next_det
                            closest_idx = next_det_id
                    
                    if closest_det is not None:
                        track['positions'].append((closest_det['x'], closest_det['y']))
                        track['frames'].append(next_frame_idx)
                        track['confidences'].append(closest_det['confidence'])
                        track['bboxes'].append((
                            closest_det['x'] - closest_det['width']/2,
                            closest_det['y'] + closest_det['height']/2,
                            closest_det['width'],
                            closest_det['height']
                        ))
                        assigned.add(closest_idx)
                        current_pos = (closest_det['x'], closest_det['y'])
                        current_frame = next_frame_idx
                
                tracks.append(track)
                track_id += 1
        
        self.vehicle_tracks = tracks
        return tracks
    
    def detect_accidents(self) -> Dict:
        """
        Detect potential accidents based on vehicle behavior
        
        Detection criteria:
        1. Sudden stop or position change
        2. Multiple vehicles in close proximity
        3. Unusual movement patterns
        
        Returns:
            Dictionary with accident detection results
        """
        if not self.vehicle_tracks:
            self.track_vehicles()
        
        if not self.vehicle_tracks:
            return {
                'has_accident': False,
                'confidence': 0.0,
                'accident_frames': [],
                'details': []
            }
        
        accident_indicators = []
        suspicious_frames = set()
        
        # Analyze each track
        for track in self.vehicle_tracks:
            if len(track['positions']) < 3:
                continue
            
            positions = np.array(track['positions'])
            frames = track['frames']
            
            # Calculate velocities (position change between frames)
            velocities = np.diff(positions, axis=0)
            speeds = np.linalg.norm(velocities, axis=1)
            
            # Detect sudden stops (large speed reduction)
            if len(speeds) > 1:
                speed_changes = np.diff(speeds)
                sudden_stops = np.where(speed_changes < -20)[0]
                
                for stop_idx in sudden_stops:
                    frame_idx = frames[stop_idx + 1]
                    suspicious_frames.add(frame_idx)
                    
                    accident_indicators.append({
                        'type': 'sudden_stop',
                        'frame': frame_idx,
                        'track_id': track['track_id'],
                        'vehicle_class': track['class'],
                        'confidence': min(track['confidences'][stop_idx], 0.9)
                    })
        
        # Check for vehicle clustering (multiple vehicles close together)
        if self.detections_df is not None:
            for frame_idx in self.detections_df['frame_idx'].unique():
                frame_vehicles = self.detections_df[
                    self.detections_df['frame_idx'] == frame_idx
                ]
                
                if len(frame_vehicles) >= 3:
                    # Calculate pairwise distances
                    positions = frame_vehicles[['x', 'y']].values
                    
                    close_pairs = 0
                    for i in range(len(positions)):
                        for j in range(i + 1, len(positions)):
                            dist = euclidean(positions[i], positions[j])
                            if dist < 50:  # Close proximity threshold
                                close_pairs += 1
                    
                    if close_pairs >= 2:
                        suspicious_frames.add(frame_idx)
                        accident_indicators.append({
                            'type': 'vehicle_clustering',
                            'frame': frame_idx,
                            'vehicle_count': len(frame_vehicles),
                            'confidence': min(0.7, 0.5 + close_pairs * 0.1)
                        })
        
        # Calculate overall accident probability
        total_frames = len(self.detections_df['frame_idx'].unique()) if self.detections_df is not None else 0
        accident_frame_ratio = len(suspicious_frames) / total_frames if total_frames > 0 else 0
        
        # Calculate max confidence from indicators
        max_confidence = max(
            [ind['confidence'] for ind in accident_indicators],
            default=0.0
        )
        
        # Decision logic
        has_accident = (
            accident_frame_ratio > self.min_accident_ratio and
            max_confidence > self.accident_detection_threshold
        )
        
        return {
            'has_accident': has_accident,
            'confidence': max_confidence,
            'accident_frame_ratio': accident_frame_ratio,
            'suspicious_frames': sorted(list(suspicious_frames)),
            'total_frames': total_frames,
            'accident_indicators': accident_indicators,
            'vehicle_tracks_count': len(self.vehicle_tracks),
            'total_vehicle_detections': len(self.detections_df) if self.detections_df is not None else 0
        }
    
    def get_statistics(self) -> Dict:
        """Get detection statistics"""
        if self.detections_df is None:
            return {}
        
        stats = {
            'total_detections': len(self.detections_df),
            'total_frames': self.detections_df['frame_idx'].nunique(),
            'vehicle_counts': self.detections_df['class'].value_counts().to_dict(),
            'avg_confidence': float(self.detections_df['confidence'].mean()),
            'track_count': len(self.vehicle_tracks)
        }
        
        return stats