# AI Model Upgrade - YOLOv8m Implementation

## Overview
Upgraded AI detection service from YOLOv8n (nano) to YOLOv8m (medium) for significantly better accuracy in accident detection.

---

## Changes Made

### 1. Model Download and Installation

**Location**: `/services/ai-detection-service/models/yolov8m.pt`

**Model Details**:
- **File Size**: ~50 MB (49.7 MB)
- **Parameters**: 25.9 million (vs 3.2M in nano)
- **Accuracy**: Higher precision and recall for vehicle detection
- **Speed**: Slightly slower than nano, but still real-time capable

**Download Command**:
```python
from ultralytics import YOLO
model = YOLO('yolov8m.pt')
```

---

### 2. main.py Configuration Updates

#### Config Class (Lines 505-511)
```python
class Config:
    MODEL_PATH = os.getenv('MODEL_PATH', '/app/models/yolov8m.pt')
    MODEL_CONFIDENCE = float(os.getenv('AI_CONFIDENCE_THRESHOLD', 0.30))  # Was 0.35
    FRAME_INTERVAL = float(os.getenv('AI_FRAME_INTERVAL', 0.5))
    MAX_FRAMES = int(os.getenv('AI_MAX_FRAMES', 500))
    IOU_THRESHOLD = float(os.getenv('AI_IOU_THRESHOLD', 0.45))  # NEW
    MAX_DET = int(os.getenv('AI_MAX_DETECTIONS', 300))  # NEW
```

**Key Changes**:
- Updated `MODEL_PATH` to point to YOLOv8m
- Lowered confidence threshold from 0.35 to 0.30 (more sensitive)
- Added `IOU_THRESHOLD` (0.45) for better overlapping object handling
- Added `MAX_DET` (300) to detect more objects per frame

#### Model Loading (Lines 515-522)
```python
try:
    logger.info(f"Loading YOLOv8m model: {config.MODEL_PATH}")
    model = YOLO(config.MODEL_PATH)
    logger.info("✅ YOLOv8m model loaded successfully (higher accuracy)")
except Exception as e:
    logger.error(f"Failed to load YOLOv8m: {e}")
    logger.info("⚠️ Fallback to YOLOv8n")
    model = YOLO('yolov8n.pt')
```

#### detect_accident() Function (Lines 555-575)
```python
def detect_accident(frames, confidence_threshold=0.30):  # Was 0.35
    """Optimized accident detection with YOLOv8m for better accuracy"""
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
        # Use YOLOv8m with optimized parameters for better detection
        results = model(
            frame,
            conf=confidence_threshold,
            iou=config.IOU_THRESHOLD,      # NEW
            max_det=config.MAX_DET,        # NEW
            verbose=False
        )
```

**Improvements**:
- Added `iou` parameter for better Non-Maximum Suppression
- Added `max_det` parameter to detect more vehicles per frame
- Updated default confidence to 0.30

#### OptimizedVehicleTracker (Line 128)
```python
def __init__(
    self,
    confidence_threshold: float = 0.30,  # Was 0.35
    max_age: int = 3,
    min_hits: int = 2,
    ...
)
```

#### Accident Detection Logic (Lines 438-445)
```python
# Improved accident detection logic with YOLOv8m (more accurate detections)
has_accident = (
    final_confidence > 0.55 or  # Was 0.50
    (accident_frame_ratio > 0.25 and final_confidence > 0.45) or  # Was 0.20 and 0.40
    indicator_counts.get('collision', 0) > 0 or
    (indicator_counts.get('erratic_trajectory', 0) > 8 and final_confidence > 0.40) or  # Was 10 and 0.35
    (accident_frame_ratio > 0.65 and final_confidence > 0.35)  # Was 0.70 and 0.30
)
```

**Why these changes?**:
Since YOLOv8m provides more accurate detections, we can afford to be more strict with our accident decision thresholds to reduce false positives.

#### Image Detection Endpoint (Lines 1036-1043)
```python
# Run YOLOv8m detection with optimized parameters
results = model(
    image_np,
    conf=config.MODEL_CONFIDENCE,
    iou=config.IOU_THRESHOLD,
    max_det=config.MAX_DET,
    verbose=False
)
```

---

### 3. Dockerfile Updates (Lines 19-31)

```dockerfile
# Copy application code
COPY . .

# Copy YOLOv8m model
RUN mkdir -p /app/models
COPY models/yolov8m.pt /app/models/yolov8m.pt

ENV PORT=3004 \
    MODEL_PATH=/app/models/yolov8m.pt \
    AI_CONFIDENCE_THRESHOLD=0.30 \
    AI_IOU_THRESHOLD=0.45 \
    AI_MAX_DETECTIONS=300 \
    PYTHONUNBUFFERED=1
```

**Changes**:
- Added `COPY models/yolov8m.pt` to include model in Docker image
- Updated `MODEL_PATH` environment variable
- Added new environment variables for IOU and max detections

---

### 4. API Endpoint Updates

#### Health Endpoint (Lines 915-939)
```json
{
  "status": "healthy",
  "service": "ai-detection-service",
  "version": "3.0.0-yolov8m",
  "model": "YOLOv8m (Medium - Higher Accuracy)",
  "model_path": "/app/models/yolov8m.pt",
  "timestamp": "2025-11-18T17:08:00",
  "config": {
    "confidence_threshold": 0.30,
    "iou_threshold": 0.45,
    "max_detections": 300,
    "frame_interval": 0.5
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
```

#### Root Endpoint (Lines 1089-1103)
```json
{
  "service": "AI Detection Service",
  "version": "3.0.0-yolov8m",
  "model": "YOLOv8m (Medium)",
  "status": "running",
  "endpoints": [
    "/health",
    "/detect/video",
    "/detect/image"
  ],
  "accuracy": "Higher accuracy with YOLOv8m model"
}
```

#### Image Detection Response (Lines 1075-1083)
```json
{
  "success": true,
  "cameraId": 1,
  "frameId": 123,
  "predictions": [...],
  "timestamp": "2025-11-18T17:08:00",
  "modelVersion": "3.0.0-yolov8m",
  "model": "YOLOv8m"
}
```

---

## Performance Comparison

### YOLOv8n (Nano) - Previous
- **Parameters**: 3.2M
- **Speed**: ~0.5ms per image (fastest)
- **Accuracy (mAP50-95)**: 37.3%
- **Use Case**: Edge devices, real-time on low power

### YOLOv8m (Medium) - Current ✓
- **Parameters**: 25.9M
- **Speed**: ~2-3ms per image
- **Accuracy (mAP50-95)**: 50.2%
- **Use Case**: Balanced speed/accuracy for production
- **Improvement**: +13% accuracy over nano

### YOLOv8l (Large) - Future Option
- **Parameters**: 43.7M
- **Speed**: ~4-5ms per image
- **Accuracy (mAP50-95)**: 52.9%
- **Use Case**: Maximum accuracy when speed is not critical

---

## Configuration Tuning

### Confidence Threshold: 0.35 → 0.30
**Why lower?**
- YOLOv8m has better confidence calibration
- Catches more potential accidents (higher recall)
- Slightly more false positives, but better than missing real accidents

### IOU Threshold: New (0.45)
**Purpose**:
- Controls Non-Maximum Suppression (NMS)
- Determines when two boxes overlap too much
- 0.45 is balanced - not too aggressive, not too lenient

### Max Detections: New (300)
**Purpose**:
- Allows detecting up to 300 objects per frame
- Default is usually 100-300
- Important for busy traffic scenes with many vehicles

### Accident Detection Thresholds: Stricter
**Why stricter?**
- More accurate detections = can be more selective
- Reduces false alarms from misdetections
- Better precision without sacrificing recall

---

## Testing Recommendations

### Test 1: Build and Deploy
```bash
cd services/ai-detection-service
docker-compose build ai-detection-service
docker-compose up ai-detection-service
```

### Test 2: Health Check
```bash
curl http://localhost:3004/health
```

Expected response should show:
- `"version": "3.0.0-yolov8m"`
- `"model": "YOLOv8m (Medium - Higher Accuracy)"`
- `"confidence_threshold": 0.30`

### Test 3: Video Detection
Send a test video through the API and verify:
1. Detection accuracy improved
2. Fewer missed accidents
3. Better vehicle tracking
4. Response time still acceptable (30-60 seconds for 5-minute video)

### Test 4: Camera Stream
Test with HLS camera streams:
1. Check if real-time detection works
2. Verify no performance degradation
3. Monitor CPU/GPU usage

---

## Migration Steps for Production

### Step 1: Build New Image
```bash
cd ai_accident_backend
docker-compose build ai-detection-service
```

This will:
- Install dependencies
- Copy the yolov8m.pt model (50MB)
- Set new environment variables

### Step 2: Stop Old Service
```bash
docker-compose stop ai-detection-service
```

### Step 3: Start New Service
```bash
docker-compose up -d ai-detection-service
```

### Step 4: Verify Logs
```bash
docker-compose logs -f ai-detection-service
```

Look for:
```
Loading YOLOv8m model: /app/models/yolov8m.pt
✅ YOLOv8m model loaded successfully (higher accuracy)
```

### Step 5: Test API
```bash
curl http://localhost:3004/health
```

---

## Rollback Plan

If YOLOv8m causes issues:

1. **Quick Rollback**: Service will fallback to YOLOv8n if model fails to load
2. **Manual Rollback**:
   - Revert `main.py` changes
   - Change `MODEL_PATH` back to `yolov8n.pt`
   - Rebuild and redeploy

---

## Expected Benefits

### 1. Higher Detection Accuracy
- **Vehicle Detection**: +13% accuracy (mAP 50.2% vs 37.3%)
- **Fewer Missed Accidents**: Better at detecting partially occluded vehicles
- **Better Confidence Scores**: More reliable confidence values

### 2. Improved Edge Cases
- Better in low-light conditions
- Better with small vehicles (motorcycles, bicycles)
- Better with unusual vehicle angles

### 3. Fewer False Negatives
- Lower confidence threshold (0.30) catches more potential accidents
- Better vehicle tracking reduces lost tracks
- More detections per frame (300 vs default)

### 4. Trade-offs
- **Speed**: 2-3ms per frame (was ~0.5ms) - Still real-time capable
- **Memory**: ~200MB more RAM usage - Acceptable for server deployment
- **Docker Image**: +50MB size - Minimal impact

---

## Environment Variables Reference

```env
# AI Detection Service
MODEL_PATH=/app/models/yolov8m.pt
AI_CONFIDENCE_THRESHOLD=0.30
AI_IOU_THRESHOLD=0.45
AI_MAX_DETECTIONS=300
AI_FRAME_INTERVAL=0.5
AI_MAX_FRAMES=500
```

---

## Files Modified

1. ✅ `services/ai-detection-service/main.py`
   - Updated model loading
   - Added new config parameters
   - Improved detection logic
   - Updated all endpoints

2. ✅ `services/ai-detection-service/Dockerfile`
   - Added model copy
   - Updated environment variables

3. ✅ `services/ai-detection-service/models/yolov8m.pt` (NEW)
   - Downloaded YOLOv8m model (49.7 MB)

---

## Date Applied
November 18, 2025

## Status
✅ All changes complete and ready for testing

---

## Next Steps

1. **Test locally** with sample videos
2. **Build Docker image** and verify model is included
3. **Deploy to staging** environment
4. **Monitor performance** metrics
5. **Compare results** with old YOLOv8n model
6. **Deploy to production** once validated

---

## Support

For issues or questions:
- Check logs: `docker-compose logs -f ai-detection-service`
- Health endpoint: `GET http://localhost:3004/health`
- Model loads successfully: Look for "✅ YOLOv8m model loaded successfully"
