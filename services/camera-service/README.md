# Camera Service - HLS Stream Processing

## Overview
The Camera Service monitors HLS video streams from traffic cameras (like UB Traffic), captures 5min30sec video segments, sends them to AI detection, and creates accident records when accidents are detected.

## Features

- 📹 **HLS Stream Processing**: Connects to HLS streams (.m3u8 playlist URLs)
- ⏱️ **Automatic Capture**: Captures 5 minute 30 second video segments every 6 minutes
- 🤖 **AI Integration**: Sends videos to AI detection service automatically
- 🚨 **Accident Detection**: Creates accident records when AI detects accidents (confidence >= 75%)
- 💾 **Smart Storage**: Only saves videos when accidents are detected
- 🔄 **Redis Caching**: Temporary storage for video metadata
- 📊 **Monitoring**: Track camera status, errors, and statistics

## Architecture

```
HLS Stream (UB Traffic)
    ↓
Master Playlist (.m3u8)
    ↓
Chunklist (.m3u8)
    ↓
Media Segments (.ts files)
    ↓
Download & Concatenate → MP4 Video
    ↓
AI Detection Service
    ↓
If Accident Detected (confidence >= 75%):
    ├→ Upload to Video Service
    ├→ Create Accident Record
    ├→ Notify Nearby Users
    └→ Save to Database
Else:
    └→ Delete Video (no storage)
```

## Installation

```bash
cd services/camera-service
npm install
```

### Required Dependencies
- `ioredis` - Redis client for caching
- `m3u8-parser` - Parse HLS playlists
- `node-cron` - Schedule periodic tasks
- `fluent-ffmpeg` - Video processing (requires FFmpeg installed)
- `axios` - HTTP requests

### FFmpeg Requirement
Make sure FFmpeg is installed on your system:

**Linux/Mac:**
```bash
# Ubuntu/Debian
sudo apt-get install ffmpeg

# Mac
brew install ffmpeg
```

**Windows:**
Download from https://ffmpeg.org/download.html

**Docker:**
FFmpeg is included in the Dockerfile.

## Configuration

### Environment Variables

```bash
# Server
PORT=3008

# Database
DB_HOST=localhost
DB_PORT=5432
DB_NAME=accident_db
DB_USER=postgres
DB_PASSWORD=postgres

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379

# Service URLs
AI_SERVICE_URL=http://ai-detection-service:3004
VIDEO_SERVICE_URL=http://video-service:3003
ACCIDENT_SERVICE_URL=http://accident-service:3002
```

## API Endpoints

### Camera Management

#### GET /cameras
Get all cameras with statistics

**Response:**
```json
{
  "success": true,
  "cameras": [
    {
      "id": 1,
      "name": "UB Traffic - Camera 32900",
      "stream_url": "https://stream.ubtraffic.mn/live/32900.stream_480p/playlist.m3u8",
      "stream_type": "hls",
      "status": "active",
      "is_online": true,
      "accidents_24h": 5,
      "total_accidents": 23
    }
  ],
  "count": 1
}
```

#### POST /cameras
Add new camera

**Request:**
```json
{
  "name": "UB Traffic - Camera 32900",
  "location": "Peace Avenue, Ulaanbaatar",
  "latitude": 47.9184,
  "longitude": 106.9177,
  "stream_url": "https://stream.ubtraffic.mn/live/32900.stream_480p/playlist.m3u8",
  "resolution": "480p",
  "fps": 25,
  "description": "Traffic camera at Peace Avenue",
  "status": "active"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Камер амжилттай нэмэгдлээ",
  "data": { ... }
}
```

#### PUT /cameras/:id
Update camera

#### DELETE /cameras/:id
Delete camera

#### POST /cameras/:id/start
Activate camera monitoring

#### POST /cameras/:id/stop
Deactivate camera monitoring

#### POST /cameras/:id/process-now
Manually trigger immediate processing for a camera (useful for testing)

**Response:**
```json
{
  "success": true,
  "message": "Камерын боловсруулалт эхэллээ"
}
```

### Health Check

#### GET /health
```json
{
  "status": "healthy",
  "service": "camera-service",
  "timestamp": "2025-11-17T12:00:00.000Z",
  "uptime": 12345,
  "port": 3008,
  "database": "connected",
  "redis": "connected",
  "streamMonitor": "running"
}
```

## How It Works

### 1. Stream Monitoring

The service uses `node-cron` to check cameras every **6 minutes**:
- Runs on schedule: `*/6 * * * *`
- Loads all active HLS cameras from database
- Processes each camera in parallel

### 2. HLS Stream Processing

For each camera:
1. **Fetch Master Playlist** (`playlist.m3u8`)
   - Parse to get chunklist URL

2. **Fetch Chunklist** (`chunklist_w*.m3u8`)
   - Get list of media segments (.ts files)
   - Calculate segments needed: 330 seconds ÷ 10 seconds/segment = 33 segments

3. **Download Segments**
   - Download the last 33 segments (most recent 5m30s)
   - Save to temp directory: `/temp/camera_{id}_{timestamp}/`

4. **Concatenate Video**
   - Use FFmpeg to merge .ts segments into single MP4
   - Output: `camera_{id}_{timestamp}.mp4`

5. **Clean Up Segments**
   - Delete individual .ts files (keep only MP4)

### 3. AI Detection

Send the MP4 video to AI service:
```javascript
POST http://ai-detection-service:3004/ai/detect
FormData: {
  video: <file>,
  cameraId: <id>
}
```

**AI Response:**
```json
{
  "hasAccident": true,
  "confidence": 0.92,
  "detectedObjects": [...],
  "timestamp": "..."
}
```

### 4. Accident Handling

**If `hasAccident = true` AND `confidence >= 0.75`:**

1. **Upload Video** to Video Service
2. **Create Accident** in Accident Service
   - Status: `confirmed` (auto-confirmed by AI)
   - Source: `camera`
   - Includes: videoId, cameraId, location, confidence
3. **Notify Users** within 5km radius
4. **Store Metadata** in Redis (TTL: 2 hours)
5. **Clean Up** local video file

**Otherwise:**
- Simply delete the video (no storage)
- No accident record created

## UB Traffic Stream Format

### Example URL
```
https://stream.ubtraffic.mn/live/32900.stream_480p/playlist.m3u8
```

### Stream Structure

**Master Playlist** (`playlist.m3u8`):
```m3u8
#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=240790,CODECS="avc1.66.21",RESOLUTION=440x360
chunklist_w1828334329.m3u8
```

**Chunklist** (`chunklist_w*.m3u8`):
```m3u8
#EXTM3U
#EXT-X-VERSION:3
#EXT-X-ALLOW-CACHE:NO
#EXT-X-TARGETDURATION:11
#EXT-X-MEDIA-SEQUENCE:23981
#EXTINF:10.0,
media_w1828334329_23981.ts
#EXTINF:10.0,
media_w1828334329_23982.ts
...
```

**Media Segments**:
```
https://stream.ubtraffic.mn/live/32900.stream_480p/media_w1828334329_23981.ts
https://stream.ubtraffic.mn/live/32900.stream_480p/media_w1828334329_23982.ts
...
```

Each segment is approximately **10 seconds** long.

## Redis Usage

The service uses Redis for:

### 1. Video Metadata Storage
```
Key: camera:{cameraId}:video:{timestamp}
Value: JSON {
  accidentId, videoId, cameraId,
  timestamp, confidence, videoPath
}
TTL: 7200 seconds (2 hours)
```

### 2. Processing Locks
Prevents overlapping processing of the same camera.

## Testing

### 1. Add a Camera
```bash
curl -X POST http://localhost:3008/cameras \
  -H "Content-Type: application/json" \
  -d '{
    "name": "UB Traffic - Camera 32900",
    "location": "Ulaanbaatar",
    "latitude": 47.9184,
    "longitude": 106.9177,
    "stream_url": "https://stream.ubtraffic.mn/live/32900.stream_480p/playlist.m3u8",
    "status": "active"
  }'
```

### 2. Manually Trigger Processing
```bash
curl -X POST http://localhost:3008/cameras/1/process-now
```

### 3. Check Logs
```bash
docker-compose logs -f camera-service
```

Expected log output:
```
🎥 ========================================
🎥 Processing Camera 1: UB Traffic - Camera 32900
🎥 Stream: https://stream.ubtraffic.mn/live/32900.stream_480p/playlist.m3u8
🎥 ========================================

📹 Processing HLS stream for camera 1
Target duration: 330 seconds (5m 30s)
Fetching 33 segments (10s each)
Downloaded 33/33 segments
✅ Video created: /temp/camera_1_*/camera_1_*.mp4
Video duration: 330.5 seconds

🤖 Sending video to AI detection service...
🤖 AI Detection Result:
   - Accident Detected: true
   - Confidence: 0.92

🚨 ACCIDENT DETECTED! Creating accident record...
📤 Uploading video to video service...
✅ Video uploaded: ID 123
🚨 Creating accident record...
✅ Accident created: ID 456
📢 Notifying nearby users...
✅ Users notified!
🎉 Accident handling complete!
✅ Camera 1 processing complete
```

## Troubleshooting

### FFmpeg Not Found
```
Error: Cannot find ffmpeg
```
**Solution:** Install FFmpeg on your system or use Docker.

### Stream Download Fails
```
Error fetching chunklist: timeout
```
**Solution:**
- Check internet connection
- Verify stream URL is correct
- Check if UB Traffic stream is online

### AI Service Timeout
```
AI detection failed: timeout
```
**Solution:**
- Ensure AI service is running
- Increase timeout in code (default: 2 minutes)
- Check AI service logs

### Video Too Large
If videos are too large for upload:
- Reduce capture duration (default: 330s)
- Lower resolution in stream URL (use 360p instead of 480p)

## Performance

- **Video Size**: ~50-100MB for 5m30s @ 480p
- **Processing Time**: ~30-60 seconds per camera
- **AI Detection**: ~30-120 seconds depending on video
- **Total**: ~2-3 minutes per camera per cycle

With 10 cameras: ~5-6 minutes total processing time (runs in parallel)

## Future Improvements

- [ ] Support RTSP streams (not just HLS)
- [ ] Adaptive quality selection based on bandwidth
- [ ] Multiple AI confidence thresholds
- [ ] Video compression before upload
- [ ] Distributed processing for many cameras
- [ ] Real-time streaming (vs 6-minute batches)

## License
MIT
