// services/user-service/server.js - FIXED VERSION
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const Redis = require('ioredis');

const app = express();
const PORT = process.env.PORT || 3001;

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

// Connection error handler
pool.on('error', (err) => {
  console.error('PostgreSQL pool error:', err);
});

// Redis - session store
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

// ✅ CRITICAL: Environment validation
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET === 'your-secret-key-change-in-production') {
  console.error('❌ CRITICAL: JWT_SECRET not properly configured!');
  if (process.env.NODE_ENV === 'production') {
    process.exit(1);
  }
}

const JWT_EXPIRES_IN = '7d';
const REFRESH_TOKEN_EXPIRES_IN = '30d';
// ✅ FIXED: Stronger bcrypt rounds (12 instead of 10)
const BCRYPT_ROUNDS = 12;

// Helper: Generate JWT tokens
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

// ✅ FIXED: Input validation helpers
function validatePhone(phone) {
  const phoneRegex = /^\+976\d{8}$/;
  return phoneRegex.test(phone);
}

function validateEmail(email) {
  if (!email) return true; // Email is optional
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

// ✅ FIXED: POST /auth/register - Enhanced validation and security
app.post('/auth/register', async (req, res) => {
  const client = await pool.connect();
  
  try {
    const { phone, email, name, password } = req.body;

    // Validation
    if (!phone || !name || !password) {
      return res.status(400).json({ 
        success: false,
        error: 'Утасны дугаар, нэр, нууц үг заавал оруулна уу' 
      });
    }

    // Phone validation
    if (!validatePhone(phone)) {
      return res.status(400).json({
        success: false,
        error: 'Утасны дугаар буруу форматтай байна (+976XXXXXXXX)'
      });
    }

    // Email validation
    if (email && !validateEmail(email)) {
      return res.status(400).json({
        success: false,
        error: 'Имэйл хаяг буруу форматтай байна'
      });
    }

    // ✅ FIXED: Stronger password validation
    const passwordValidation = validatePassword(password);
    if (!passwordValidation.valid) {
      return res.status(400).json({ 
        success: false,
        error: passwordValidation.error
      });
    }

    await client.query('BEGIN');

    // Check if user exists
    const existingUser = await client.query(
      'SELECT id FROM users WHERE phone = $1 OR ($2 IS NOT NULL AND email = $2)',
      [phone, email]
    );

    if (existingUser.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ 
        success: false,
        error: 'Энэ утас эсвэл имэйл хаяг бүртгэгдсэн байна' 
      });
    }

    // ✅ FIXED: Hash password with stronger rounds
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    // Create user
    const result = await client.query(
      `INSERT INTO users (phone, email, name, password_hash, role, status)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, phone, email, name, role, created_at`,
      [phone, email, name, passwordHash, 'user', 'active']
    );

    const user = result.rows[0];

    // Create notification settings
    await client.query(
      `INSERT INTO notification_settings (user_id, push_enabled, radius)
       VALUES ($1, $2, $3)`,
      [user.id, true, 5000]
    );

    await client.query('COMMIT');

    // Generate tokens
    const tokens = generateTokens(user);

    // Store refresh token in Redis (30 days)
    await redis.setex(
      `refresh_token:${user.id}`,
      30 * 24 * 60 * 60,
      tokens.refreshToken
    );

    // ✅ FIXED: Don't send sensitive data
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
      error: 'Бүртгэлд алдаа гарлаа',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    client.release();
  }
});

// ✅ FIXED: POST /auth/login - Rate limiting & brute force protection
const loginAttempts = new Map();

// Helper: Check login attempts
function checkLoginAttempts(phone) {
  const key = `login:${phone}`;
  const attempts = loginAttempts.get(key) || { count: 0, lockedUntil: 0 };
  
  // Check if locked
  if (attempts.lockedUntil > Date.now()) {
    const remainingMs = attempts.lockedUntil - Date.now();
    const remainingSec = Math.ceil(remainingMs / 1000);
    return {
      allowed: false,
      message: `Хэт олон буруу оролдлого. ${remainingSec} секундын дараа дахин оролдоно уу`
    };
  }
  
  // Reset if lock expired
  if (attempts.lockedUntil > 0 && attempts.lockedUntil <= Date.now()) {
    loginAttempts.delete(key);
    return { allowed: true };
  }
  
  // Check attempts
  if (attempts.count >= 5) {
    attempts.lockedUntil = Date.now() + 15 * 60 * 1000; // 15 minutes
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

app.post('/auth/login', async (req, res) => {
  try {
    const { phone, password } = req.body;

    if (!phone || !password) {
      return res.status(400).json({ 
        success: false,
        error: 'Утас болон нууц үг оруулна уу' 
      });
    }

    // ✅ FIXED: Check brute force protection
    const attemptCheck = checkLoginAttempts(phone);
    if (!attemptCheck.allowed) {
      return res.status(429).json({
        success: false,
        error: attemptCheck.message
      });
    }

    // Find user
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

    // Check if account is active
    if (user.status !== 'active') {
      return res.status(403).json({ 
        success: false,
        error: 'Таны эрх хаагдсан байна' 
      });
    }

    // Verify password
    const isValidPassword = await bcrypt.compare(password, user.password_hash);
    if (!isValidPassword) {
      recordFailedLogin(phone);
      return res.status(401).json({ 
        success: false,
        error: 'Хэрэглэгч олдсонгүй эсвэл нууц үг буруу' 
      });
    }

    // ✅ SUCCESS: Reset failed attempts
    resetLoginAttempts(phone);

    // Generate tokens
    const tokens = generateTokens(user);

    // Store refresh token
    await redis.setex(
      `refresh_token:${user.id}`,
      30 * 24 * 60 * 60,
      tokens.refreshToken
    );

    // Update last login (async, don't wait)
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

// POST /auth/refresh - Token сэргээх
app.post('/auth/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(400).json({ 
        success: false,
        error: 'Refresh token байхгүй байна' 
      });
    }

    // Verify refresh token
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

    // Check if refresh token exists in Redis
    const storedToken = await redis.get(`refresh_token:${decoded.userId}`);
    if (storedToken !== refreshToken) {
      return res.status(401).json({ 
        success: false,
        error: 'Токен хүчингүй байна' 
      });
    }

    // Get user
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

    // Generate new tokens
    const tokens = generateTokens(user);

    // Update refresh token in Redis
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

// POST /auth/logout - Гарах
app.post('/auth/logout', async (req, res) => {
  try {
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ 
        success: false,
        error: 'userId шаардлагатай' 
      });
    }

    // Delete refresh token from Redis
    await redis.del(`refresh_token:${userId}`);
    
    // Delete location data
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

// GET /users/:id - Хэрэглэгчийн мэдээлэл
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

// ✅ FIXED: PUT /users/:id - Enhanced validation
app.put('/users/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, email, currentPassword, newPassword } = req.body;

    const updates = [];
    const values = [];
    let paramIndex = 1;

    if (name) {
      // Sanitize name
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

    // Password update
    if (currentPassword && newPassword) {
      // Validate new password
      const passwordValidation = validatePassword(newPassword);
      if (!passwordValidation.valid) {
        return res.status(400).json({
          success: false,
          error: passwordValidation.error
        });
      }

      // Verify current password
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

      // ✅ FIXED: Stronger hashing
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

// GET /users/:id/notification-settings - Мэдэгдлийн тохиргоо
app.get('/users/:id/notification-settings', async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      'SELECT * FROM notification_settings WHERE user_id = $1',
      [id]
    );

    if (result.rows.length === 0) {
      // Create default settings
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

// PUT /users/:id/notification-settings - Мэдэгдлийн тохиргоо шинэчлэх
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

// Health check
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

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully...');
  await pool.end();
  await redis.quit();
  process.exit(0);
});

app.listen(PORT, () => {
  console.log(`👤 User Service running on port ${PORT}`);
  console.log(`🔒 Bcrypt rounds: ${BCRYPT_ROUNDS}`);
  console.log(`🔐 JWT configured: ${!!JWT_SECRET}`);
});

module.exports = app;