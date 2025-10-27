// services/admin-service/server.js - IMPROVED VERSION
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const Redis = require('ioredis');
const helmet = require('helmet');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3009;

// Security middleware
app.use(helmet({
  contentSecurityPolicy: false, // Allow inline scripts for admin dashboard
}));
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
  credentials: true
}));
app.use(express.json());

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

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

redis.on('error', (err) => {
  console.error('Redis error:', err);
});

const JWT_SECRET = process.env.JWT_SECRET || 'your-admin-secret-key';
const BCRYPT_ROUNDS = 12;

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
// ADMIN REGISTRATION (Development Only)
// ==========================================

/**
 * POST /admin/register
 * Development-д admin бүртгэх
 * PRODUCTION-д идэвхгүй байх ёстой!
 */
app.post('/admin/register', async (req, res) => {
  const client = await pool.connect();
  
  try {
    // Production-д хориглох
    if (process.env.NODE_ENV === 'production') {
      return res.status(403).json({
        success: false,
        error: 'Admin registration is disabled in production'
      });
    }

    const { username, password, email, name, phone } = req.body;

    // Validation
    if (!username || !password) {
      return res.status(400).json({
        success: false,
        error: 'Username болон password шаардлагатай'
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        success: false,
        error: 'Нууц үг 8-аас дээш тэмдэгт байх ёстой'
      });
    }

    await client.query('BEGIN');

    // Check if admin username exists
    const existingAdmin = await client.query(
      'SELECT id FROM admins WHERE username = $1',
      [username]
    );

    if (existingAdmin.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        success: false,
        error: 'Admin username аль хэдийн бүртгэгдсэн байна'
      });
    }

    // Check if user phone/email exists
    if (phone || email) {
      const existingUser = await client.query(
        'SELECT id FROM users WHERE phone = $1 OR email = $2',
        [phone, email]
      );

      if (existingUser.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          success: false,
          error: 'Утас эсвэл имэйл аль хэдийн бүртгэгдсэн байна'
        });
      }
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    // Create user
    const userResult = await client.query(`
      INSERT INTO users (phone, email, name, password_hash, role, status)
      VALUES ($1, $2, $3, $4, 'admin', 'active')
      RETURNING id, phone, email, name, role
    `, [
      phone || `+976${Date.now().toString().slice(-8)}`,
      email || `admin${Date.now()}@accident.mn`,
      name || username,
      passwordHash
    ]);

    const user = userResult.rows[0];

    // Create admin entry
    const adminResult = await client.query(`
      INSERT INTO admins (user_id, username, permissions)
      VALUES ($1, $2, '["all"]'::jsonb)
      RETURNING id, username, permissions
    `, [user.id, username]);

    const admin = adminResult.rows[0];

    await client.query('COMMIT');

    console.log(`✅ Admin created: ${username}`);

    res.status(201).json({
      success: true,
      message: 'Admin амжилттай бүртгэгдлээ',
      admin: {
        id: admin.id,
        username: admin.username,
        userId: user.id,
        permissions: admin.permissions
      }
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Admin registration error:', error);
    res.status(500).json({
      success: false,
      error: 'Admin бүртгэхэд алдаа гарлаа',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    client.release();
  }
});

// ==========================================
// ADMIN AUTHENTICATION
// ==========================================

/**
 * POST /admin/login
 * Admin нэвтрэх
 */
app.post('/admin/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ 
        success: false, 
        error: 'Username болон password шаардлагатай' 
      });
    }

    // Find admin
    const result = await pool.query(`
      SELECT a.*, u.password_hash, u.role, u.status, u.name, u.email
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

    // Check if account is active
    if (admin.status !== 'active') {
      return res.status(403).json({ 
        success: false, 
        error: 'Таны эрх хаагдсан байна' 
      });
    }

    // Verify password
    const isValid = await bcrypt.compare(password, admin.password_hash);
    if (!isValid) {
      return res.status(401).json({ 
        success: false, 
        error: 'Нэвтрэх нэр эсвэл нууц үг буруу' 
      });
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
    await pool.query(
      'UPDATE admins SET last_login = NOW() WHERE id = $1',
      [admin.id]
    );

    console.log(`✅ Admin logged in: ${username}`);

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
    res.status(500).json({ 
      success: false, 
      error: 'Нэвтрэхэд алдаа гарлаа' 
    });
  }
});

// ==========================================
// DASHBOARD STATISTICS
// ==========================================

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
      aiAccuracy
    ] = await Promise.all([
      pool.query('SELECT COUNT(*) as count FROM accidents'),
      pool.query("SELECT COUNT(*) as count FROM accidents WHERE status IN ('reported', 'confirmed')"),
      pool.query("SELECT COUNT(*) as count FROM accidents WHERE accident_time >= CURRENT_DATE"),
      pool.query('SELECT COUNT(*) as count FROM users'),
      pool.query("SELECT COUNT(*) as count FROM users WHERE status = 'active'"),
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
        WHERE a.source = 'camera'
          AND a.accident_time >= NOW() - INTERVAL '7 days'
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
      }
    };

    await redis.setex(cacheKey, 60, JSON.stringify(stats));

    res.json({
      success: true,
      source: 'database',
      data: stats
    });

  } catch (error) {
    console.error('Dashboard stats error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Статистик авахад алдаа гарлаа' 
    });
  }
});

// ==========================================
// ACCIDENT MANAGEMENT
// ==========================================

app.get('/admin/accidents', authenticateAdmin, async (req, res) => {
  try {
    const { 
      page = 1, 
      limit = 50, 
      status, 
      severity, 
      source 
    } = req.query;

    const offset = (page - 1) * limit;

    let query = `
      SELECT 
        a.*,
        u.name as reported_by_name,
        u.phone as reported_by_phone,
        c.name as camera_name,
        COUNT(DISTINCT fr.id) as false_report_count,
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

    if (severity) {
      query += ` AND a.severity = $${paramIndex++}`;
      params.push(severity);
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
    res.status(500).json({ 
      success: false, 
      error: 'Ослын мэдээлэл авахад алдаа гарлаа' 
    });
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
      UPDATE accidents 
      SET status = $1, updated_at = NOW()
      WHERE id = $2
      RETURNING *
    `, [status, id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Осол олдсонгүй' });
    }

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

// ==========================================
// USER MANAGEMENT
// ==========================================

app.get('/admin/users', authenticateAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    const offset = (page - 1) * limit;

    const [users, totalCount] = await Promise.all([
      pool.query(`
        SELECT 
          u.id, u.phone, u.email, u.name, u.status, u.role, u.created_at,
          COUNT(DISTINCT CASE WHEN a.status != 'false_alarm' THEN a.id END)::int as total_reports,
          COUNT(DISTINCT CASE WHEN a.status = 'confirmed' THEN a.id END)::int as confirmed_reports,
          COUNT(DISTINCT fr.id)::int as false_reports_made
        FROM users u
        LEFT JOIN accidents a ON u.id = a.user_id
        LEFT JOIN false_reports fr ON u.id = fr.reported_by_id
        GROUP BY u.id
        ORDER BY u.created_at DESC
        LIMIT $1 OFFSET $2
      `, [limit, offset]),
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
// FALLBACK ROUTE FOR SPA
// ==========================================

// Serve index.html for all other routes (SPA fallback)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Error handler
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
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`📁 Static files: ${path.join(__dirname, 'public')}`);
  console.log('');
  console.log('📋 Available endpoints:');
  console.log('   GET  /                - Admin dashboard (redirects to login)');
  console.log('   GET  /login.html      - Login page');
  console.log('   GET  /dashboard.html  - Dashboard');
  console.log('   POST /admin/register  - Create admin (dev only)');
  console.log('   POST /admin/login     - Admin login');
  console.log('   GET  /admin/dashboard/stats - Dashboard statistics');
  console.log('   GET  /admin/accidents - List accidents');
  console.log('   GET  /admin/users     - List users');
  console.log('');
});

module.exports = app;
