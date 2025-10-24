// services/admin-service/server.js
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const Redis = require('ioredis');

const app = express();
const PORT = process.env.PORT || 3009;

app.use(express.json());

// PostgreSQL
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

pool.on('error', (err) => {
  console.error('PostgreSQL pool error:', err);
});

// Redis
const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: process.env.REDIS_PORT || 6379,
  retryStrategy: (times) => Math.min(times * 50, 2000),
});

const JWT_SECRET = process.env.JWT_SECRET || 'your-admin-secret-key';

// ==========================================
// MIDDLEWARE
// ==========================================

// Admin authentication
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

// ==========================================
// ADMIN AUTHENTICATION
// ==========================================

// Admin login
app.post('/admin/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ success: false, error: 'Username болон password шаардлагатай' });
    }

    // Find admin
    const result = await pool.query(`
      SELECT a.*, u.password_hash, u.role 
      FROM admins a
      JOIN users u ON a.user_id = u.id
      WHERE a.username = $1 AND u.role = 'admin' AND u.status = 'active'
    `, [username]);

    if (result.rows.length === 0) {
      return res.status(401).json({ success: false, error: 'Нэвтрэх нэр эсвэл нууц үг буруу' });
    }

    const admin = result.rows[0];

    // Verify password
    const isValid = await bcrypt.compare(password, admin.password_hash);
    if (!isValid) {
      return res.status(401).json({ success: false, error: 'Нэвтрэх нэр эсвэл нууц үг буруу' });
    }

    // Generate token
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

    // Update last login
    await pool.query('UPDATE admins SET last_login = NOW() WHERE id = $1', [admin.id]);

    res.json({
      success: true,
      token,
      admin: {
        id: admin.id,
        username: admin.username,
        permissions: admin.permissions,
      }
    });

  } catch (error) {
    console.error('Admin login error:', error);
    res.status(500).json({ success: false, error: 'Нэвтрэхэд алдаа гарлаа' });
  }
});

// ==========================================
// DASHBOARD STATISTICS
// ==========================================

// Main dashboard stats
app.get('/admin/dashboard/stats', authenticateAdmin, async (req, res) => {
  try {
    const cacheKey = 'admin:dashboard:stats';
    const cached = await redis.get(cacheKey);

    if (cached) {
      return res.json({
        success: true,
        source: 'cache',
        data: JSON.parse(cached)
      });
    }

    // Parallel queries for better performance
    const [
      totalAccidents,
      activeAccidents,
      todayAccidents,
      totalUsers,
      activeUsers,
      totalCameras,
      onlineCameras,
      totalVideos,
      pendingVideos,
      aiAccuracy,
      recentActivities
    ] = await Promise.all([
      // Total accidents
      pool.query('SELECT COUNT(*) as count FROM accidents'),
      
      // Active accidents
      pool.query("SELECT COUNT(*) as count FROM accidents WHERE status IN ('reported', 'confirmed')"),
      
      // Today's accidents
      pool.query("SELECT COUNT(*) as count FROM accidents WHERE accident_time >= CURRENT_DATE"),
      
      // Total users
      pool.query('SELECT COUNT(*) as count FROM users'),
      
      // Active users
      pool.query("SELECT COUNT(*) as count FROM users WHERE status = 'active'"),
      
      // Total cameras
      pool.query('SELECT COUNT(*) as count FROM cameras'),
      
      // Online cameras
      pool.query('SELECT COUNT(*) as count FROM cameras WHERE is_online = true'),
      
      // Total videos
      pool.query('SELECT COUNT(*) as count FROM videos'),
      
      // Pending videos
      pool.query("SELECT COUNT(*) as count FROM videos WHERE status IN ('uploading', 'processing')"),
      
      // AI accuracy (last 100 detections)
      pool.query(`
        SELECT 
          COUNT(DISTINCT CASE WHEN a.status = 'confirmed' THEN a.id END) as confirmed,
          COUNT(DISTINCT CASE WHEN a.status = 'false_alarm' THEN a.id END) as false_alarms,
          AVG(aid.confidence)::float as avg_confidence
        FROM accidents a
        LEFT JOIN videos v ON a.video_id = v.id
        LEFT JOIN ai_detections aid ON v.id = aid.video_id
        WHERE a.source = 'camera'
          AND a.accident_time >= NOW() - INTERVAL '7 days'
      `),
      
      // Recent activities
      pool.query(`
        SELECT 
          'accident' as type,
          a.id,
          a.severity,
          a.status,
          a.accident_time as timestamp,
          u.name as user_name
        FROM accidents a
        LEFT JOIN users u ON a.user_id = u.id
        ORDER BY a.accident_time DESC
        LIMIT 10
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
        active: parseInt(activeUsers.rows[0].count),
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
      },
      recentActivities: recentActivities.rows,
    };

    // Cache for 1 minute
    await redis.setex(cacheKey, 60, JSON.stringify(stats));

    res.json({
      success: true,
      source: 'database',
      data: stats
    });

  } catch (error) {
    console.error('Dashboard stats error:', error);
    res.status(500).json({ success: false, error: 'Статистик авахад алдаа гарлаа' });
  }
});

// Time-series data for charts
app.get('/admin/dashboard/charts', authenticateAdmin, async (req, res) => {
  try {
    const { period = '7d' } = req.query;
    
    const interval = period === '24h' ? '1 hour' : '1 day';
    const range = period === '24h' ? '24 hours' : period === '30d' ? '30 days' : '7 days';

    const [accidentsTrend, severityDistribution, statusDistribution] = await Promise.all([
      // Accidents trend
      pool.query(`
        SELECT 
          DATE_TRUNC('${interval}', accident_time) as time,
          COUNT(*) as count
        FROM accidents
        WHERE accident_time >= NOW() - INTERVAL '${range}'
        GROUP BY time
        ORDER BY time
      `),

      // Severity distribution
      pool.query(`
        SELECT severity, COUNT(*) as count
        FROM accidents
        WHERE accident_time >= NOW() - INTERVAL '${range}'
        GROUP BY severity
      `),

      // Status distribution
      pool.query(`
        SELECT status, COUNT(*) as count
        FROM accidents
        WHERE accident_time >= NOW() - INTERVAL '${range}'
        GROUP BY status
      `)
    ]);

    res.json({
      success: true,
      data: {
        accidentsTrend: accidentsTrend.rows,
        severityDistribution: severityDistribution.rows,
        statusDistribution: statusDistribution.rows,
      }
    });

  } catch (error) {
    console.error('Dashboard charts error:', error);
    res.status(500).json({ success: false, error: 'Графикийн өгөгдөл авахад алдаа гарлаа' });
  }
});

// ==========================================
// ACCIDENT MANAGEMENT
// ==========================================

// Get all accidents with filters and pagination
app.get('/admin/accidents', authenticateAdmin, async (req, res) => {
  try {
    const { 
      page = 1, 
      limit = 50, 
      status, 
      severity, 
      source,
      startDate,
      endDate,
      search 
    } = req.query;

    const offset = (page - 1) * limit;

    let query = `
      SELECT 
        a.*,
        u.name as reported_by_name,
        u.phone as reported_by_phone,
        c.name as camera_name,
        COUNT(DISTINCT fr.id) as false_report_count
      FROM accidents a
      LEFT JOIN users u ON a.user_id = u.id
      LEFT JOIN cameras c ON a.camera_id = c.id
      LEFT JOIN false_reports fr ON a.id = fr.accident_id
      WHERE 1=1
    `;

    const params = [];
    let paramIndex = 1;

    if (status) {
      query += ` AND a.status = $${paramIndex++}`;
      params.push(status);
    }

    if (severity) {
      query += ` AND a.severity = $${paramIndex++}`;
      params.push(severity);
    }

    if (source) {
      query += ` AND a.source = $${paramIndex++}`;
      params.push(source);
    }

    if (startDate) {
      query += ` AND a.accident_time >= $${paramIndex++}`;
      params.push(startDate);
    }

    if (endDate) {
      query += ` AND a.accident_time <= $${paramIndex++}`;
      params.push(endDate);
    }

    if (search) {
      query += ` AND (a.description ILIKE $${paramIndex++} OR u.name ILIKE $${paramIndex++})`;
      params.push(`%${search}%`, `%${search}%`);
      paramIndex++;
    }

    query += `
      GROUP BY a.id, u.name, u.phone, c.name
      ORDER BY a.accident_time DESC
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}
    `;

    params.push(parseInt(limit), parseInt(offset));

    const [accidents, totalCount] = await Promise.all([
      pool.query(query, params),
      pool.query('SELECT COUNT(*) FROM accidents WHERE 1=1')
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

// Update accident status
app.put('/admin/accidents/:id/status', authenticateAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, note } = req.body;

    const validStatuses = ['reported', 'confirmed', 'resolved', 'false_alarm'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, error: 'Буруу төлөв' });
    }

    const result = await pool.query(`
      UPDATE accidents 
      SET status = $1, updated_at = NOW()
      WHERE id = $2
      RETURNING *
    `, [status, id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Осол олдсонгүй' });
    }

    // Clear cache
    await redis.del('admin:dashboard:stats');

    res.json({
      success: true,
      message: 'Төлөв шинэчлэгдлээ',
      data: result.rows[0]
    });

  } catch (error) {
    console.error('Update accident status error:', error);
    res.status(500).json({ success: false, error: 'Төлөв шинэчлэхэд алдаа гарлаа' });
  }
});

// Delete accident
app.delete('/admin/accidents/:id', authenticateAdmin, async (req, res) => {
  const client = await pool.connect();
  
  try {
    const { id } = req.params;

    await client.query('BEGIN');

    // Delete related records first
    await client.query('DELETE FROM false_reports WHERE accident_id = $1', [id]);
    await client.query('DELETE FROM notifications WHERE accident_id = $1', [id]);
    await client.query('DELETE FROM map_markers WHERE accident_id = $1', [id]);

    // Delete accident
    const result = await client.query('DELETE FROM accidents WHERE id = $1 RETURNING *', [id]);

    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Осол олдсонгүй' });
    }

    await client.query('COMMIT');

    // Clear cache
    await redis.del('admin:dashboard:stats');

    res.json({
      success: true,
      message: 'Осол устгагдлаа'
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Delete accident error:', error);
    res.status(500).json({ success: false, error: 'Устгахад алдаа гарлаа' });
  } finally {
    client.release();
  }
});

// ==========================================
// USER MANAGEMENT
// ==========================================

// Get all users
app.get('/admin/users', authenticateAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 50, status, role, search } = req.query;
    const offset = (page - 1) * limit;

    let query = `
      SELECT 
        u.*,
        us.total_reports,
        us.confirmed_reports,
        us.false_reports_made
      FROM users u
      LEFT JOIN user_statistics us ON u.id = us.id
      WHERE 1=1
    `;

    const params = [];
    let paramIndex = 1;

    if (status) {
      query += ` AND u.status = $${paramIndex++}`;
      params.push(status);
    }

    if (role) {
      query += ` AND u.role = $${paramIndex++}`;
      params.push(role);
    }

    if (search) {
      query += ` AND (u.name ILIKE $${paramIndex++} OR u.phone ILIKE $${paramIndex++} OR u.email ILIKE $${paramIndex++})`;
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
      paramIndex += 2;
    }

    query += ` ORDER BY u.created_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
    params.push(parseInt(limit), parseInt(offset));

    const [users, totalCount] = await Promise.all([
      pool.query(query, params),
      pool.query('SELECT COUNT(*) FROM users')
    ]);

    // Remove password hashes
    const sanitizedUsers = users.rows.map(user => {
      const { password_hash, ...rest } = user;
      return rest;
    });

    res.json({
      success: true,
      data: sanitizedUsers,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: parseInt(totalCount.rows[0].count),
        totalPages: Math.ceil(parseInt(totalCount.rows[0].count) / parseInt(limit))
      }
    });

  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ success: false, error: 'Хэрэглэгчийн мэдээлэл авахад алдаа гарлаа' });
  }
});

// Update user status
app.put('/admin/users/:id/status', authenticateAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const validStatuses = ['active', 'inactive', 'suspended'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, error: 'Буруу төлөв' });
    }

    const result = await pool.query(`
      UPDATE users 
      SET status = $1, updated_at = NOW()
      WHERE id = $2
      RETURNING id, name, phone, email, status, role
    `, [status, id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Хэрэглэгч олдсонгүй' });
    }

    res.json({
      success: true,
      message: 'Төлөв шинэчлэгдлээ',
      data: result.rows[0]
    });

  } catch (error) {
    console.error('Update user status error:', error);
    res.status(500).json({ success: false, error: 'Төлөв шинэчлэхэд алдаа гарлаа' });
  }
});

// ==========================================
// CAMERA MANAGEMENT
// ==========================================

// Get all cameras
app.get('/admin/cameras', authenticateAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        c.*,
        cs.total_accidents,
        cs.accidents_24h,
        cs.last_accident_time,
        cs.last_log_time
      FROM cameras c
      LEFT JOIN camera_statistics cs ON c.id = cs.id
      ORDER BY c.created_at DESC
    `);

    res.json({
      success: true,
      data: result.rows
    });

  } catch (error) {
    console.error('Get cameras error:', error);
    res.status(500).json({ success: false, error: 'Камерын мэдээлэл авахад алдаа гарлаа' });
  }
});

// Update camera status
app.put('/admin/cameras/:id/status', authenticateAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const validStatuses = ['active', 'inactive', 'maintenance'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, error: 'Буруу төлөв' });
    }

    const result = await pool.query(`
      UPDATE cameras 
      SET status = $1
      WHERE id = $2
      RETURNING *
    `, [status, id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Камер олдсонгүй' });
    }

    res.json({
      success: true,
      message: 'Камерын төлөв шинэчлэгдлээ',
      data: result.rows[0]
    });

  } catch (error) {
    console.error('Update camera status error:', error);
    res.status(500).json({ success: false, error: 'Төлөв шинэчлэхэд алдаа гарлаа' });
  }
});

// ==========================================
// SYSTEM LOGS
// ==========================================

app.get('/admin/logs', authenticateAdmin, async (req, res) => {
  try {
    const { limit = 100, type } = req.query;

    let query = `
      SELECT * FROM camera_logs
      WHERE 1=1
    `;

    const params = [];
    let paramIndex = 1;

    if (type) {
      query += ` AND status = $${paramIndex++}`;
      params.push(type);
    }

    query += ` ORDER BY timestamp DESC LIMIT $${paramIndex}`;
    params.push(parseInt(limit));

    const result = await pool.query(query, params);

    res.json({
      success: true,
      data: result.rows
    });

  } catch (error) {
    console.error('Get logs error:', error);
    res.status(500).json({ success: false, error: 'Лог авахад алдаа гарлаа' });
  }
});

// ==========================================
// HEALTH CHECK
// ==========================================

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

// ==========================================
// ERROR HANDLER
// ==========================================

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    success: false,
    error: process.env.NODE_ENV === 'production' 
      ? 'Серверийн алдаа гарлаа' 
      : err.message,
  });
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully...');
  await pool.end();
  await redis.quit();
  process.exit(0);
});

app.listen(PORT, () => {
  console.log(`👨‍💼 Admin Service running on port ${PORT}`);
  console.log(`🔐 JWT configured: ${!!JWT_SECRET}`);
});

module.exports = app;