// services/user-service/server.js
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
  password: process.env.DB_PASSWORD || 'postgres'
});

// Redis - session store
const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: process.env.REDIS_PORT || 6379
});

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
const JWT_EXPIRES_IN = '7d';
const REFRESH_TOKEN_EXPIRES_IN = '30d';

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

// POST /auth/register - Бүртгүүлэх
app.post('/auth/register', async (req, res) => {
  try {
    const { phone, email, name, password } = req.body;

    // Validation
    if (!phone || !name || !password) {
      return res.status(400).json({ 
        error: 'Утасны дугаар, нэр, нууц үг заавал оруулна уу' 
      });
    }

    if (password.length < 6) {
      return res.status(400).json({ 
        error: 'Нууц үг 6-аас дээш тэмдэгт байх ёстой' 
      });
    }

    // Check if user exists
    const existingUser = await pool.query(
      'SELECT id FROM users WHERE phone = $1 OR email = $2',
      [phone, email]
    );

    if (existingUser.rows.length > 0) {
      return res.status(409).json({ 
        error: 'Энэ утас эсвэл имэйл хаяг бүртгэгдсэн байна' 
      });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    // Create user
    const result = await pool.query(
      `INSERT INTO users (phone, email, name, password_hash, role, status)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, phone, email, name, role, created_at`,
      [phone, email, name, passwordHash, 'user', 'active']
    );

    const user = result.rows[0];

    // Create notification settings
    await pool.query(
      `INSERT INTO notification_settings (user_id, push_enabled, radius)
       VALUES ($1, $2, $3)`,
      [user.id, true, 5000]
    );

    // Generate tokens
    const tokens = generateTokens(user);

    // Store refresh token in Redis (30 days)
    await redis.setex(
      `refresh_token:${user.id}`,
      30 * 24 * 60 * 60,
      tokens.refreshToken
    );

    res.status(201).json({
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
    console.error('Register error:', error);
    res.status(500).json({ error: 'Бүртгэлд алдаа гарлаа' , details: error.message});
  }
});

// POST /auth/login - Нэвтрэх
app.post('/auth/login', async (req, res) => {
  try {
    const { phone, password } = req.body;

    if (!phone || !password) {
      return res.status(400).json({ 
        error: 'Утас болон нууц үг оруулна уу' 
      });
    }

    // Find user
    const result = await pool.query(
      'SELECT * FROM users WHERE phone = $1',
      [phone]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Хэрэглэгч олдсонгүй' });
    }

    const user = result.rows[0];

    // Check if account is active
    if (user.status !== 'active') {
      return res.status(403).json({ error: 'Таны эрх хаагдсан байна' });
    }

    // Verify password
    const isValidPassword = await bcrypt.compare(password, user.password_hash);
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Нууц үг буруу байна' });
    }

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
    res.status(500).json({ error: 'Нэвтрэхэд алдаа гарлаа' });
  }
});

// POST /auth/refresh - Token сэргээх
app.post('/auth/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(400).json({ error: 'Refresh token байхгүй байна' });
    }

    // Verify refresh token
    const decoded = jwt.verify(refreshToken, JWT_SECRET);
    
    if (decoded.type !== 'refresh') {
      return res.status(400).json({ error: 'Буруу токен төрөл' });
    }

    // Check if refresh token exists in Redis
    const storedToken = await redis.get(`refresh_token:${decoded.userId}`);
    if (storedToken !== refreshToken) {
      return res.status(401).json({ error: 'Токен хүчингүй байна' });
    }

    // Get user
    const result = await pool.query(
      'SELECT id, phone, email, name, role FROM users WHERE id = $1 AND status = $2',
      [decoded.userId, 'active']
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Хэрэглэгч олдсонгүй' });
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
      message: 'Токен сэргээгдлээ',
      ...tokens
    });

  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ error: 'Буруу токен' });
    }
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Токен хугацаа дууссан' });
    }
    console.error('Refresh token error:', error);
    res.status(500).json({ error: 'Токен сэргээхэд алдаа гарлаа' });
  }
});

// POST /auth/logout - Гарах
app.post('/auth/logout', async (req, res) => {
  try {
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ error: 'userId шаардлагатай' });
    }

    // Delete refresh token from Redis
    await redis.del(`refresh_token:${userId}`);
    
    // Delete location data
    await redis.del(`user:${userId}:location`);

    res.json({ message: 'Амжилттай гарлаа' });

  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ error: 'Гарахад алдаа гарлаа' });
  }
});

// GET /users/:id - Хэрэглэгчийн мэдээлэл
app.get('/users/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(`
      SELECT 
        u.id, u.phone, u.email, u.name, u.status, u.role, u.created_at,
        us.total_reports, us.confirmed_reports, us.false_reports_made
      FROM users u
      LEFT JOIN user_statistics us ON u.id = us.id
      WHERE u.id = $1
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Хэрэглэгч олдсонгүй' });
    }

    const user = result.rows[0];
    delete user.password_hash; // Never send password hash

    res.json(user);

  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Мэдээлэл авахад алдаа гарлаа' });
  }
});

// PUT /users/:id - Хэрэглэгчийн мэдээлэл засах
app.put('/users/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, email, currentPassword, newPassword } = req.body;

    const updates = [];
    const values = [];
    let paramIndex = 1;

    if (name) {
      updates.push(`name = $${paramIndex++}`);
      values.push(name);
    }

    if (email) {
      updates.push(`email = $${paramIndex++}`);
      values.push(email);
    }

    // Password update
    if (currentPassword && newPassword) {
      // Verify current password
      const userResult = await pool.query(
        'SELECT password_hash FROM users WHERE id = $1',
        [id]
      );

      if (userResult.rows.length === 0) {
        return res.status(404).json({ error: 'Хэрэглэгч олдсонгүй' });
      }

      const isValid = await bcrypt.compare(
        currentPassword,
        userResult.rows[0].password_hash
      );

      if (!isValid) {
        return res.status(401).json({ error: 'Одоогийн нууц үг буруу байна' });
      }

      const newPasswordHash = await bcrypt.hash(newPassword, 10);
      updates.push(`password_hash = $${paramIndex++}`);
      values.push(newPasswordHash);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'Өөрчлөх мэдээлэл байхгүй байна' });
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
      message: 'Мэдээлэл шинэчлэгдлээ',
      user: result.rows[0]
    });

  } catch (error) {
    console.error('Update user error:', error);
    res.status(500).json({ error: 'Шинэчлэхэд алдаа гарлаа' });
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
      return res.json(newSettings.rows[0]);
    }

    res.json(result.rows[0]);

  } catch (error) {
    console.error('Get notification settings error:', error);
    res.status(500).json({ error: 'Тохиргоо авахад алдаа гарлаа' });
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
      [pushEnabled, radius, accidentTypes, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Тохиргоо олдсонгүй' });
    }

    res.json({
      message: 'Тохиргоо шинэчлэгдлээ',
      settings: result.rows[0]
    });

  } catch (error) {
    console.error('Update notification settings error:', error);
    res.status(500).json({ error: 'Тохиргоо шинэчлэхэд алдаа гарлаа' });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    service: 'user-service',
    timestamp: new Date().toISOString()
  });
});

app.listen(PORT, () => {
  console.log(`👤 User Service запущен на порту ${PORT}`);
});

module.exports = app;