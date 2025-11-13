// services/user-service/server.js - WITH CORS SUPPORT
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const Redis = require('ioredis');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3001;

// ==========================================
// MIDDLEWARE - CORS MUST BE FIRST!
// ==========================================

app.use(cors({
  origin: '*', // Allow all origins for development
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

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
  retryStrategy: (times) => {
    const delay = Math.min(times * 50, 2000);
    return delay;
  }
});

redis.on('error', (err) => {
  console.error('Redis error:', err);
});

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
const JWT_EXPIRES_IN = '7d';
const REFRESH_TOKEN_EXPIRES_IN = '30d';
const BCRYPT_ROUNDS = 12;

// ==========================================
// HELPER FUNCTIONS
// ==========================================

function generateTokens(user) {
  const accessToken = jwt.sign(
    { 
      userId: user.id, 
      phone: user.phone,
      email: user.email,
      role: user.role 
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );

  const refreshToken = jwt.sign(
    { userId: user.id, type: 'refresh' },
    JWT_SECRET,
    { expiresIn: REFRESH_TOKEN_EXPIRES_IN }
  );

  return { accessToken, refreshToken };
}

function validatePhone(phone) {
  const phoneRegex = /^\+976\d{8}$/;
  return phoneRegex.test(phone);
}

function validateEmail(email) {
  if (!email) return true;
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

function validatePassword(password) {
  if (password.length < 8) {
    return { valid: false, error: 'Нууц үг 8-аас дээш тэмдэгт байх ёстой' };
  }
  if (!/[A-Z]/.test(password)) {
    return { valid: false, error: 'Нууц үг том үсэг агуулсан байх ёстой' };
  }
  if (!/[a-z]/.test(password)) {
    return { valid: false, error: 'Нууц үг жижиг үсэг агуулсан байх ёстой' };
  }
  if (!/[0-9]/.test(password)) {
    return { valid: false, error: 'Нууц үг тоо агуулсан байх ёстой' };
  }
  return { valid: true };
}

// ==========================================
// MIDDLEWARE
// ==========================================

const authenticateAdmin = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ success: false, error: 'Нэвтрэх шаардлагатай' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Админ эрх шаардлагатай' });
    }
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(403).json({ success: false, error: 'Буруу токен' });
  }
};

// ==========================================
// HEALTH CHECK - MUST BE EARLY FOR SERVICES.HTML
// ==========================================

app.get('/health', async (req, res) => {
  const health = {
    status: 'healthy',
    service: 'user-service',
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
// AUTHENTICATION ENDPOINTS
// ==========================================

const loginAttempts = new Map();

function checkLoginAttempts(phone) {
  const key = `login:${phone}`;
  const attempts = loginAttempts.get(key) || { count: 0, lockedUntil: 0 };
  
  if (attempts.lockedUntil > Date.now()) {
    const remainingMs = attempts.lockedUntil - Date.now();
    const remainingSec = Math.ceil(remainingMs / 1000);
    return {
      allowed: false,
      message: `Хэт олон буруу оролдлого. ${remainingSec} секундын дараа дахин оролдоно уу`
    };
  }
  
  if (attempts.lockedUntil > 0 && attempts.lockedUntil <= Date.now()) {
    loginAttempts.delete(key);
    return { allowed: true };
  }
  
  if (attempts.count >= 5) {
    attempts.lockedUntil = Date.now() + 15 * 60 * 1000;
    loginAttempts.set(key, attempts);
    return {
      allowed: false,
      message: 'Хэт олон буруу оролдлого. 15 минутын дараа дахин оролдоно уу'
    };
  }
  
  return { allowed: true };
}

function recordFailedLogin(phone) {
  const key = `login:${phone}`;
  const attempts = loginAttempts.get(key) || { count: 0, lockedUntil: 0 };
  attempts.count += 1;
  loginAttempts.set(key, attempts);
}

function resetLoginAttempts(phone) {
  loginAttempts.delete(`login:${phone}`);
}

app.post('/auth/register', async (req, res) => {
  const client = await pool.connect();
  
  try {
    const { phone, email, name, password } = req.body;

    if (!phone || !name || !password) {
      return res.status(400).json({ 
        success: false,
        error: 'Утасны дугаар, нэр, нууц үг заавал оруулна уу' 
      });
    }

    if (!validatePhone(phone)) {
      return res.status(400).json({
        success: false,
        error: 'Утасны дугаар буруу форматтай байна (+976XXXXXXXX)'
      });
    }

    if (email && !validateEmail(email)) {
      return res.status(400).json({
        success: false,
        error: 'Имэйл хаяг буруу форматтай байна'
      });
    }

    const passwordValidation = validatePassword(password);
    if (!passwordValidation.valid) {
      return res.status(400).json({ 
        success: false,
        error: passwordValidation.error
      });
    }

    await client.query('BEGIN');

    // ЗАСВАРЛАСАН: email байгаа эсэхээс хамааруулан query бичнэ
    let existingUser;
    if (email) {
      existingUser = await client.query(
        'SELECT id FROM users WHERE phone = $1 OR email = $2',
        [phone, email]
      );
    } else {
      existingUser = await client.query(
        'SELECT id FROM users WHERE phone = $1',
        [phone]
      );
    }

    if (existingUser.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ 
        success: false,
        error: 'Энэ утас эсвэл имэйл хаяг бүртгэгдсэн байна' 
      });
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    // ЗАСВАРЛАСАН: email-д тодорхой төрөл зааж өгнө
    const result = await client.query(
      `INSERT INTO users (phone, email, name, password_hash, role, status)
       VALUES ($1, $2::text, $3, $4, $5, $6)
       RETURNING id, phone, email, name, role, created_at`,
      [phone, email || null, name, passwordHash, 'user', 'active']
    );

    const user = result.rows[0];

    await client.query(
      `INSERT INTO notification_settings (user_id, push_enabled, radius)
       VALUES ($1, $2, $3)`,
      [user.id, true, 5000]
    );

    await client.query('COMMIT');

    const tokens = generateTokens(user);

    await redis.setex(
      `refresh_token:${user.id}`,
      30 * 24 * 60 * 60,
      tokens.refreshToken
    );

    res.status(201).json({
      success: true,
      message: 'Амжилттай бүртгэгдлээ',
      user: {
        id: user.id,
        phone: user.phone,
        email: user.email,
        name: user.name,
        role: user.role
      },
      ...tokens
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Register error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Бүртгэлд алдаа гарлаа'
    });
  } finally {
    client.release();
  }
});

app.post('/auth/login', async (req, res) => {
  try {
    const { phone, password } = req.body;

    if (!phone || !password) {
      return res.status(400).json({ 
        success: false,
        error: 'Утас болон нууц үг оруулна уу' 
      });
    }

    const attemptCheck = checkLoginAttempts(phone);
    if (!attemptCheck.allowed) {
      return res.status(429).json({
        success: false,
        error: attemptCheck.message
      });
    }

    const result = await pool.query(
      'SELECT * FROM users WHERE phone = $1',
      [phone]
    );

    if (result.rows.length === 0) {
      recordFailedLogin(phone);
      return res.status(401).json({ 
        success: false,
        error: 'Хэрэглэгч олдсонгүй эсвэл нууц үг буруу' 
      });
    }

    const user = result.rows[0];

    if (user.status !== 'active') {
      return res.status(403).json({ 
        success: false,
        error: 'Таны эрх хаагдсан байна' 
      });
    }

    const isValidPassword = await bcrypt.compare(password, user.password_hash);
    if (!isValidPassword) {
      recordFailedLogin(phone);
      return res.status(401).json({ 
        success: false,
        error: 'Хэрэглэгч олдсонгүй эсвэл нууц үг буруу' 
      });
    }

    resetLoginAttempts(phone);

    const tokens = generateTokens(user);

    await redis.setex(
      `refresh_token:${user.id}`,
      30 * 24 * 60 * 60,
      tokens.refreshToken
    );

    pool.query(
      'UPDATE users SET updated_at = NOW() WHERE id = $1',
      [user.id]
    ).catch(err => console.error('Failed to update last login:', err));

    res.json({
      success: true,
      message: 'Амжилттай нэвтэрлээ',
      user: {
        id: user.id,
        phone: user.phone,
        email: user.email,
        name: user.name,
        role: user.role
      },
      ...tokens
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Нэвтрэхэд алдаа гарлаа' 
    });
  }
});

app.post('/auth/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(400).json({ 
        success: false,
        error: 'Refresh token байхгүй байна' 
      });
    }

    let decoded;
    try {
      decoded = jwt.verify(refreshToken, JWT_SECRET);
    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        return res.status(401).json({ 
          success: false,
          error: 'Токен хугацаа дууссан' 
        });
      }
      return res.status(401).json({ 
        success: false,
        error: 'Буруу токен' 
      });
    }
    
    if (decoded.type !== 'refresh') {
      return res.status(400).json({ 
        success: false,
        error: 'Буруу токен төрөл' 
      });
    }

    const storedToken = await redis.get(`refresh_token:${decoded.userId}`);
    if (storedToken !== refreshToken) {
      return res.status(401).json({ 
        success: false,
        error: 'Токен хүчингүй байна' 
      });
    }

    const result = await pool.query(
      'SELECT id, phone, email, name, role FROM users WHERE id = $1 AND status = $2',
      [decoded.userId, 'active']
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ 
        success: false,
        error: 'Хэрэглэгч олдсонгүй' 
      });
    }

    const user = result.rows[0];
    const tokens = generateTokens(user);

    await redis.setex(
      `refresh_token:${user.id}`,
      30 * 24 * 60 * 60,
      tokens.refreshToken
    );

    res.json({
      success: true,
      message: 'Токен сэргээгдлээ',
      ...tokens
    });

  } catch (error) {
    console.error('Refresh token error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Токен сэргээхэд алдаа гарлаа' 
    });
  }
});

app.post('/auth/logout', async (req, res) => {
  try {
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ 
        success: false,
        error: 'userId шаардлагатай' 
      });
    }

    await redis.del(`refresh_token:${userId}`);
    await redis.del(`user:${userId}:location`);

    res.json({ 
      success: true,
      message: 'Амжилттай гарлаа' 
    });

  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Гарахад алдаа гарлаа' 
    });
  }
});

// ==========================================
// ADMIN ENDPOINTS
// ==========================================

app.get('/admin/users', authenticateAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 50, status, role, search } = req.query;
    const offset = (page - 1) * limit;

    let query = `
      SELECT u.id, u.phone, u.email, u.name, u.status, u.role, u.created_at,
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

    if (status) {
      query += ` AND u.status = $${paramIndex++}`;
      params.push(status);
    }
    if (role) {
      query += ` AND u.role = $${paramIndex++}`;
      params.push(role);
    }
    if (search) {
      query += ` AND (u.name ILIKE $${paramIndex} OR u.phone ILIKE $${paramIndex} OR u.email ILIKE $${paramIndex})`;
      params.push(`%${search}%`);
      paramIndex++;
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

app.get('/admin/users/stats', authenticateAdmin, async (req, res) => {
  try {
    const cacheKey = 'admin:users:stats';
    const cached = await redis.get(cacheKey);

    if (cached) {
      return res.json({ success: true, source: 'cache', data: JSON.parse(cached) });
    }

    const [totalUsers, activeUsers, newUsersToday, topReporters] = await Promise.all([
      pool.query('SELECT COUNT(*) as count FROM users'),
      pool.query("SELECT COUNT(*) as count FROM users WHERE status = 'active'"),
      pool.query("SELECT COUNT(*) as count FROM users WHERE created_at >= CURRENT_DATE"),
      pool.query(`
        SELECT u.id, u.name, u.phone, COUNT(a.id)::int as report_count
        FROM users u
        LEFT JOIN accidents a ON u.id = a.user_id
        WHERE a.status != 'false_alarm'
        GROUP BY u.id, u.name, u.phone
        ORDER BY report_count DESC
        LIMIT 10
      `)
    ]);

    const stats = {
      total: parseInt(totalUsers.rows[0].count),
      active: parseInt(activeUsers.rows[0].count),
      newToday: parseInt(newUsersToday.rows[0].count),
      topReporters: topReporters.rows
    };

    await redis.setex(cacheKey, 300, JSON.stringify(stats));

    res.json({ success: true, source: 'database', data: stats });

  } catch (error) {
    console.error('Get user stats error:', error);
    res.status(500).json({ success: false, error: 'Статистик авахад алдаа гарлаа' });
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

    if (!validatePhone(phone)) {
      return res.status(400).json({
        success: false,
        error: 'Утасны дугаар буруу форматтай байна (+976XXXXXXXX)'
      });
    }

    if (email && !validateEmail(email)) {
      return res.status(400).json({
        success: false,
        error: 'Имэйл хаяг буруу форматтай байна'
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
      INSERT INTO users (phone, email, name, password_hash, role, status)
      VALUES ($1, $2, $3, $4, $5, 'active')
      RETURNING id, phone, email, name, role, created_at
    `, [phone, email, name, passwordHash, role]);

    await client.query('COMMIT');

    await redis.del('admin:users:stats');

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
    const { name, email, status, role } = req.body;

    const updates = [];
    const values = [];
    let paramIndex = 1;

    if (name) {
      const sanitizedName = name.trim().replace(/<[^>]*>/g, '');
      updates.push(`name = $${paramIndex++}`);
      values.push(sanitizedName);
    }
    if (email !== undefined) {
      if (email && !validateEmail(email)) {
        return res.status(400).json({
          success: false,
          error: 'Имэйл хаяг буруу форматтай байна'
        });
      }
      updates.push(`email = $${paramIndex++}`);
      values.push(email);
    }
    if (status) {
      updates.push(`status = $${paramIndex++}`);
      values.push(status);
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
      RETURNING id, phone, email, name, role, status, updated_at
    `;

    const result = await pool.query(query, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Хэрэглэгч олдсонгүй' });
    }

    await redis.del('admin:users:stats');

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

    await redis.del('admin:users:stats');

    res.json({ success: true, message: 'Хэрэглэгч устгагдлаа' });

  } catch (error) {
    console.error('Delete user error:', error);
    res.status(500).json({ success: false, error: 'Устгахад алдаа гарлаа' });
  }
});

// ==========================================
// USER ENDPOINTS
// ==========================================

app.get('/users/:id', async (req, res) => {
  try {
    const { id } = req.params;

    if (!/^\d+$/.test(id)) {
      return res.status(400).json({
        success: false,
        error: 'Буруу ID формат'
      });
    }

    const result = await pool.query(`
      SELECT 
        u.id, u.phone, u.email, u.name, u.status, u.role, u.created_at,
        us.total_reports, us.confirmed_reports, us.false_reports_made
      FROM users u
      LEFT JOIN user_statistics us ON u.id = us.id
      WHERE u.id = $1
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ 
        success: false,
        error: 'Хэрэглэгч олдсонгүй' 
      });
    }

    const user = result.rows[0];

    res.json({
      success: true,
      data: user
    });

  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Мэдээлэл авахад алдаа гарлаа' 
    });
  }
});

app.put('/users/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, email, currentPassword, newPassword } = req.body;

    const updates = [];
    const values = [];
    let paramIndex = 1;

    if (name) {
      const sanitizedName = name.trim().replace(/<[^>]*>/g, '');
      updates.push(`name = $${paramIndex++}`);
      values.push(sanitizedName);
    }

    if (email) {
      if (!validateEmail(email)) {
        return res.status(400).json({
          success: false,
          error: 'Имэйл хаяг буруу форматтай байна'
        });
      }
      updates.push(`email = $${paramIndex++}`);
      values.push(email);
    }

    if (currentPassword && newPassword) {
      const passwordValidation = validatePassword(newPassword);
      if (!passwordValidation.valid) {
        return res.status(400).json({
          success: false,
          error: passwordValidation.error
        });
      }

      const userResult = await pool.query(
        'SELECT password_hash FROM users WHERE id = $1',
        [id]
      );

      if (userResult.rows.length === 0) {
        return res.status(404).json({ 
          success: false,
          error: 'Хэрэглэгч олдсонгүй' 
        });
      }

      const isValid = await bcrypt.compare(
        currentPassword,
        userResult.rows[0].password_hash
      );

      if (!isValid) {
        return res.status(401).json({ 
          success: false,
          error: 'Одоогийн нууц үг буруу байна' 
        });
      }

      const newPasswordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
      updates.push(`password_hash = $${paramIndex++}`);
      values.push(newPasswordHash);
    }

    if (updates.length === 0) {
      return res.status(400).json({ 
        success: false,
        error: 'Өөрчлөх мэдээлэл байхгүй байна' 
      });
    }

    updates.push(`updated_at = NOW()`);
    values.push(id);

    const query = `
      UPDATE users 
      SET ${updates.join(', ')}
      WHERE id = $${paramIndex}
      RETURNING id, phone, email, name, role, updated_at
    `;

    const result = await pool.query(query, values);

    res.json({
      success: true,
      message: 'Мэдээлэл шинэчлэгдлээ',
      user: result.rows[0]
    });

  } catch (error) {
    console.error('Update user error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Шинэчлэхэд алдаа гарлаа' 
    });
  }
});

app.get('/users/:id/notification-settings', async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      'SELECT * FROM notification_settings WHERE user_id = $1',
      [id]
    );

    if (result.rows.length === 0) {
      const newSettings = await pool.query(
        `INSERT INTO notification_settings (user_id, push_enabled, radius)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [id, true, 5000]
      );
      return res.json({
        success: true,
        data: newSettings.rows[0]
      });
    }

    res.json({
      success: true,
      data: result.rows[0]
    });

  } catch (error) {
    console.error('Get notification settings error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Тохиргоо авахад алдаа гарлаа' 
    });
  }
});

app.put('/users/:id/notification-settings', async (req, res) => {
  try {
    const { id } = req.params;
    const { pushEnabled, radius, accidentTypes } = req.body;

    const result = await pool.query(
      `UPDATE notification_settings
       SET push_enabled = COALESCE($1, push_enabled),
           radius = COALESCE($2, radius),
           accident_types = COALESCE($3, accident_types),
           updated_at = NOW()
       WHERE user_id = $4
       RETURNING *`,
      [pushEnabled, radius, accidentTypes ? JSON.stringify(accidentTypes) : null, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ 
        success: false,
        error: 'Тохиргоо олдсонгүй' 
      });
    }

    res.json({
      success: true,
      message: 'Тохиргоо шинэчлэгдлээ',
      settings: result.rows[0]
    });

  } catch (error) {
    console.error('Update notification settings error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Тохиргоо шинэчлэхэд алдаа гарлаа' 
    });
  }
});

// ==========================================
// GRACEFUL SHUTDOWN
// ==========================================

process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully...');
  await pool.end();
  await redis.quit();
  process.exit(0);
});

app.listen(PORT,"0.0.0.0", () => {
  console.log('0.0.0.0 --- -- - -- - - -- -- - -- -- -- - -');
  console.log(`👤 User Service running on port ${PORT}`);
  console.log(`🔒 Bcrypt rounds: ${BCRYPT_ROUNDS}`);
  console.log(`🔐 JWT configured: ${!!JWT_SECRET}`);
  console.log(`✅ Admin endpoints enabled`);
  console.log(`🌐 CORS enabled for all origins`);
});

module.exports = app;