/**
 * Camera Service - REST API
 * Port: 3008
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { pool } = require('./config/database');
const {
  startCameraMonitoring,
  stopCameraMonitoring,
  startAllCameras,
  stopAllCameras,
  getMonitoringStatus,
  restartCamera
} = require('./services/cameraService');
const logger = require('./utils/logger');

const app = express();
const PORT = process.env.PORT || 3008;

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());

// Request logging
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.path}`);
  next();
});

// ==========================================
// CAMERA MANAGEMENT
// ==========================================

/**
 * GET /cameras - Бүх камерын жагсаалт
 */
app.get('/cameras', async (req, res) => {
  try {
    const status = await getMonitoringStatus();
    res.json({
      success: true,
      cameras: status,
      count: status.length
    });
  } catch (error) {
    logger.error('Get cameras error:', error);
    res.status(500).json({
      success: false,
      error: 'Камер авахад алдаа гарлаа'
    });
  }
});

/**
 * GET /cameras/:id - Камерын дэлгэрэнгүй
 */
app.get('/cameras/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(`
      SELECT 
        c.*,
        cls.total_frames,
        cls.total_detections,
        cls.potential_accidents,
        cls.last_detection_time,
        cls.accidents_created
      FROM cameras c
      LEFT JOIN camera_live_stats cls ON c.id = cls.id
      WHERE c.id = $1
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Камер олдсонгүй'
      });
    }

    const camera = result.rows[0];

    res.json({
      success: true,
      data: camera
    });
    
  } catch (error) {
    logger.error('Get camera error:', error);
    res.status(500).json({
      success: false,
      error: 'Камер авахад алдаа гарлаа'
    });
  }
});

/**
 * POST /cameras - Шинэ камер нэмэх
 */
app.post('/cameras', async (req, res) => {
  try {
    const {
      name,
      location,
      latitude,
      longitude,
      stream_url,
      stream_type,
      resolution,
      fps,
      description
    } = req.body;

    if (!name || !location || !latitude || !longitude || !stream_url) {
      return res.status(400).json({
        success: false,
        error: 'name, location, latitude, longitude, stream_url шаардлагатай'
      });
    }

    // Determine stream type
    const type = stream_type || (stream_url.includes('.m3u8') ? 'hls' : 'rtsp');

    const result = await pool.query(`
      INSERT INTO cameras (
        name, location, latitude, longitude,
        stream_url, stream_type, resolution, fps,
        description, status, is_online
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active', false)
      RETURNING *
    `, [
      name, location, latitude, longitude,
      stream_url, type, resolution || '480p', fps || 25,
      description
    ]);

    const camera = result.rows[0];

    res.status(201).json({
      success: true,
      message: 'Камер амжилттай нэмэгдлээ',
      data: camera
    });
    
  } catch (error) {
    logger.error('Create camera error:', error);
    res.status(500).json({
      success: false,
      error: 'Камер нэмэхэд алдаа гарлаа'
    });
  }
});

/**
 * PUT /cameras/:id - Камер шинэчлэх
 */
app.put('/cameras/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      name,
      location,
      latitude,
      longitude,
      stream_url,
      resolution,
      fps,
      description,
      status
    } = req.body;

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
    if (latitude) {
      updates.push(`latitude = $${paramIndex++}`);
      values.push(latitude);
    }
    if (longitude) {
      updates.push(`longitude = $${paramIndex++}`);
      values.push(longitude);
    }
    if (stream_url) {
      updates.push(`stream_url = $${paramIndex++}`);
      values.push(stream_url);
      
      // Update stream type based on URL
      const type = stream_url.includes('.m3u8') ? 'hls' : 'rtsp';
      updates.push(`stream_type = $${paramIndex++}`);
      values.push(type);
    }
    if (resolution) {
      updates.push(`resolution = $${paramIndex++}`);
      values.push(resolution);
    }
    if (fps) {
      updates.push(`fps = $${paramIndex++}`);
      values.push(fps);
    }
    if (description !== undefined) {
      updates.push(`description = $${paramIndex++}`);
      values.push(description);
    }
    if (status) {
      updates.push(`status = $${paramIndex++}`);
      values.push(status);
    }

    if (updates.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Өөрчлөх мэдээлэл байхгүй'
      });
    }

    updates.push(`updated_at = NOW()`);
    values.push(id);

    const query = `
      UPDATE cameras 
      SET ${updates.join(', ')}
      WHERE id = $${paramIndex}
      RETURNING *
    `;

    const result = await pool.query(query, values);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Камер олдсонгүй'
      });
    }

    res.json({
      success: true,
      message: 'Камер шинэчлэгдлээ',
      data: result.rows[0]
    });
    
  } catch (error) {
    logger.error('Update camera error:', error);
    res.status(500).json({
      success: false,
      error: 'Камер шинэчлэхэд алдаа гарлаа'
    });
  }
});

/**
 * DELETE /cameras/:id - Камер устгах
 */
app.delete('/cameras/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Stop monitoring first
    await stopCameraMonitoring(parseInt(id));

    // Delete from database
    const result = await pool.query(`
      DELETE FROM cameras WHERE id = $1 RETURNING id
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Камер олдсонгүй'
      });
    }

    res.json({
      success: true,
      message: 'Камер устгагдлаа'
    });
    
  } catch (error) {
    logger.error('Delete camera error:', error);
    res.status(500).json({
      success: false,
      error: 'Камер устгахад алдаа гарлаа'
    });
  }
});

// ==========================================
// CAMERA CONTROL
// ==========================================

/**
 * POST /cameras/:id/start - Камер эхлүүлэх
 */
app.post('/cameras/:id/start', async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(`
      SELECT * FROM cameras WHERE id = $1
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Камер олдсонгүй'
      });
    }

    const camera = result.rows[0];

    // Start monitoring
    await startCameraMonitoring(camera);

    res.json({
      success: true,
      message: 'Камер эхэллээ'
    });
    
  } catch (error) {
    logger.error('Start camera error:', error);
    res.status(500).json({
      success: false,
      error: 'Камер эхлүүлэхэд алдаа гарлаа'
    });
  }
});

/**
 * POST /cameras/:id/stop - Камер зогсоох
 */
app.post('/cameras/:id/stop', async (req, res) => {
  try {
    const { id } = req.params;

    await stopCameraMonitoring(parseInt(id));

    res.json({
      success: true,
      message: 'Камер зогслоо'
    });
    
  } catch (error) {
    logger.error('Stop camera error:', error);
    res.status(500).json({
      success: false,
      error: 'Камер зогсоохоо алдаа гарлаа'
    });
  }
});

/**
 * POST /cameras/:id/restart - Камер дахин эхлүүлэх
 */
app.post('/cameras/:id/restart', async (req, res) => {
  try {
    const { id } = req.params;

    const success = await restartCamera(parseInt(id));

    if (success) {
      res.json({
        success: true,
        message: 'Камер дахин эхэллээ'
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Камер дахин эхлүүлэхэд алдаа гарлаа'
      });
    }
    
  } catch (error) {
    logger.error('Restart camera error:', error);
    res.status(500).json({
      success: false,
      error: 'Камер дахин эхлүүлэхэд алдаа гарлаа'
    });
  }
});

// ==========================================
// CAMERA STATISTICS
// ==========================================

/**
 * GET /cameras/:id/detections - Камерын detections
 */
app.get('/cameras/:id/detections', async (req, res) => {
  try {
    const { id } = req.params;
    const { limit = 50, offset = 0, startDate, endDate } = req.query;

    let query = `
      SELECT 
        cd.*,
        cf.timestamp as frame_timestamp,
        cf.image_path
      FROM camera_detections cd
      LEFT JOIN camera_frames cf ON cd.frame_id = cf.id
      WHERE cd.camera_id = $1
    `;

    const params = [id];
    let paramIndex = 2;

    if (startDate) {
      query += ` AND cd.detection_time >= $${paramIndex++}`;
      params.push(startDate);
    }

    if (endDate) {
      query += ` AND cd.detection_time <= $${paramIndex++}`;
      params.push(endDate);
    }

    query += `
      ORDER BY cd.detection_time DESC
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}
    `;

    params.push(parseInt(limit), parseInt(offset));

    const result = await pool.query(query, params);

    res.json({
      success: true,
      data: result.rows,
      pagination: {
        limit: parseInt(limit),
        offset: parseInt(offset),
        total: result.rowCount
      }
    });
    
  } catch (error) {
    logger.error('Get detections error:', error);
    res.status(500).json({
      success: false,
      error: 'Detections авахад алдаа гарлаа'
    });
  }
});

/**
 * GET /cameras/:id/stats - Камерын статистик
 */
app.get('/cameras/:id/stats', async (req, res) => {
  try {
    const { id } = req.params;
    const { period = '24h' } = req.query;

    // Determine time interval
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
        COUNT(DISTINCT cf.id) as total_frames,
        COUNT(DISTINCT cd.id) as total_detections,
        COUNT(DISTINCT cd.id) FILTER (WHERE cd.potential_accident = true) as potential_accidents,
        COUNT(DISTINCT a.id) as accidents_created,
        AVG(cd.confidence) as avg_confidence,
        json_agg(DISTINCT cd.object_class) as detected_classes
      FROM cameras c
      LEFT JOIN camera_frames cf ON c.id = cf.camera_id 
        AND cf.timestamp >= NOW() - INTERVAL '${interval}'
      LEFT JOIN camera_detections cd ON c.id = cd.camera_id 
        AND cd.detection_time >= NOW() - INTERVAL '${interval}'
      LEFT JOIN accidents a ON c.id = a.camera_id 
        AND a.accident_time >= NOW() - INTERVAL '${interval}'
      WHERE c.id = $1
      GROUP BY c.id
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Камер олдсонгүй'
      });
    }

    res.json({
      success: true,
      period,
      data: result.rows[0]
    });
    
  } catch (error) {
    logger.error('Get camera stats error:', error);
    res.status(500).json({
      success: false,
      error: 'Статистик авахад алдаа гарлаа'
    });
  }
});

// ==========================================
// SYSTEM MANAGEMENT
// ==========================================

/**
 * POST /system/start-all - Бүх камер эхлүүлэх
 */
app.post('/system/start-all', async (req, res) => {
  try {
    await startAllCameras();

    res.json({
      success: true,
      message: 'Бүх камер эхэллээ'
    });
  } catch (error) {
    logger.error('Start all cameras error:', error);
    res.status(500).json({
      success: false,
      error: 'Камер эхлүүлэхэд алдаа гарлаа'
    });
  }
});

/**
 * POST /system/stop-all - Бүх камер зогсоох
 */
app.post('/system/stop-all', async (req, res) => {
  try {
    await stopAllCameras();

    res.json({
      success: true,
      message: 'Бүх камер зогслоо'
    });
  } catch (error) {
    logger.error('Stop all cameras error:', error);
    res.status(500).json({
      success: false,
      error: 'Камер зогсоохоо алдаа гарлаа'
    });
  }
});

// ==========================================
// HEALTH CHECK
// ==========================================

app.get('/health', async (req, res) => {
  const health = {
    status: 'healthy',
    service: 'camera-service',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    port: PORT
  };

  // Don't fail health check if DB is temporarily down
  try {
    await Promise.race([
      pool.query('SELECT 1'),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('timeout')), 2000)
      )
    ]);
    health.database = 'connected';
  } catch (err) {
    health.database = 'disconnected';
    // Only fail if service just started
    if (process.uptime() < 30) {
      health.status = 'unhealthy';
    }
  }

  // Always return 200 for basic connectivity
  res.status(200).json(health);
});

// Add simple ping endpoint
app.get('/ping', (req, res) => {
  res.json({ ok: true });
});

// Error handler
app.use((err, req, res, next) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({
    success: false,
    error: process.env.NODE_ENV === 'production' 
      ? 'Серверийн алдаа гарлаа' 
      : err.message
  });
});

// ==========================================
// START SERVER
// ==========================================

app.listen(PORT, () => {
  logger.info(`📹 Camera Service running on port ${PORT}`);
  logger.info(`⏱️  Stream interval: ${process.env.STREAM_INTERVAL || 300}s`);
  logger.info(`🎬 Stream duration: ${process.env.STREAM_DURATION || 30}s`);
  logger.info(`💓 Health check interval: ${process.env.HEALTH_CHECK_INTERVAL || 60}s`);
  
  // Start camera monitoring
  startAllCameras();
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, stopping cameras...');
  await stopAllCameras();
  await pool.end();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, stopping cameras...');
  await stopAllCameras();
  await pool.end();
  process.exit(0);
});

module.exports = app;