"""
Optimized Test Script - Better accident detection
Works with main.py

Usage: python test_optimized.py video.mp4
"""

import sys
import os

if os.path.exists('main.py'):
    from main import (
        OptimizedVehicleTracker, 
        extract_frames, 
        model,
        logger
    )
else:
    print("❌ main.py файл олдсонгүй!")
    sys.exit(1)

import json
from datetime import datetime


def test_video_optimized(video_path: str):
    """Optimized video test with better sensitivity"""
    print("=" * 70)
    print("🧪 OPTIMIZED AI TEST v2.1")
    print("=" * 70)
    print("\n🎯 Optimizations:")
    print("   - Lower thresholds (50% vs 65%)")
    print("   - 0.5s frame interval (was 1s)")
    print("   - Better erratic detection (60° vs 90°)")
    print("   - More sensitive collision (IoU 0.05 vs 0.1)")
    
    # Extract frames with 0.5s interval
    print(f"\n📹 Video: {video_path}")
    frames = extract_frames(video_path, interval=0.5, max_frames=500)
    print(f"✂️ Extracted: {len(frames)} frames (0.5s interval)")
    
    # Initialize optimized tracker
    print("\n🚗 Optimized Tracking...")
    tracker = OptimizedVehicleTracker(
        confidence_threshold=0.35,
        max_age=3,
        min_hits=2,
        collision_iou_threshold=0.05,
        sudden_stop_threshold=-10.0,
        clustering_distance=80.0,
        erratic_angle_threshold=60.0
    )
    
    # Process frames
    for frame_idx, frame in enumerate(frames):
        results = model(frame, conf=0.35, verbose=False)
        
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
        
        if (frame_idx + 1) % 20 == 0:
            print(f"   Progress: {frame_idx + 1}/{len(frames)}")
    
    # Detect accidents
    print("\n⚠️ Analyzing with optimized thresholds...")
    result = tracker.detect_accidents()
    stats = tracker.get_statistics()
    
    # Results
    print("\n" + "=" * 70)
    print("📊 OPTIMIZED RESULTS")
    print("=" * 70)
    
    if result['has_accident']:
        print(f"\n🚨 Accident: YES ⚠️⚠️⚠️")
    else:
        print(f"\n✅ Accident: NO")
    
    print(f"   Confidence: {result['confidence']:.2%}")
    print(f"   Threshold: 50% (optimized)")
    print(f"   Suspicious frames: {len(result['suspicious_frames'])}/{result['total_frames']}")
    print(f"   Accident ratio: {result['accident_frame_ratio']:.1%}")
    
    if result['indicator_counts']:
        print(f"\n📋 Indicators Detected:")
        for ind_type, count in result['indicator_counts'].items():
            emoji = {
                'collision': '💥',
                'sudden_stop': '🛑',
                'erratic_trajectory': '🔄',
                'vehicle_clustering': '🚗🚗'
            }.get(ind_type, '⚠️')
            print(f"   {emoji} {ind_type}: {count}")
    
    print(f"\n🚗 Vehicle Tracking:")
    print(f"   Confirmed tracks: {stats['confirmed_tracks']}")
    print(f"   Total detections: {stats['total_detections']}")
    print(f"   Avg track length: {stats['avg_track_length']:.1f} frames")
    
    if stats['vehicle_class_distribution']:
        print(f"\n🚙 Vehicle Types:")
        for vehicle_type, count in stats['vehicle_class_distribution'].items():
            print(f"   - {vehicle_type}: {count}")
    
    # Decision explanation
    print(f"\n💡 Decision Logic:")
    print(f"   Final confidence: {result['confidence']:.2%}")
    print(f"   - Threshold check: {result['confidence']:.2%} > 50%? {result['confidence'] > 0.50}")
    print(f"   - Ratio check: {result['accident_frame_ratio']:.1%} > 20% AND conf > 40%? {result['accident_frame_ratio'] > 0.20 and result['confidence'] > 0.40}")
    print(f"   - Collision check: {result['indicator_counts'].get('collision', 0)} > 0? {result['indicator_counts'].get('collision', 0) > 0}")
    print(f"   - Erratic check: {result['indicator_counts'].get('erratic_trajectory', 0)} > 10? {result['indicator_counts'].get('erratic_trajectory', 0) > 10}")
    
    # Save results
    output = {
        'video': video_path,
        'version': '2.1.0-optimized',
        'has_accident': result['has_accident'],
        'confidence': result['confidence'],
        'accident_ratio': result['accident_frame_ratio'],
        'indicators': result['indicator_counts'],
        'frames_analyzed': len(frames),
        'frame_interval': '0.5s',
        'thresholds': {
            'confidence': 0.50,
            'collision_iou': 0.05,
            'sudden_stop': -10.0,
            'erratic_angle': 60.0
        },
        'timestamp': datetime.now().isoformat()
    }
    
    with open('test_result_optimized.json', 'w') as f:
        json.dump(output, f, indent=2)
    
    print(f"\n💾 Saved: test_result_optimized.json")
    print("=" * 70)
    
    return result['has_accident']


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python test_optimized.py <video_path>")
        print("\nExample:")
        print("  python test_optimized.py accident.mp4")
        print("\nOptimizations:")
        print("  ✅ 50% threshold (was 65%)")
        print("  ✅ 0.5s frame interval (was 1s)")
        print("  ✅ Better erratic detection (60° vs 90°)")
        print("  ✅ Sensitive collision (IoU 0.05 vs 0.1)")
        sys.exit(1)
    
    video_path = sys.argv[1]
    
    if not os.path.exists(video_path):
        print(f"❌ Video not found: {video_path}")
        sys.exit(1)
    
    try:
        has_accident = test_video_optimized(video_path)
        
        print("\n" + "=" * 70)
        if has_accident:
            print("✅ SUCCESS: Accident detected!")
        else:
            print("⚠️ WARNING: No accident detected")
            print("   If this is incorrect, try:")
            print("   - Checking if video shows clear accident")
            print("   - Adjusting thresholds in main_optimized.py")
        print("=" * 70)
        
        sys.exit(0 if has_accident else 1)
    except Exception as e:
        print(f"\n❌ Error: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)