const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const Redis = require('ioredis');
const helmet = require('helmet');
const cors = require('cors');
const path = require('path');
const axios = require('axios');
const app = express();
const PORT = process.env.PORT || 3009;
app.use(helmet({
  contentSecurityPolicy: false,
}));
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
  credentials: true
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'accident_db',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});
pool.on('error', (err) => console.error('PostgreSQL pool error:', err));
const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: process.env.REDIS_PORT || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
  retryStrategy: (times) => {
    if (times > 10) {
      console.error('Redis: Max retries reached, giving up');
      return null;
    }
    const delay = Math.min(times * 50, 2000);
    console.log(`Redis: Retry attempt ${times}, waiting ${delay}ms`);
    return delay;
  },
  maxRetriesPerRequest: 3,
  enableOfflineQueue: false,
});
redis.on('error', (err) => console.error('Redis error:', err));
redis.on('connect', () => console.log('✅ Redis connected'));
const JWT_SECRET = process.env.JWT_SECRET || 'your-admin-secret-key';
const BCRYPT_ROUNDS = 12;
const CAMERA_SERVICE_URL = process.env.CAMERA_SERVICE_URL || 'http://camera-service:3009';
const authenticateAdmin = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) {
    return res.status(401).json({ success: false, error: 'Нэвтрэх шаардлагатай' });
  }
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ success: false, error: 'Буруу токен' });
    }
    if (user.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Админ эрх шаардлагатай' });
    }
    req.user = user;
    next();
  });
};
app.post('/admin/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({
        success: false,
        error: 'Username болон password шаардлагатай'
      });
    }
    const result = await pool.query(`
      SELECT a.*, u.password_hash, u.role, u.name, u.email
      FROM admins a
      JOIN users u ON a.user_id = u.id
      WHERE a.username = $1 AND u.role = 'admin'
    `, [username]);
    if (result.rows.length === 0) {
      return res.status(401).json({
        success: false,
        error: 'Нэвтрэх нэр эсвэл нууц үг буруу'
      });
    }
    const admin = result.rows[0];
    const isValid = await bcrypt.compare(password, admin.password_hash);
    if (!isValid) {
      return res.status(401).json({
        success: false,
        error: 'Нэвтрэх нэр эсвэл нууц үг буруу'
      });
    }
    const token = jwt.sign(
      {
        userId: admin.user_id,
        adminId: admin.id,
        username: admin.username,
        role: 'admin',
        permissions: admin.permissions
      },
      JWT_SECRET,
      { expiresIn: '24h' }
    );
    await pool.query('UPDATE admins SET last_login = NOW() WHERE id = $1', [admin.id]);
    res.json({
      success: true,
      message: 'Амжилттай нэвтэрлээ',
      token,
      admin: {
        id: admin.id,
        username: admin.username,
        name: admin.name,
        email: admin.email,
        permissions: admin.permissions,
      }
    });
  } catch (error) {
    console.error('Admin login error:', error);
    res.status(500).json({ success: false, error: 'Нэвтрэхэд алдаа гарлаа' });
  }
});
app.get('/admin/dashboard/stats', authenticateAdmin, async (req, res) => {
  try {
    const cacheKey = 'admin:dashboard:stats';
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        return res.json({ success: true, source: 'cache', data: JSON.parse(cached) });
      }
    } catch (redisErr) {
      console.warn('Redis cache read failed:', redisErr.message);
    }
    const [
      totalAccidents, activeAccidents, todayAccidents,
      totalUsers,
      totalCameras, onlineCameras,
      totalVideos, pendingVideos,
      aiAccuracy
    ] = await Promise.all([
      pool.query("SELECT COUNT(*) as count FROM accidents WHERE status = 'confirmed'"),
      pool.query("SELECT COUNT(*) as count FROM accidents WHERE status IN ('reported', 'confirmed')"),
      pool.query("SELECT COUNT(*) as count FROM accidents WHERE status = 'confirmed' AND accident_time >= CURRENT_DATE"),
      pool.query('SELECT COUNT(*) as count FROM users'),
      pool.query('SELECT COUNT(*) as count FROM cameras'),
      pool.query('SELECT COUNT(*) as count FROM cameras WHERE is_online = true'),
      pool.query('SELECT COUNT(*) as count FROM videos'),
      pool.query("SELECT COUNT(*) as count FROM videos WHERE status IN ('uploading', 'processing')"),
      pool.query(`
        SELECT 
          COUNT(DISTINCT CASE WHEN a.status = 'confirmed' THEN a.id END) as confirmed,
          COUNT(DISTINCT CASE WHEN a.status = 'false_alarm' THEN a.id END) as false_alarms,
          AVG(aid.confidence)::float as avg_confidence
        FROM accidents a
        LEFT JOIN videos v ON a.video_id = v.id
        LEFT JOIN ai_detections aid ON v.id = aid.video_id
        WHERE a.source = 'camera' AND a.accident_time >= NOW() - INTERVAL '7 days'
      `)
    ]);
    const aiStats = aiAccuracy.rows[0];
    const confirmed = parseInt(aiStats.confirmed) || 0;
    const falseAlarms = parseInt(aiStats.false_alarms) || 0;
    const accuracy = confirmed + falseAlarms > 0
      ? ((confirmed / (confirmed + falseAlarms)) * 100).toFixed(1)
      : 0;
    const stats = {
      accidents: {
        total: parseInt(totalAccidents.rows[0].count),
        active: parseInt(activeAccidents.rows[0].count),
        today: parseInt(todayAccidents.rows[0].count),
      },
      users: {
        total: parseInt(totalUsers.rows[0].count),
      },
      cameras: {
        total: parseInt(totalCameras.rows[0].count),
        online: parseInt(onlineCameras.rows[0].count),
      },
      videos: {
        total: parseInt(totalVideos.rows[0].count),
        pending: parseInt(pendingVideos.rows[0].count),
      },
      ai: {
        accuracy: `${accuracy}%`,
        avgConfidence: parseFloat(aiStats.avg_confidence)?.toFixed(2) || 0,
        confirmed,
        falseAlarms,
      }
    };
    try {
      await redis.setex(cacheKey, 60, JSON.stringify(stats));
    } catch (redisErr) {
      console.warn('Redis cache write failed:', redisErr.message);
    }
    res.json({ success: true, source: 'database', data: stats });
  } catch (error) {
    console.error('Dashboard stats error:', error);
    res.status(500).json({ success: false, error: 'Статистик авахад алдаа гарлаа' });
  }
});
app.get('/admin/accidents', authenticateAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 50, status, source } = req.query;
    const offset = (page - 1) * limit;
    let query = `
      SELECT a.*, u.name as reported_by_name, u.phone as reported_by_phone,
             c.name as camera_name, COUNT(DISTINCT fr.id) as false_report_count,
             AVG(aid.confidence)::float as avg_confidence
      FROM accidents a
      LEFT JOIN users u ON a.user_id = u.id
      LEFT JOIN cameras c ON a.camera_id = c.id
      LEFT JOIN false_reports fr ON a.id = fr.accident_id
      LEFT JOIN videos v ON a.video_id = v.id
      LEFT JOIN ai_detections aid ON v.id = aid.video_id
      WHERE 1=1
    `;
    const params = [];
    let paramIndex = 1;
    if (status) {
      query += ` AND a.status = $${paramIndex++}`;
      params.push(status);
    }
    if (source) {
      query += ` AND a.source = $${paramIndex++}`;
      params.push(source);
    }
    query += `
      GROUP BY a.id, u.name, u.phone, c.name
      ORDER BY a.accident_time DESC
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}
    `;
    params.push(parseInt(limit), parseInt(offset));
    const [accidents, totalCount] = await Promise.all([
      pool.query(query, params),
      pool.query('SELECT COUNT(*) FROM accidents')
    ]);
    res.json({
      success: true,
      data: accidents.rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: parseInt(totalCount.rows[0].count),
        totalPages: Math.ceil(parseInt(totalCount.rows[0].count) / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('Get accidents error:', error);
    res.status(500).json({ success: false, error: 'Ослын мэдээлэл авахад алдаа гарлаа' });
  }
});
app.put('/admin/accidents/:id/status', authenticateAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const validStatuses = ['reported', 'confirmed', 'resolved', 'false_alarm'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, error: 'Буруу төлөв' });
    }
    const result = await pool.query(`
      UPDATE accidents SET status = $1, updated_at = NOW()
      WHERE id = $2 RETURNING *
    `, [status, id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Осол олдсонгүй' });
    }
    const accident = result.rows[0];
    redis.del('admin:dashboard:stats').catch(err =>
      console.warn('Cache clear failed:', err.message)
    );
    if (status === 'false_alarm') {
      try {
        const notifiedUsersResult = await pool.query(`
          SELECT DISTINCT user_id
          FROM notifications
          WHERE accident_id = $1 AND type = 'accident_confirmed'
        `, [id]);
        const userIds = notifiedUsersResult.rows.map(row => row.user_id);
        if (userIds.length > 0) {
          const notificationServiceUrl = process.env.NOTIFICATION_SERVICE_URL || 'http://notification-service:3005';
          const axios = require('axios');
          await axios.post(
            `${notificationServiceUrl}/notifications/send`,
            {
              userIds: userIds,
              accidentId: parseInt(id),
              type: 'false_alarm',
              title: '⚠️ Буруу мэдээлэл баталгаажлаа',
              message: `Осол #${id} буруу мэдээлэл гэж админ баталгаажууллаа.`,
              data: {
                latitude: String(accident.latitude),
                longitude: String(accident.longitude),
                accidentId: String(id),
                status: 'false_alarm'
              }
            },
            { timeout: 10000 }
          );
          console.log(`✅ False alarm notification sent to ${userIds.length} users by admin`);
        }
      } catch (notifyErr) {
        console.error('⚠️ Failed to send false alarm notification:', notifyErr.message);
      }
    }
    res.json({ success: true, message: 'Төлөв шинэчлэгдлээ', data: accident });
  } catch (error) {
    console.error('Update accident status error:', error);
    res.status(500).json({ success: false, error: 'Төлөв шинэчлэхэд алдаа гарлаа' });
  }
});
app.delete('/admin/accidents/:id', authenticateAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM accidents WHERE id = $1 RETURNING id', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Осол олдсонгүй' });
    }
    redis.del('admin:dashboard:stats').catch(err => console.warn('Cache clear failed:', err.message));
    res.json({ success: true, message: 'Осол устгагдлаа' });
  } catch (error) {
    console.error('Delete accident error:', error);
    res.status(500).json({ success: false, error: 'Осол устгахад алдаа гарлаа' });
  }
});
app.get('/admin/users', authenticateAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 50, role } = req.query;
    const offset = (page - 1) * limit;
    let query = `
      SELECT u.id, u.phone, u.email, u.name, u.role, u.created_at,
             COUNT(DISTINCT CASE WHEN a.status != 'false_alarm' THEN a.id END)::int as total_reports,
             COUNT(DISTINCT CASE WHEN a.status = 'confirmed' THEN a.id END)::int as confirmed_reports,
             COUNT(DISTINCT fr.id)::int as false_reports_made
      FROM users u
      LEFT JOIN accidents a ON u.id = a.user_id
      LEFT JOIN false_reports fr ON u.id = fr.user_id
      WHERE 1=1
    `;
    const params = [];
    let paramIndex = 1;
    if (role) {
      query += ` AND u.role = $${paramIndex++}`;
      params.push(role);
    }
    query += `
      GROUP BY u.id ORDER BY u.created_at DESC
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}
    `;
    params.push(parseInt(limit), parseInt(offset));
    const [users, totalCount] = await Promise.all([
      pool.query(query, params),
      pool.query('SELECT COUNT(*) FROM users')
    ]);
    res.json({
      success: true,
      data: users.rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: parseInt(totalCount.rows[0].count),
        totalPages: Math.ceil(parseInt(totalCount.rows[0].count) / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ success: false, error: 'Алдаа гарлаа' });
  }
});
app.post('/admin/users', authenticateAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const { phone, email, name, password, role = 'user' } = req.body;
    if (!phone || !name || !password) {
      return res.status(400).json({
        success: false,
        error: 'Утас, нэр, нууц үг шаардлагатай'
      });
    }
    await client.query('BEGIN');
    const existingUser = await client.query(
      'SELECT id FROM users WHERE phone = $1 OR ($2 IS NOT NULL AND email = $2)',
      [phone, email]
    );
    if (existingUser.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        success: false,
        error: 'Утас эсвэл имэйл бүртгэгдсэн байна'
      });
    }
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const result = await client.query(`
      INSERT INTO users (phone, email, name, password_hash, role)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, phone, email, name, role, created_at
    `, [phone, email, name, passwordHash, role]);
    await client.query('COMMIT');
    res.status(201).json({
      success: true,
      message: 'Хэрэглэгч амжилттай нэмэгдлээ',
      data: result.rows[0]
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Create user error:', error);
    res.status(500).json({ success: false, error: 'Хэрэглэгч нэмэхэд алдаа гарлаа' });
  } finally {
    client.release();
  }
});
app.put('/admin/users/:id', authenticateAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, email, role } = req.body;
    const updates = [];
    const values = [];
    let paramIndex = 1;
    if (name) {
      updates.push(`name = $${paramIndex++}`);
      values.push(name);
    }
    if (email !== undefined) {
      updates.push(`email = $${paramIndex++}`);
      values.push(email);
    }
    if (role) {
      updates.push(`role = $${paramIndex++}`);
      values.push(role);
    }
    if (updates.length === 0) {
      return res.status(400).json({ success: false, error: 'Өөрчлөх мэдээлэл байхгүй' });
    }
    updates.push(`updated_at = NOW()`);
    values.push(id);
    const query = `
      UPDATE users SET ${updates.join(', ')}
      WHERE id = $${paramIndex}
      RETURNING id, phone, email, name, role, updated_at
    `;
    const result = await pool.query(query, values);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Хэрэглэгч олдсонгүй' });
    }
    res.json({
      success: true,
      message: 'Хэрэглэгч шинэчлэгдлээ',
      data: result.rows[0]
    });
  } catch (error) {
    console.error('Update user error:', error);
    res.status(500).json({ success: false, error: 'Шинэчлэхэд алдаа гарлаа' });
  }
});
app.delete('/admin/users/:id', authenticateAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (parseInt(id) === req.user.userId) {
      return res.status(400).json({
        success: false,
        error: 'Өөрийгөө устгаж болохгүй'
      });
    }
    const result = await pool.query('DELETE FROM users WHERE id = $1 RETURNING id', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Хэрэглэгч олдсонгүй' });
    }
    res.json({ success: true, message: 'Хэрэглэгч устгагдлаа' });
  } catch (error) {
    console.error('Delete user error:', error);
    res.status(500).json({ success: false, error: 'Устгахад алдаа гарлаа' });
  }
});
async function proxyCameraRequest(req, res, method, path, body = null) {
  try {
    const url = `${CAMERA_SERVICE_URL}${path}`;
    const config = {
      method,
      headers: {
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    };
    if (body) {
      config.data = body;
    }
    const response = await axios(url, config);
    res.status(response.status).json(response.data);
  } catch (error) {
    console.error(`Camera service proxy error:`, error.message);
    if (error.response) {
      res.status(error.response.status).json(error.response.data);
    } else if (error.code === 'ECONNREFUSED') {
      res.status(503).json({
        success: false,
        error: 'Камер сервис ажиллахгүй байна'
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Камер сервистэй холбогдоход алдаа гарлаа'
      });
    }
  }
}
app.get('/admin/cameras', authenticateAdmin, async (req, res) => {
  const queryString = new URLSearchParams(req.query).toString();
  const path = queryString ? `/cameras?${queryString}` : '/cameras';
  await proxyCameraRequest(req, res, 'GET', path);
});
app.get('/admin/cameras/:id', authenticateAdmin, async (req, res) => {
  await proxyCameraRequest(req, res, 'GET', `/cameras/${req.params.id}`);
});
app.post('/admin/cameras', authenticateAdmin, async (req, res) => {
  await proxyCameraRequest(req, res, 'POST', '/cameras', req.body);
});
app.put('/admin/cameras/:id', authenticateAdmin, async (req, res) => {
  await proxyCameraRequest(req, res, 'PUT', `/cameras/${req.params.id}`, req.body);
});
app.delete('/admin/cameras/:id', authenticateAdmin, async (req, res) => {
  await proxyCameraRequest(req, res, 'DELETE', `/cameras/${req.params.id}`);
});
app.post('/admin/cameras/:id/start', authenticateAdmin, async (req, res) => {
  await proxyCameraRequest(req, res, 'POST', `/cameras/${req.params.id}/start`);
});
app.post('/admin/cameras/:id/stop', authenticateAdmin, async (req, res) => {
  await proxyCameraRequest(req, res, 'POST', `/cameras/${req.params.id}/stop`);
});
app.post('/admin/cameras/:id/restart', authenticateAdmin, async (req, res) => {
  await proxyCameraRequest(req, res, 'POST', `/cameras/${req.params.id}/restart`);
});
app.get('/admin/services/health', authenticateAdmin, async (req, res) => {
  const isDev = process.env.NODE_ENV !== 'production';
  const services = [
    { name: 'User Service', url: process.env.USER_SERVICE_URL || 'http://user-service:3001' },
    { name: 'Accident Service', url: process.env.ACCIDENT_SERVICE_URL || 'http://accident-service:3002' },
    { name: 'Video Service', url: process.env.VIDEO_SERVICE_URL || 'http://video-service:3003' },
    { name: 'AI Service', url: process.env.AI_SERVICE_URL || 'http://ai-detection-service:3004' },
    { name: 'Notification Service', url: process.env.NOTIFICATION_SERVICE_URL || 'http://notification-service:3005' },
    { name: 'Map Service', url: process.env.MAP_SERVICE_URL || 'http://map-service:3006' },
    { name: 'Report Service', url: process.env.REPORT_SERVICE_URL || 'http://report-service:3007' },
    { name: 'Camera Service', url: CAMERA_SERVICE_URL },
  ];
  const healthChecks = await Promise.all(
    services.map(async (service) => {
      const startTime = Date.now();
      try {
        const response = await axios.get(`${service.url}/health`, {
          timeout: 5000,
          validateStatus: (status) => status < 600
        });
        const responseTime = `${Date.now() - startTime}ms`;
        const isHealthy = response.status === 200 &&
          response.data &&
          (response.data.status === 'healthy' || response.data.status === 'ok');
        return {
          name: service.name,
          status: isHealthy ? 'healthy' : 'unhealthy',
          url: service.url,
          details: response.data,
          responseTime: responseTime,
          error: isHealthy ? null : `Service returned status: ${response.data.status || 'unknown'}`
        };
      } catch (error) {
        const responseTime = `${Date.now() - startTime}ms`;
        let errorMsg = 'Connection failed';
        if (error.code === 'ECONNREFUSED') {
          errorMsg = 'Connection refused - service may be down';
        } else if (error.code === 'ETIMEDOUT' || error.message.includes('timeout')) {
          errorMsg = 'Connection timeout';
        } else if (error.code === 'ENOTFOUND') {
          errorMsg = 'Service not found - DNS resolution failed';
        } else if (error.response) {
          errorMsg = `HTTP ${error.response.status}: ${error.response.statusText}`;
        }
        return {
          name: service.name,
          status: 'unhealthy',
          url: service.url,
          error: errorMsg,
          responseTime: responseTime,
          details: null
        };
      }
    })
  );
  let dbHealth = 'healthy';
  let dbError = null;
  try {
    await pool.query('SELECT 1');
  } catch (err) {
    dbHealth = 'unhealthy';
    dbError = err.message;
  }
  let redisHealth = 'healthy';
  let redisError = null;
  try {
    await redis.ping();
  } catch (err) {
    redisHealth = 'unhealthy';
    redisError = err.message;
  }
  const allHealthy = healthChecks.every(s => s.status === 'healthy') &&
    dbHealth === 'healthy' &&
    redisHealth === 'healthy';
  res.json({
    success: true,
    data: {
      services: healthChecks,
      database: { status: dbHealth, error: dbError },
      redis: { status: redisHealth, error: redisError },
      overallStatus: allHealthy ? 'healthy' : 'degraded',
      timestamp: new Date().toISOString()
    }
  });
});
app.get('/health', async (req, res) => {
  const health = {
    status: 'healthy',
    service: 'admin-service',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  };
  try {
    await pool.query('SELECT 1');
    health.database = 'connected';
  } catch (err) {
    health.database = 'disconnected';
    health.status = 'unhealthy';
  }
  try {
    await redis.ping();
    health.redis = 'connected';
  } catch (err) {
    health.redis = 'disconnected';
    health.status = 'unhealthy';
  }
  const statusCode = health.status === 'healthy' ? 200 : 503;
  res.status(statusCode).json(health);
});
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    success: false,
    error: process.env.NODE_ENV === 'production' ? 'Серверийн алдаа гарлаа' : err.message,
  });
});
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully...');
  await pool.end();
  await redis.quit();
  process.exit(0);
});
app.listen(PORT, () => {
  console.log(`👨‍💼 Admin Service running on port ${PORT}`);
  console.log(`📁 Static files: ${path.join(__dirname, 'public')}`);
  console.log(`🔒 JWT Secret: ${JWT_SECRET.substring(0, 10)}...`);
  console.log(`📊 Database: ${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || 5432}`);
  console.log(`💾 Redis: ${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || 6379}`);
  console.log(`📹 Camera Service: ${CAMERA_SERVICE_URL}`);
});
module.exports = app;