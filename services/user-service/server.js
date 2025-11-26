const express = require('express');
const {
  config,
  database,
  middleware,
  utils
} = require('./shared');

const app = express();
const PORT = config.port || 3001;

const pool = database.getPool();
const redis = database.getRedis();

const loginAttemptTracker = new utils.LoginAttemptTracker();

setInterval(() => loginAttemptTracker.cleanup(), 60 * 60 * 1000);

app.use(middleware.corsMiddleware);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(middleware.requestLogger);
app.use(middleware.sanitizeBody);

app.get('/health', middleware.healthCheck('user-service', '1.0.0'));

app.post('/auth/register', async (req, res) => {
  try {
    const { phone, email, name, password } = req.body;

    if (!phone || !name || !password) {
      return res.status(400).json(
        utils.errorResponse('Утасны дугаар, нэр, нууц үг заавал оруулна уу', 400)
      );
    }

    if (!utils.validatePhone(phone)) {
      return res.status(400).json(
        utils.errorResponse('Утасны дугаар буруу форматтай байна (+976XXXXXXXX)', 400)
      );
    }

    if (email && !utils.validateEmail(email)) {
      return res.status(400).json(
        utils.errorResponse('Имэйл хаяг буруу форматтай байна', 400)
      );
    }

    const passwordValidation = utils.validatePassword(password);
    if (!passwordValidation.valid) {
      return res.status(400).json(
        utils.errorResponse(passwordValidation.error, 400)
      );
    }

    const user = await database.withTransaction(async (client) => {
      const existingUser = await client.query(
        email
          ? 'SELECT id FROM users WHERE phone = $1 OR email = $2'
          : 'SELECT id FROM users WHERE phone = $1',
        email ? [phone, email] : [phone]
      );

      if (existingUser.rows.length > 0) {
        const error = new Error('Энэ утас эсвэл имэйл хаяг бүртгэгдсэн байна');
        error.statusCode = 409;
        throw error;
      }

      const passwordHash = await utils.hashPassword(password);

      const result = await client.query(
        `INSERT INTO users (phone, email, name, password_hash, role)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, phone, email, name, role, created_at`,
        [phone, email || null, name, passwordHash, 'user']
      );

      const newUser = result.rows[0];

      await client.query(
        `INSERT INTO notification_settings (user_id, push_enabled, radius)
         VALUES ($1, $2, $3)`,
        [newUser.id, true, config.notification.defaultRadius]
      );

      return newUser;
    });

    const tokens = utils.generateTokens(user);

    await redis.setex(
      `refresh_token:${user.id}`,
      30 * 24 * 60 * 60,
      tokens.refreshToken
    );

    res.status(201).json(
      utils.successResponse({
        user: utils.sanitizeUser(user),
        ...tokens
      }, 'Амжилттай бүртгэгдлээ')
    );

  } catch (error) {
    utils.logError(error, { endpoint: '/auth/register' });

    const statusCode = error.statusCode || 500;
    res.status(statusCode).json(
      utils.errorResponse(
        config.env === 'production' && statusCode === 500
          ? 'Бүртгэлд алдаа гарлаа'
          : error.message,
        statusCode
      )
    );
  }
});

app.post('/auth/login', async (req, res) => {
  try {
    const { phone, password } = req.body;

    if (!phone || !password) {
      return res.status(400).json(
        utils.errorResponse('Утас болон нууц үг оруулна уу', 400)
      );
    }

    const attemptCheck = loginAttemptTracker.check(phone);
    if (!attemptCheck.allowed) {
      return res.status(429).json(
        utils.errorResponse(attemptCheck.message, 429)
      );
    }

    const result = await pool.query(
      'SELECT * FROM users WHERE phone = $1',
      [phone]
    );

    if (result.rows.length === 0) {
      loginAttemptTracker.recordFailure(phone);
      return res.status(401).json(
        utils.errorResponse('Хэрэглэгч олдсонгүй эсвэл нууц үг буруу', 401)
      );
    }

    const user = result.rows[0];
    const isValidPassword = await utils.comparePassword(password, user.password_hash);

    if (!isValidPassword) {
      loginAttemptTracker.recordFailure(phone);
      return res.status(401).json(
        utils.errorResponse('Хэрэглэгч олдсонгүй эсвэл нууц үг буруу', 401)
      );
    }

    loginAttemptTracker.reset(phone);

    const tokens = utils.generateTokens(user);

    await redis.setex(
      `refresh_token:${user.id}`,
      30 * 24 * 60 * 60,
      tokens.refreshToken
    );

    res.json(
      utils.successResponse({
        user: utils.sanitizeUser(user),
        ...tokens
      }, 'Амжилттай нэвтэрлээ')
    );

  } catch (error) {
    utils.logError(error, { endpoint: '/auth/login' });
    res.status(500).json(
      utils.errorResponse('Нэвтрэхэд алдаа гарлаа', 500)
    );
  }
});

app.post('/auth/logout', async (req, res) => {
  try {
    const { userId } = req.body;

    if (userId) {
      await Promise.all([
        redis.del(`refresh_token:${userId}`),
        redis.del(`user:${userId}:location`)
      ]);
    }

    res.json(utils.successResponse(null, 'Амжилттай гарлаа'));

  } catch (error) {
    utils.logError(error, { endpoint: '/auth/logout' });
    res.status(500).json(
      utils.errorResponse('Гарахад алдаа гарлаа', 500)
    );
  }
});

app.get('/auth/profile', middleware.authenticateToken, async (req, res) => {
  try {
    const cacheKey = utils.createCacheKey('user', 'profile', req.user.userId);
    const cached = await redis.get(cacheKey);

    if (cached) {
      return res.json({
        ...JSON.parse(cached),
        cached: true
      });
    }

    const result = await pool.query(
      'SELECT id, phone, email, name, role, created_at FROM users WHERE id = $1',
      [req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json(
        utils.errorResponse('Хэрэглэгч олдсонгүй', 404)
      );
    }

    const user = result.rows[0];
    const response = utils.successResponse({ user }, 'Амжилттай');

    await redis.setex(cacheKey, config.cache.userProfile, JSON.stringify(response));

    res.json(response);

  } catch (error) {
    utils.logError(error, { endpoint: '/auth/profile', userId: req.user.userId });
    res.status(500).json(
      utils.errorResponse('Профайл авахад алдаа гарлаа', 500)
    );
  }
});

app.put('/auth/profile', middleware.authenticateToken, async (req, res) => {
  try {
    const { name, email, phone, currentPassword } = req.body;
    const userId = req.user.userId;

    if (!currentPassword) {
      return res.status(400).json(
        utils.errorResponse('Одоогийн нууц үг оруулна уу', 400)
      );
    }

    if (!name && !email && !phone) {
      return res.status(400).json(
        utils.errorResponse('Шинэчлэх мэдээлэл оруулна уу', 400)
      );
    }

    if (phone && !utils.validatePhone(phone)) {
      return res.status(400).json(
        utils.errorResponse('Утасны дугаар буруу форматтай байна (+976XXXXXXXX)', 400)
      );
    }

    if (email && !utils.validateEmail(email)) {
      return res.status(400).json(
        utils.errorResponse('Имэйл хаяг буруу форматтай байна', 400)
      );
    }

    const updatedUser = await database.withTransaction(async (client) => {
      const userResult = await client.query(
        'SELECT password_hash FROM users WHERE id = $1',
        [userId]
      );

      if (userResult.rows.length === 0) {
        const error = new Error('Хэрэглэгч олдсонгүй');
        error.statusCode = 404;
        throw error;
      }

      const isValidPassword = await utils.comparePassword(
        currentPassword,
        userResult.rows[0].password_hash
      );

      if (!isValidPassword) {
        const error = new Error('Одоогийн нууц үг буруу байна');
        error.statusCode = 401;
        throw error;
      }

      if (phone || email) {
        const duplicateCheck = await client.query(
          `SELECT id FROM users
           WHERE (phone = $1 OR email = $2) AND id != $3`,
          [phone || '', email || '', userId]
        );

        if (duplicateCheck.rows.length > 0) {
          const error = new Error('Энэ утас эсвэл имэйл хаяг бүртгэгдсэн байна');
          error.statusCode = 409;
          throw error;
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

      return result.rows[0];
    });

    await redis.del(utils.createCacheKey('user', 'profile', userId));

    res.json(
      utils.successResponse(
        { user: updatedUser },
        'Профайл амжилттай шинэчлэгдлээ'
      )
    );

  } catch (error) {
    utils.logError(error, { endpoint: '/auth/profile', userId: req.user.userId });

    const statusCode = error.statusCode || 500;
    res.status(statusCode).json(
      utils.errorResponse(
        config.env === 'production' && statusCode === 500
          ? 'Профайл шинэчлэхэд алдаа гарлаа'
          : error.message,
        statusCode
      )
    );
  }
});

app.use(middleware.notFoundHandler);
app.use(middleware.errorHandler);

const server = app.listen(PORT, '0.0.0.0', () => {
  utils.logInfo('═══════════════════════════════════════════════════════════');
  utils.logInfo(` User Service running on port ${PORT}`);
  utils.logInfo('═══════════════════════════════════════════════════════════');
  utils.logInfo(` Database: ${config.database.host}:${config.database.port}`);
  utils.logInfo(` Redis: ${config.redis.host}:${config.redis.port}`);
  utils.logInfo(` Environment: ${config.env}`);
  utils.logInfo('═══════════════════════════════════════════════════════════\n');
});

process.on('SIGTERM', async () => {
  utils.logInfo('SIGTERM signal received: closing HTTP server');
  server.close(async () => {
    await database.gracefulShutdown();
    utils.logInfo('HTTP server closed');
    process.exit(0);
  });
});

process.on('SIGINT', async () => {
  utils.logInfo('SIGINT signal received: closing HTTP server');
  server.close(async () => {
    await database.gracefulShutdown();
    utils.logInfo('HTTP server closed');
    process.exit(0);
  });
});

module.exports = app;
