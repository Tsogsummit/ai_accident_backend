require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { pool } = require('./config/database');
const { redis } = require('./config/redis');
const logger = require('./utils/logger');
const CameraStreamMonitor = require('./services/cameraStreamMonitor');

const app = express();
const PORT = process.env.PORT || 3008;

// Initialize Camera Stream Monitor
let streamMonitor;
const initializeStreamMonitor = async () => {
  try {
    streamMonitor = new CameraStreamMonitor(pool, redis);
    await streamMonitor.start();
    logger.info('✅ Camera Stream Monitor initialized');
  } catch (error) {
    logger.error(`Failed to initialize stream monitor: ${error.message}`);
  }
};

app.use(helmet());
app.use(cors());
app.use(express.json());

app.use((req, res, next) => {
  logger.info(`${req.method} ${req.path}`);
  next();
});

// GET /cameras
app.get('/cameras', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT c.*,
        COUNT(DISTINCT a.id) FILTER (WHERE a.accident_time >= NOW() - INTERVAL '24 hours') as accidents_24h,
        COUNT(DISTINCT a.id) as total_accidents,
        MAX(a.accident_time) as last_accident_time
      FROM cameras c
      LEFT JOIN accidents a ON c.id = a.camera_id
      GROUP BY c.id
      ORDER BY c.id
    `);
    res.json({ success: true, cameras: result.rows, count: result.rows.length });
  } catch (error) {
    logger.error('Get cameras error:', error);
    res.status(500).json({ success: false, error: 'Камер авахад алдаа гарлаа' });
  }
});

// GET /cameras/:id
app.get('/cameras/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(`
      SELECT c.*,
        COUNT(DISTINCT a.id) FILTER (WHERE a.accident_time >= NOW() - INTERVAL '24 hours') as accidents_24h,
        COUNT(DISTINCT a.id) as total_accidents,
        MAX(a.accident_time) as last_accident_time
      FROM cameras c
      LEFT JOIN accidents a ON c.id = a.camera_id
      WHERE c.id = $1
      GROUP BY c.id
    `, [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Камер олдсонгүй' });
    }
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    logger.error('Get camera error:', error);
    res.status(500).json({ success: false, error: 'Камер авахад алдаа гарлаа' });
  }
});

// POST /cameras
app.post('/cameras', async (req, res) => {
  try {
    const { name, location, latitude, longitude, stream_url, resolution, fps, ip_address, description, status } = req.body;
    if (!name || !location || !latitude || !longitude || !stream_url) {
      return res.status(400).json({ success: false, error: 'name, location, latitude, longitude, stream_url шаардлагатай' });
    }
    const stream_type = stream_url.includes('.m3u8') ? 'hls' : 'rtsp';
    const result = await pool.query(`
      INSERT INTO cameras (name, location, latitude, longitude, stream_url, stream_type, resolution, fps, ip_address, description, status, is_online)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, false)
      RETURNING *
    `, [name, location, latitude, longitude, stream_url, stream_type, resolution || '720p', fps || 25, ip_address, description, status || 'active']);

    // Reload cameras in monitor
    if (streamMonitor && status === 'active') {
      await streamMonitor.loadActiveCameras();
    }

    res.status(201).json({ success: true, message: 'Камер амжилттай нэмэгдлээ', data: result.rows[0] });
  } catch (error) {
    logger.error('Create camera error:', error);
    res.status(500).json({ success: false, error: 'Камер нэмэхэд алдаа гарлаа' });
  }
});

// PUT /cameras/:id
app.put('/cameras/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, location, latitude, longitude, stream_url, resolution, fps, ip_address, description, status } = req.body;
    const updates = [];
    const values = [];
    let idx = 1;
    if (name) { updates.push(`name = $${idx++}`); values.push(name); }
    if (location) { updates.push(`location = $${idx++}`); values.push(location); }
    if (latitude) { updates.push(`latitude = $${idx++}`); values.push(latitude); }
    if (longitude) { updates.push(`longitude = $${idx++}`); values.push(longitude); }
    if (stream_url) {
      updates.push(`stream_url = $${idx++}`);
      values.push(stream_url);
      const type = stream_url.includes('.m3u8') ? 'hls' : 'rtsp';
      updates.push(`stream_type = $${idx++}`);
      values.push(type);
    }
    if (resolution) { updates.push(`resolution = $${idx++}`); values.push(resolution); }
    if (fps) { updates.push(`fps = $${idx++}`); values.push(fps); }
    if (ip_address !== undefined) { updates.push(`ip_address = $${idx++}`); values.push(ip_address); }
    if (description !== undefined) { updates.push(`description = $${idx++}`); values.push(description); }
    if (status) { updates.push(`status = $${idx++}`); values.push(status); }
    if (updates.length === 0) {
      return res.status(400).json({ success: false, error: 'Өөрчлөх мэдээлэл байхгүй' });
    }
    updates.push(`updated_at = NOW()`);
    values.push(id);
    const result = await pool.query(`UPDATE cameras SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`, values);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Камер олдсонгүй' });
    }

    // Reload cameras in monitor
    if (streamMonitor) {
      await streamMonitor.loadActiveCameras();
    }

    res.json({ success: true, message: 'Камер шинэчлэгдлээ', data: result.rows[0] });
  } catch (error) {
    logger.error('Update camera error:', error);
    res.status(500).json({ success: false, error: 'Камер шинэчлэхэд алдаа гарлаа' });
  }
});

// DELETE /cameras/:id
app.delete('/cameras/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM cameras WHERE id = $1 RETURNING id', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Камер олдсонгүй' });
    }

    // Reload cameras in monitor
    if (streamMonitor) {
      await streamMonitor.loadActiveCameras();
    }

    res.json({ success: true, message: 'Камер устгагдлаа' });
  } catch (error) {
    logger.error('Delete camera error:', error);
    res.status(500).json({ success: false, error: 'Камер устгахад алдаа гарлаа' });
  }
});

// POST /cameras/:id/start
app.post('/cameras/:id/start', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('UPDATE cameras SET status = $1, is_online = true, updated_at = NOW() WHERE id = $2', ['active', id]);

    // Reload cameras in monitor
    if (streamMonitor) {
      await streamMonitor.loadActiveCameras();
    }

    res.json({ success: true, message: 'Камер эхэллээ' });
  } catch (error) {
    logger.error('Start camera error:', error);
    res.status(500).json({ success: false, error: 'Камер эхлүүлэхэд алдаа гарлаа' });
  }
});

// POST /cameras/:id/stop
app.post('/cameras/:id/stop', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('UPDATE cameras SET status = $1, is_online = false, updated_at = NOW() WHERE id = $2', ['inactive', id]);

    // Reload cameras in monitor
    if (streamMonitor) {
      await streamMonitor.loadActiveCameras();
    }

    res.json({ success: true, message: 'Камер зогслоо' });
  } catch (error) {
    logger.error('Stop camera error:', error);
    res.status(500).json({ success: false, error: 'Камер зогсоохоо алдаа гарлаа' });
  }
});

// POST /cameras/:id/restart
app.post('/cameras/:id/restart', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('UPDATE cameras SET status = $1, is_online = true, updated_at = NOW() WHERE id = $2', ['active', id]);

    // Reload cameras in monitor
    if (streamMonitor) {
      await streamMonitor.loadActiveCameras();
    }

    res.json({ success: true, message: 'Камер дахин эхэллээ' });
  } catch (error) {
    logger.error('Restart camera error:', error);
    res.status(500).json({ success: false, error: 'Камер дахин эхлүүлэхэд алдаа гарлаа' });
  }
});

// ✅ NEW: POST /cameras/:id/process-now - Manually trigger camera processing
app.post('/cameras/:id/process-now', async (req, res) => {
  try {
    const { id } = req.params;

    if (!streamMonitor) {
      return res.status(503).json({ success: false, error: 'Stream monitor not initialized' });
    }

    const camera = streamMonitor.activeCameras.get(parseInt(id));
    if (!camera) {
      return res.status(404).json({ success: false, error: 'Camera not found or not active' });
    }

    // Trigger processing in background
    streamMonitor.processCamera(camera).catch(err => {
      logger.error(`Manual processing failed for camera ${id}: ${err.message}`);
    });

    res.json({ success: true, message: 'Камерын боловсруулалт эхэллээ' });
  } catch (error) {
    logger.error('Process camera error:', error);
    res.status(500).json({ success: false, error: 'Камер боловсруулахад алдаа гарлаа' });
  }
});

// GET /cameras/:id/stats
app.get('/cameras/:id/stats', async (req, res) => {
  try {
    const { id } = req.params;
    const { period = '24h' } = req.query;
    let interval;
    switch (period) {
      case '1h': interval = '1 hour'; break;
      case '24h': interval = '24 hours'; break;
      case '7d': interval = '7 days'; break;
      case '30d': interval = '30 days'; break;
      default: interval = '24 hours';
    }
    const result = await pool.query(`
      SELECT
        COUNT(DISTINCT a.id) as total_accidents,
        COUNT(DISTINCT a.id) FILTER (WHERE a.status = 'confirmed') as confirmed_accidents,
        AVG(a.verification_count) as avg_verification
      FROM cameras c
      LEFT JOIN accidents a ON c.id = a.camera_id AND a.accident_time >= NOW() - INTERVAL '${interval}'
      WHERE c.id = $1
      GROUP BY c.id
    `, [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Камер олдсонгүй' });
    }
    res.json({ success: true, period, data: result.rows[0] });
  } catch (error) {
    logger.error('Get camera stats error:', error);
    res.status(500).json({ success: false, error: 'Статистик авахад алдаа гарлаа' });
  }
});

// Health check
app.get('/health', async (req, res) => {
  const health = {
    status: 'healthy',
    service: 'camera-service',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    port: PORT,
    streamMonitor: streamMonitor ? 'running' : 'not initialized'
  };
  try {
    await Promise.race([pool.query('SELECT 1'), new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000))]);
    health.database = 'connected';
  } catch (err) {
    health.database = 'disconnected';
    if (process.uptime() < 30) health.status = 'unhealthy';
  }

  try {
    await redis.ping();
    health.redis = 'connected';
  } catch (err) {
    health.redis = 'disconnected';
  }

  res.status(200).json(health);
});

app.get('/ping', (req, res) => res.json({ ok: true }));

// GET /admin/stats - Admin dashboard statistics
app.get('/admin/stats', async (req, res) => {
  try {
    const { period = '24h' } = req.query;
    let interval;
    switch (period) {
      case '1h': interval = '1 hour'; break;
      case '24h': interval = '24 hours'; break;
      case '7d': interval = '7 days'; break;
      case '30d': interval = '30 days'; break;
      case 'all': interval = null; break;
      default: interval = '24 hours';
    }

    // Query for statistics
    const statsQuery = interval
      ? `
        SELECT
          COUNT(DISTINCT v.id) as total_videos_processed,
          COUNT(DISTINCT v.id) FILTER (WHERE v.created_at >= NOW() - INTERVAL '${interval}') as videos_in_period,
          COUNT(DISTINCT a.id) as total_ai_detections,
          COUNT(DISTINCT a.id) FILTER (WHERE a.accident_time >= NOW() - INTERVAL '${interval}') as detections_in_period,
          COUNT(DISTINCT a.id) FILTER (WHERE a.source='camera' AND a.status='confirmed') as confirmed_detections,
          COUNT(DISTINCT c.id) FILTER (WHERE c.stream_type='hls' AND c.status='active') as active_cameras,
          COUNT(DISTINCT c.id) FILTER (WHERE c.last_active >= NOW() - INTERVAL '15 minutes') as recently_processed_cameras
        FROM cameras c
        LEFT JOIN accidents a ON c.id = a.camera_id AND a.source = 'camera'
        LEFT JOIN videos v ON a.video_id = v.id AND v.camera_id IS NOT NULL
      `
      : `
        SELECT
          COUNT(DISTINCT v.id) as total_videos_processed,
          COUNT(DISTINCT v.id) as videos_in_period,
          COUNT(DISTINCT a.id) as total_ai_detections,
          COUNT(DISTINCT a.id) as detections_in_period,
          COUNT(DISTINCT a.id) FILTER (WHERE a.source='camera' AND a.status='confirmed') as confirmed_detections,
          COUNT(DISTINCT c.id) FILTER (WHERE c.stream_type='hls' AND c.status='active') as active_cameras,
          COUNT(DISTINCT c.id) FILTER (WHERE c.last_active >= NOW() - INTERVAL '15 minutes') as recently_processed_cameras
        FROM cameras c
        LEFT JOIN accidents a ON c.id = a.camera_id AND a.source = 'camera'
        LEFT JOIN videos v ON a.video_id = v.id AND v.camera_id IS NOT NULL
      `;

    const result = await pool.query(statsQuery);
    const stats = result.rows[0];

    // Get recent processing activity
    const recentActivity = await pool.query(`
      SELECT
        c.id,
        c.name,
        c.last_active,
        COUNT(DISTINCT a.id) FILTER (WHERE a.accident_time >= NOW() - INTERVAL '24 hours') as accidents_24h
      FROM cameras c
      LEFT JOIN accidents a ON c.id = a.camera_id AND a.source = 'camera'
      WHERE c.stream_type = 'hls' AND c.status = 'active'
      GROUP BY c.id, c.name, c.last_active
      ORDER BY c.last_active DESC NULLS LAST
      LIMIT 10
    `);

    // Calculate detection rate
    const detectionRate = stats.total_videos_processed > 0
      ? ((stats.total_ai_detections / stats.total_videos_processed) * 100).toFixed(2)
      : 0;

    res.json({
      success: true,
      period: interval || 'all',
      stats: {
        totalVideosProcessed: parseInt(stats.total_videos_processed) || 0,
        videosInPeriod: parseInt(stats.videos_in_period) || 0,
        totalAiDetections: parseInt(stats.total_ai_detections) || 0,
        detectionsInPeriod: parseInt(stats.detections_in_period) || 0,
        confirmedDetections: parseInt(stats.confirmed_detections) || 0,
        activeCameras: parseInt(stats.active_cameras) || 0,
        recentlyProcessedCameras: parseInt(stats.recently_processed_cameras) || 0,
        detectionRate: parseFloat(detectionRate)
      },
      recentActivity: recentActivity.rows,
      streamMonitor: {
        status: streamMonitor ? 'running' : 'not initialized',
        activeCamerasMonitored: streamMonitor ? streamMonitor.activeCameras.size : 0,
        currentlyProcessing: streamMonitor ? streamMonitor.processingLocks.size : 0
      }
    });
  } catch (error) {
    logger.error('Get admin stats error:', error);
    res.status(500).json({ success: false, error: 'Статистик авахад алдаа гарлаа' });
  }
});

app.use((err, req, res, next) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({ success: false, error: process.env.NODE_ENV === 'production' ? 'Серверийн алдаа гарлаа' : err.message });
});

app.listen(PORT, async () => {
  logger.info(`📹 Camera Service running on port ${PORT}`);
  logger.info(`📊 Database: ${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || 5432}`);
  logger.info(`📡 Redis: ${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || 6379}`);

  // Initialize stream monitor after server starts
  await initializeStreamMonitor();
});

process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down...');
  if (streamMonitor) streamMonitor.stop();
  await pool.end();
  await redis.quit();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down...');
  if (streamMonitor) streamMonitor.stop();
  await pool.end();
  await redis.quit();
  process.exit(0);
});

module.exports = app;
