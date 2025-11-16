# How to Check AI Detection Results

After uploading a video, you can check if AI detected an accident using several methods:

## 1. Check Video Status Endpoint (Recommended)

**Endpoint:** `GET /api/video/videos/:videoId/status`

### Example Request:
```bash
curl http://localhost:3000/api/video/videos/1/status
```

### Response Structure:
```json
{
  "success": true,
  "videoId": 1,
  "accidentId": 1,
  "status": "completed",  // uploaded, processing, completed, failed
  "uploadedAt": "2025-01-20T10:00:00Z",
  "processingStartedAt": "2025-01-20T10:00:01Z",
  "processingCompletedAt": "2025-01-20T10:01:30Z",
  "errorMessage": null,
  "aiProcessingStatus": "completed",  // pending, processing, completed, failed
  "aiDetection": {
    "status": "completed",
    "confidence": 0.85,  // 0-1, higher = more confident
    "hasAccident": true,  // ✅ THIS IS THE KEY FIELD
    "totalFrames": 60,
    "confirmedTracks": 5,
    "suspiciousFrames": [12, 13, 14, 15],
    "indicatorCounts": {
      "collision": 1,
      "sudden_stop": 2,
      "erratic_trajectory": 3,
      "vehicle_clustering": 0
    },
    "processedAt": "2025-01-20T10:01:30Z",
    "details": { /* full details */ */ }
  },
  "accident": {
    "id": 1,
    "latitude": 47.123,
    "longitude": 106.456,
    "severity": "moderate",
    "status": "confirmed"  // reported, confirmed, false_alarm, resolved
  }
}
```

### Key Fields to Check:

1. **`aiDetection.hasAccident`** - Main field: `true` = accident detected, `false` = no accident
2. **`aiDetection.confidence`** - AI confidence level (0-1)
3. **`aiProcessingStatus`** - Current AI processing state:
   - `pending` - Not yet processed
   - `processing` - Currently being analyzed
   - `completed` - Processing finished
   - `failed` - Processing failed
4. **`accident.status`** - Accident status after AI review:
   - `reported` - Initial status
   - `confirmed` - AI detected accident
   - `false_alarm` - AI did not detect accident (low confidence)

## 2. Check Accident Status

**Endpoint:** `GET /api/accident/accidents/:accidentId`

The accident status will be updated based on AI detection:
- `confirmed` - AI detected an accident
- `false_alarm` - AI did not detect an accident

## 3. Response States

### When AI is Still Processing:
```json
{
  "aiProcessingStatus": "processing",
  "aiDetection": null,
  "status": "processing"
}
```

### When AI Detection Completed (Accident Found):
```json
{
  "aiProcessingStatus": "completed",
  "aiDetection": {
    "hasAccident": true,
    "confidence": 0.85,
    ...
  },
  "accident": {
    "status": "confirmed"
  }
}
```

### When AI Detection Completed (No Accident):
```json
{
  "aiProcessingStatus": "completed",
  "aiDetection": {
    "hasAccident": false,
    "confidence": 0.25,
    ...
  },
  "accident": {
    "status": "false_alarm"
  }
}
```

### When AI Processing Failed:
```json
{
  "aiProcessingStatus": "failed",
  "status": "failed",
  "errorMessage": "Error message here"
}
```

## 4. JavaScript Example

```javascript
async function checkAIDetection(videoId) {
  const response = await fetch(`http://localhost:3000/api/video/videos/${videoId}/status`);
  const data = await response.json();
  
  if (data.aiProcessingStatus === 'processing') {
    console.log('AI is still processing...');
    return 'processing';
  }
  
  if (data.aiDetection) {
    if (data.aiDetection.hasAccident) {
      console.log(`✅ Accident detected! Confidence: ${data.aiDetection.confidence}`);
      return 'accident';
    } else {
      console.log(`❌ No accident detected. Confidence: ${data.aiDetection.confidence}`);
      return 'no_accident';
    }
  }
  
  console.log('AI detection not available yet');
  return 'pending';
}

// Poll every 5 seconds until processing is complete
async function waitForAIDetection(videoId) {
  while (true) {
    const status = await checkAIDetection(videoId);
    if (status !== 'processing' && status !== 'pending') {
      return status;
    }
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
}
```

## 5. Using cURL

```bash
# Check video status
curl http://localhost:3000/api/video/videos/1/status | jq '.aiDetection.hasAccident'

# Check if processing is complete
curl http://localhost:3000/api/video/videos/1/status | jq '.aiProcessingStatus'

# Get full AI detection details
curl http://localhost:3000/api/video/videos/1/status | jq '.aiDetection'
```

## Summary

**The simplest way to check:**
1. Call `GET /api/video/videos/:videoId/status`
2. Check `aiDetection.hasAccident`:
   - `true` = Accident detected ✅
   - `false` = No accident detected ❌
   - `null` = Not processed yet ⏳
3. Check `aiProcessingStatus` to see if processing is complete

