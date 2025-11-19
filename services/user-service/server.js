const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const Redis = require('ioredis');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 3001;
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  credentials: true,
  maxAge: 86400
}));
app.options('*', cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});
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
pool.on('connect', () => console.log('✅ PostgreSQL connected'));
const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: process.env.REDIS_PORT || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
  retryStrategy: (times) => Math.min(times * 50, 2000)
});
redis.on('error', (err) => console.error('Redis error:', err));
redis.on('connect', () => console.log('✅ Redis connected'));
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
const JWT_EXPIRES_IN = '7d';
const REFRESH_TOKEN_EXPIRES_IN = '30d';
const BCRYPT_ROUNDS = 12;
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
  return /^\+976\d{8}$/.test(phone);
}
function validateEmail(email) {
  if (!email) return true;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
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
  res.status(health.status === 'healthy' ? 200 : 503).json(health);
});
const loginAttempts = new Map();
function checkLoginAttempts(phone) {
  const key = `login:${phone}`;
  const attempts = loginAttempts.get(key) || { count: 0, lockedUntil: 0 };
  if (attempts.lockedUntil > Date.now()) {
    const remainingSec = Math.ceil((attempts.lockedUntil - Date.now()) / 1000);
    return {
      allowed: false,
      message: `Хэт олон буруу оролдлого. ${remainingSec} секундын дараа дахин оролдоно уу`
    };
  }
  if (attempts.lockedUntil > 0 && attempts.lockedUntil <= Date.now()) {
    loginAttempts.delete(key);
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
    const existingUser = await client.query(
      email 
        ? 'SELECT id FROM users WHERE phone = $1 OR email = $2'
        : 'SELECT id FROM users WHERE phone = $1',
      email ? [phone, email] : [phone]
    );
    if (existingUser.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ 
        success: false,
        error: 'Энэ утас эсвэл имэйл хаяг бүртгэгдсэн байна' 
      });
    }
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const result = await client.query(
      `INSERT INTO users (phone, email, name, password_hash, role, status)
       VALUES ($1, $2, $3, $4, $5, $6)
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
      error: 'Бүртгэлд алдаа гарлаа',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
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
      error: 'Нэвтрэхэд алдаа гарлаа',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});
app.post('/auth/logout', async (req, res) => {
  try {
    const { userId } = req.body;
    if (userId) {
      await redis.del(`refresh_token:${userId}`);
      await redis.del(`user:${userId}:location`);
    }
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
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) {
    return res.status(401).json({
      success: false,
      error: 'Нэвтрэх шаардлагатай'
    });
  }
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({
        success: false,
        error: 'Хүчингүй токен'
      });
    }
    req.user = user;
    next();
  });
};
app.get('/auth/profile', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, phone, email, name, role, created_at FROM users WHERE id = $1',
      [req.user.userId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Хэрэглэгч олдсонгүй'
      });
    }
    const user = result.rows[0];
    res.json({
      success: true,
      user: {
        id: user.id,
        phone: user.phone,
        email: user.email,
        name: user.name,
        role: user.role,
        created_at: user.created_at
      }
    });
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({
      success: false,
      error: 'Профайл авахад алдаа гарлаа'
    });
  }
});
app.put('/auth/profile', authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    const { name, email, phone, currentPassword } = req.body;
    const userId = req.user.userId;
    if (!currentPassword) {
      return res.status(400).json({
        success: false,
        error: 'Одоогийн нууц үг оруулна уу'
      });
    }
    if (!name && !email && !phone) {
      return res.status(400).json({
        success: false,
        error: 'Шинэчлэх мэдээлэл оруулна уу'
      });
    }
    const userResult = await client.query(
      'SELECT password_hash FROM users WHERE id = $1',
      [userId]
    );
    if (userResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Хэрэглэгч олдсонгүй'
      });
    }
    const isValidPassword = await bcrypt.compare(currentPassword, userResult.rows[0].password_hash);
    if (!isValidPassword) {
      return res.status(401).json({
        success: false,
        error: 'Одоогийн нууц үг буруу байна'
      });
    }
    if (phone && !validatePhone(phone)) {
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
    if (phone || email) {
      const duplicateCheck = await client.query(
        `SELECT id FROM users
         WHERE (phone = $1 OR email = $2) AND id != $3`,
        [phone || '', email || '', userId]
      );
      if (duplicateCheck.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          success: false,
          error: 'Энэ утас эсвэл имэйл хаяг бүртгэгдсэн байна'
        });
      }
    }
    const updates = [];
    const values = [];
    let paramCount = 1;
    if (name) {
      updates.push(`name = $${paramCount++}`);
      values.push(name);
    }
    if (email !== undefined) {
      updates.push(`email = $${paramCount++}`);
      values.push(email || null);
    }
    if (phone) {
      updates.push(`phone = $${paramCount++}`);
      values.push(phone);
    }
    values.push(userId);
    const result = await client.query(
      `UPDATE users
       SET ${updates.join(', ')}, updated_at = NOW()
       WHERE id = $${paramCount}
       RETURNING id, phone, email, name, role, created_at`,
      values
    );
    await client.query('COMMIT');
    const updatedUser = result.rows[0];
    res.json({
      success: true,
      message: 'Профайл амжилттай шинэчлэгдлээ',
      user: {
        id: updatedUser.id,
        phone: updatedUser.phone,
        email: updatedUser.email,
        name: updatedUser.name,
        role: updatedUser.role,
        created_at: updatedUser.created_at
      }
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Update profile error:', error);
    res.status(500).json({
      success: false,
      error: 'Профайл шинэчлэхэд алдаа гарлаа',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    client.release();
  }
});
app.use((req, res) => {
  res.status(404).json({ 
    success: false,
    error: 'Endpoint олдсонгүй',
    path: req.path 
  });
});
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    success: false,
    error: process.env.NODE_ENV === 'production' 
      ? 'Серверийн алдаа гарлаа' 
      : err.message,
  });
});
app.listen(PORT, '0.0.0.0', () => {
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`👤 User Service running on port ${PORT}`);
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`📊 Database: ${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || 5432}`);
  console.log(`💾 Redis: ${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || 6379}`);
  console.log('🔒 CORS: Enabled for all origins');
  console.log('🔐 Bcrypt rounds:', BCRYPT_ROUNDS);
  console.log('═══════════════════════════════════════════════════════════\n');
});
process.on('SIGTERM', async () => {
  console.log('Shutting down...');
  await pool.end();
  await redis.quit();
  process.exit(0);
});
module.exports = app;