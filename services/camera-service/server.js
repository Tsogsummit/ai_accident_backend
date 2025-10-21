// services/camera-service/server.js
const express = require('express');
const { Pool } = require('pg');
const { PubSub } = require('@google-cloud/pubsub');
const ffmpeg = require('fluent-ffmpeg');
const { Storage } = require('@google-cloud/storage');
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3008;

app.use(express.json());

// PostgreSQL
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'accident_db',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres'
});

// Google Cloud Storage
const storage = new Storage({
  projectId: process.env.GCP_PROJECT_ID,
  keyFilename: process.env.GCP_KEY_FILE
});

const bucketName = process.env.GCS_BUCKET_NAME || 'accident-videos';
const bucket = storage.bucket(bucketName);

// Pub/Sub for AI processing queue
const pubsub = new PubSub({
  projectId: process.env.GCP_PROJECT_ID,
  keyFilename: process.env.GCP_KEY_FILE
});

const topicName = 'video-processing';
const topic = pubsub.topic(topicName);

// Камерын stream ачаалах давтамж (5 минут)
const STREAM_INTERVAL = 5 * 60 * 1000; // 5 minutes
const STREAM_DURATION = 30; // 30 секунд бичлэг авах

// Active camera streams
const activeCameraStreams = new Map();

// GET /cameras - Бүх камерын жагсаалт
app.get('/cameras', async (req, res) => {
  try {
    const { status, isOnline } = req.query;

    let query = 'SELECT * FROM cameras WHERE 1=1';
    const params = [];
    let paramIndex = 1;

    if (status) {
      query += ` AND status = $${paramIndex++}`;
      params.push(status);
    }

    if (isOnline !== undefined) {
      query += ` AND is_online = $${paramIndex++}`;
      params.push(isOnline === 'true');
    }

    query += ' ORDER BY created_at DESC';

    const result = await pool.query(query, params);

    res.json({
      cameras: result.rows,
      total: result.rowCount
    });

  } catch (error) {
    console.error('Get cameras error:', error);
    res.status(500).json({ error: 'Камер авахад алдаа гарлаа' });
  }
});

// GET /cameras/:id - Камерын дэлгэрэнгүй
app.get('/cameras/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(`
      SELECT c.*, cs.*
      FROM cameras c
      LEFT JOIN camera_statistics cs ON c.id = cs.id
      WHERE c.id = $1
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Камер олдсонгүй' });
    }

    res.json(result.rows[0]);

  } catch (error) {
    console.error('Get camera error:', error);
    res.status(500).json({ error: 'Дэлгэрэнгүй авахад алдаа гарлаа' });
  }
});

// POST /cameras - Шинэ камер нэмэх (Admin only)
app.post('/cameras', async (req, res) => {
  try {
    const {
      name,
      location,
      latitude,
      longitude,
      ipAddress,
      streamUrl
    } = req.body;

    if (!name || !latitude || !longitude || !streamUrl) {
      return res.status(400).json({
        error: 'name, latitude, longitude, streamUrl шаардлагатай'
      });
    }

    const result = await pool.query(`
      INSERT INTO cameras (
        name, location, latitude, longitude,
        ip_address, stream_url, status, is_online
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `, [
      name,
      location || '',
      latitude,
      longitude,
      ipAddress || null,
      streamUrl,
      'active',
      false
    ]);

    const camera = result.rows[0];

    // Auto-start monitoring
    startCameraMonitoring(camera);

    res.status(201).json({
      message: 'Камер амжилттай нэмэгдлээ',
      camera
    });

  } catch (error) {
    console.error('Create camera error:', error);
    res.status(500).json({ error: 'Камер нэмэхэд алдаа гарлаа' });
  }
});

// PUT /cameras/:id - Камер засварлах
app.put('/cameras/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, location, streamUrl, status } = req.body;

    const updates = [];
    const values = [];
    let paramIndex = 1;

    if (name) {
      updates.push(`name = $${paramIndex++}`);
      values.push(name);
    }

    if (location) {
      updates.push(`location = $${paramIndex++}`);
      values.push(location);
    }

    if (streamUrl) {
      updates.push(`stream_url = $${paramIndex++}`);
      values.push(streamUrl);
    }

    if (status) {
      updates.push(`status = $${paramIndex++}`);
      values.push(status);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'Өөрчлөх мэдээлэл байхгүй' });
    }

    values.push(id);

    const query = `
      UPDATE cameras
      SET ${updates.join(', ')}
      WHERE id = $${paramIndex}
      RETURNING *
    `;

    const result = await pool.query(query, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Камер олдсонгүй' });
    }

    res.json({
      message: 'Камер шинэчлэгдлээ',
      camera: result.rows[0]
    });

  } catch (error) {
    console.error('Update camera error:', error);
    res.status(500).json({ error: 'Шинэчлэхэд алдаа гарлаа' });
  }
});

// DELETE /cameras/:id - Камер устгах
app.delete('/cameras/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Stop monitoring first
    stopCameraMonitoring(id);

    await pool.query('DELETE FROM cameras WHERE id = $1', [id]);

    res.json({ message: 'Камер устгагдлаа' });

  } catch (error) {
    console.error('Delete camera error:', error);
    res.status(500).json({ error: 'Устгахад алдаа гарлаа' });
  }
});

// POST /cameras/:id/start - Камер monitoring эхлүүлэх
app.post('/cameras/:id/start', async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      'SELECT * FROM cameras WHERE id = $1',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Камер олдсонгүй' });
    }

    const camera = result.rows[0];

    if (activeCameraStreams.has(camera.id)) {
      return res.status(400).json({ error: 'Камер аль хэдийн ажиллаж байна' });
    }

    startCameraMonitoring(camera);

    res.json({
      message: 'Камер monitoring эхэллээ',
      cameraId: camera.id
    });

  } catch (error) {
    console.error('Start camera error:', error);
    res.status(500).json({ error: 'Эхлүүлэхэд алдаа гарлаа' });
  }
});

// POST /cameras/:id/stop - Камер monitoring зогсоох
app.post('/cameras/:id/stop', async (req, res) => {
  try {
    const { id } = req.params;

    stopCameraMonitoring(parseInt(id));

    res.json({
      message: 'Камер monitoring зогслоо',
      cameraId: id
    });

  } catch (error) {
    console.error('Stop camera error:', error);
    res.status(500).json({ error: 'Зогсоохоод алдаа гарлаа' });
  }
});

// Камер monitoring эхлүүлэх функц
function startCameraMonitoring(camera) {
  if (activeCameraStreams.has(camera.id)) {
    console.log(`⚠️  Камер ${camera.id} аль хэдийн ажиллаж байна`);
    return;
  }

  console.log(`▶️  Камер monitoring эхэллээ: ${camera.name} (ID: ${camera.id})`);

  // Health check эхлүүлэх (1 минут тутамд)
  const healthCheckInterval = setInterval(async () => {
    await checkCameraHealth(camera);
  }, 60 * 1000);

  // Stream capture эхлүүлэх (5 минут тутамд)
  const captureInterval = setInterval(async () => {
    await captureStreamAndProcess(camera);
  }, STREAM_INTERVAL);

  // Анх удаа шууд бичлэг авах
  setTimeout(() => captureStreamAndProcess(camera), 5000);

  activeCameraStreams.set(camera.id, {
    camera,
    healthCheckInterval,
    captureInterval
  });
}

// Камер monitoring зогсоох
function stopCameraMonitoring(cameraId) {
  const stream = activeCameraStreams.get(cameraId);
  
  if (!stream) {
    console.log(`⚠️  Камер ${cameraId} ажиллаж байхгүй`);
    return;
  }

  clearInterval(stream.healthCheckInterval);
  clearInterval(stream.captureInterval);
  activeCameraStreams.delete(cameraId);

  console.log(`⏹️  Камер monitoring зогслоо: ${cameraId}`);
}

// Камер health check
async function checkCameraHealth(camera) {
  try {
    // Simple RTSP check - ping the stream URL
    const response = await axios.head(camera.stream_url, {
      timeout: 5000
    }).catch(() => null);

    const isOnline = response !== null;

    await pool.query(
      'UPDATE cameras SET is_online = $1, last_active = NOW() WHERE id = $2',
      [isOnline, camera.id]
    );

    await pool.query(
      `INSERT INTO camera_logs (camera_id, timestamp, status)
       VALUES ($1, NOW(), $2)`,
      [camera.id, isOnline ? 'online' : 'offline']
    );

    if (!isOnline) {
      console.log(`❌ Камер ${camera.name} (ID: ${camera.id}) offline байна`);
    }

  } catch (error) {
    console.error(`Health check error for camera ${camera.id}:`, error.message);
  }
}

// Stream-ээс бичлэг авч AI-д илгээх
async function captureStreamAndProcess(camera) {
  let localVideoPath = null;
  let videoId = null;

  try {
    console.log(`📹 Бичлэг авч байна: ${camera.name} (${STREAM_DURATION}s)`);

    // Video бүртгэл үүсгэх
    const videoResult = await pool.query(`
      INSERT INTO videos (
        camera_id, file_name, file_path, status, uploaded_at
      )
      VALUES ($1, $2, $3, $4, NOW())
      RETURNING id
    `, [
      camera.id,
      `camera_${camera.id}_${Date.now()}.mp4`,
      '',  // Will be updated after upload
      'uploading'
    ]);

    videoId = videoResult.rows[0].id;
    localVideoPath = `/tmp/camera_${camera.id}_${Date.now()}.mp4`;

    // ffmpeg-ээр stream-ээс бичлэг авах
    await new Promise((resolve, reject) => {
      ffmpeg(camera.stream_url)
        .inputOptions(['-rtsp_transport', 'tcp'])
        .outputOptions([
          '-t', STREAM_DURATION.toString(),
          '-c:v', 'libx264',
          '-preset', 'fast',
          '-crf', '28'
        ])
        .output(localVideoPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    console.log(`✅ Бичлэг авагдлаа: ${localVideoPath}`);

    // GCS-д upload хийх
    const fileName = `cameras/${path.basename(localVideoPath)}`;
    await bucket.upload(localVideoPath, {
      destination: fileName,
      metadata: {
        contentType: 'video/mp4',
        metadata: {
          cameraId: camera.id.toString(),
          videoId: videoId.toString(),
          capturedAt: new Date().toISOString()
        }
      }
    });

    console.log(`☁️  GCS-д upload: ${fileName}`);

    // File stats авах
    const stats = await fs.stat(localVideoPath);

    // Video бүртгэл шинэчлэх
    await pool.query(`
      UPDATE videos
      SET file_path = $1, file_size = $2, status = 'uploaded'
      WHERE id = $3
    `, [fileName, stats.size, videoId]);

    // AI боловсруулалтын queue-д илгээх
    const messageData = {
      videoId: videoId,
      userId: null, // Камераас учир null
      filePath: fileName,
      latitude: camera.latitude,
      longitude: camera.longitude,
      description: `${camera.name} - Автомат илрүүлэлт`,
      timestamp: new Date().toISOString()
    };

    await topic.publishMessage({
      data: Buffer.from(JSON.stringify(messageData))
    });

    console.log(`🤖 AI queue-д илгээгдлээ: videoId=${videoId}`);

    // Камерын статус шинэчлэх
    await pool.query(
      'UPDATE cameras SET last_active = NOW(), is_online = true WHERE id = $1',
      [camera.id]
    );

  } catch (error) {
    console.error(`❌ Stream capture error (camera ${camera.id}):`, error.message);

    // Error log хадгалах
    await pool.query(
      `INSERT INTO camera_logs (camera_id, timestamp, status, error_message)
       VALUES ($1, NOW(), $2, $3)`,
      [camera.id, 'error', error.message]
    );

    // Video статус шинэчлэх
    if (videoId) {
      await pool.query(
        'UPDATE videos SET status = $1, error_message = $2 WHERE id = $3',
        ['failed', error.message, videoId]
      );
    }

  } finally {
    // Локал файл устгах
    if (localVideoPath) {
      try {
        await fs.unlink(localVideoPath);
      } catch (err) {
        console.error('Failed to delete temp video:', err.message);
      }
    }
  }
}

// Startup: Load and start all active cameras
async function initializeActiveCameras() {
  try {
    const result = await pool.query(
      "SELECT * FROM cameras WHERE status = 'active'"
    );

    console.log(`📡 ${result.rowCount} идэвхтэй камер байна`);

    for (const camera of result.rows) {
      startCameraMonitoring(camera);
    }

  } catch (error) {
    console.error('Failed to initialize cameras:', error);
  }
}

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'camera-service',
    activeCameras: activeCameraStreams.size,
    timestamp: new Date().toISOString()
  });
});

app.listen(PORT, () => {
  console.log(`📹 Camera Service запущен на порту ${PORT}`);
  console.log(`⏱️  Stream interval: ${STREAM_INTERVAL / 1000}s`);
  console.log(`🎬 Stream duration: ${STREAM_DURATION}s`);
  
  // Initialize cameras after 5 seconds
  setTimeout(initializeActiveCameras, 5000);
});

module.exports = app;