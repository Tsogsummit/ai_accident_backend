// Accident service

const express = require('express');
const { Pool } = require('pg');
const Redis = require('ioredis');
const { Server } = require('socket.io');
const http = require('http');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { body, validationResult, query } = require('express-validator');
const jwt = require('jsonwebtoken');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { 
    origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
    credentials: true 
  }
});

const PORT = process.env.PORT || 3002;

// Security middleware
app.use(helmet());
app.use(express.json({ limit: '10mb' }));

// User-based rate limiting
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  message: 'Хэт олон хүсэлт илгээлээ',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    return req.user?.userId 
      ? `${req.user.userId}:${req.ip}` 
      : req.ip;
  }
});
app.use('/api/', limiter);

// PostgreSQL database connection pool
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
  console.error('Unexpected error on idle client', err);
});

pool.on('connect', () => {
  console.log('✅ PostgreSQL connected');
});

// Redis client for caching and location storage
const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: process.env.REDIS_PORT || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
  retryStrategy: (times) => {
    if (times > 10) {
      console.error('Redis: Max retries reached');
      return null;
    }
    const delay = Math.min(times * 50, 2000);
    console.log(`Redis: Retry attempt ${times}, waiting ${delay}ms`);
    return delay;
  },
  maxRetriesPerRequest: 3,
  enableOfflineQueue: false,
});

redis.on('error', (err) => {
  console.error('Redis error:', err.message);
});

redis.on('connect', () => {
  console.log('✅ Redis connected');
});

// JWT Authentication Middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ 
      success: false, 
      error: 'Нэвтрэх шаардлагатай' 
    });
  }

  jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key', (err, user) => {
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

// Validation error handling middleware
const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ 
      success: false, 
      errors: errors.array() 
    });
  }
  next();
};

// Socket.IO connection management
const userSockets = new Map();

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('register', (userId) => {
    userSockets.set(userId.toString(), socket.id);
    socket.userId = userId;
    console.log(`User ${userId} registered`);
  });

  socket.on('update-location', async ({ latitude, longitude }) => {
    if (socket.userId) {
      try {
        await redis.setex(
          `user:${socket.userId}:location`,
          300,
          JSON.stringify({ latitude, longitude, timestamp: Date.now() })
        );
      } catch (err) {
        console.error('Location update error:', err);
      }
    }
  });

  socket.on('disconnect', () => {
    if (socket.userId) {
      userSockets.delete(socket.userId.toString());
      console.log(`User ${socket.userId} disconnected`);
    }
  });
});

// ACCIDENTS API

app.get('/accidents', 
  authenticateToken,
  [
    query('status').optional().isIn(['reported', 'confirmed', 'resolved', 'false_alarm']),
    query('severity').optional().isIn(['minor', 'moderate', 'severe']),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('offset').optional().isInt({ min: 0 }),
  ],
  validate,
  async (req, res) => {
    try {
      const { status, severity, limit = 100, offset = 0 } = req.query;

      // Cache key
      const cacheKey = `accidents:${status || 'all'}:${severity || 'all'}:${limit}:${offset}`;
      
      // Check cache
      try {
        const cached = await redis.get(cacheKey);
        if (cached) {
          return res.json({
            success: true,
            source: 'cache',
            data: JSON.parse(cached),
          });
        }
      } catch (redisErr) {
        console.warn('Redis cache read failed:', redisErr.message);
      }

      let queryText = `
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
        queryText += ` AND a.status = $${paramIndex++}`;
        params.push(status);
      }

      if (severity) {
        queryText += ` AND a.severity = $${paramIndex++}`;
        params.push(severity);
      }

      queryText += `
        GROUP BY a.id, u.name, u.phone, c.name
        ORDER BY a.accident_time DESC
        LIMIT $${paramIndex++} OFFSET $${paramIndex++}
      `;
      
      params.push(parseInt(limit), parseInt(offset));

      const result = await pool.query(queryText, params);

      // Store in cache
      try {
        await redis.setex(cacheKey, 300, JSON.stringify(result.rows));
      } catch (redisErr) {
        console.warn('Redis cache write failed:', redisErr.message);
      }

      res.json({
        success: true,
        source: 'database',
        data: result.rows,
        total: result.rowCount,
      });

    } catch (error) {
      console.error('GET /accidents error:', error);
      res.status(500).json({ 
        success: false, 
        error: 'Ослын мэдээлэл татахад алдаа гарлаа',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  }
);

app.post('/accidents',
  authenticateToken,
  [
    body('latitude').isFloat({ min: -90, max: 90 }),
    body('longitude').isFloat({ min: -180, max: 180 }),
    body('description').trim().isLength({ min: 5, max: 500 }),
    body('severity').isIn(['minor', 'moderate', 'severe']),
    body('videoId').optional().isInt(),
    body('imageUrl').optional().isURL(),
  ],
  validate,
  async (req, res) => {
    const client = await pool.connect();
    
    try {
      const {
        latitude,
        longitude,
        description,
        severity = 'minor',
        videoId,
        imageUrl,
      } = req.body;

      const userId = req.user.userId;

      await client.query('BEGIN');

      const accidentResult = await client.query(`
        INSERT INTO accidents (
          user_id, latitude, longitude, description, 
          severity, status, source, video_id, image_url, accident_time
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
        RETURNING *
      `, [userId, latitude, longitude, description, severity, 'reported', 'user', videoId, imageUrl]);

      const accident = accidentResult.rows[0];

      // Store location
      await client.query(`
        INSERT INTO locations (user_id, latitude, longitude, timestamp)
        VALUES ($1, $2, $3, NOW())
      `, [userId, latitude, longitude]);

      await client.query('COMMIT');

      // Clear cache
      try {
        const keys = await redis.keys('accidents:*');
        if (keys.length > 0) {
          await redis.del(...keys);
        }
      } catch (redisErr) {
        console.warn('Cache clear failed:', redisErr.message);
      }

      // Notify nearby users
      notifyNearbyUsers(accident, 5000).catch(err => 
        console.error('Notification error:', err)
      );

      res.status(201).json({
        success: true,
        message: 'Осол амжилттай бүртгэгдлээ',
        data: accident,
      });

    } catch (error) {
      await client.query('ROLLBACK');
      console.error('POST /accidents error:', error);
      res.status(500).json({ 
        success: false, 
        error: 'Осол бүртгэхэд алдаа гарлаа',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    } finally {
      client.release();
    }
  }
);

app.get('/accidents/:id',
  authenticateToken,
  async (req, res) => {
    try {
      const { id } = req.params;

      if (!/^\d+$/.test(id)) {
        return res.status(400).json({ 
          success: false, 
          error: 'Буруу ID формат' 
        });
      }

      const result = await pool.query(`
        SELECT a.*, 
               u.name as reported_by_name,
               u.phone as reported_by_phone,
               v.file_path as video_path,
               v.duration as video_duration,
               aid.confidence as ai_confidence,
               aid.detected_objects,
               c.name as camera_name,
               c.location as camera_location
        FROM accidents a
        LEFT JOIN users u ON a.user_id = u.id
        LEFT JOIN videos v ON a.video_id = v.id
        LEFT JOIN ai_detections aid ON v.id = aid.video_id
        LEFT JOIN cameras c ON a.camera_id = c.id
        WHERE a.id = $1
      `, [id]);

      if (result.rows.length === 0) {
        return res.status(404).json({ 
          success: false, 
          error: 'Осол олдсонгүй' 
        });
      }

      res.json({
        success: true,
        data: result.rows[0],
      });

    } catch (error) {
      console.error('GET /accidents/:id error:', error);
      res.status(500).json({ 
        success: false, 
        error: 'Дэлгэрэнгүй татахад алдаа гарлаа' 
      });
    }
  }
);

app.put('/accidents/:id/status',
  authenticateToken,
  [
    body('status').isIn(['reported', 'confirmed', 'resolved', 'false_alarm']),
  ],
  validate,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { status } = req.body;

      const result = await pool.query(`
        UPDATE accidents 
        SET status = $1, updated_at = NOW()
        WHERE id = $2
        RETURNING *
      `, [status, id]);

      if (result.rows.length === 0) {
        return res.status(404).json({ 
          success: false, 
          error: 'Осол олдсонгүй' 
        });
      }

      // Clear cache
      try {
        const keys = await redis.keys('accidents:*');
        if (keys.length > 0) {
          await redis.del(...keys);
        }
      } catch (redisErr) {
        console.warn('Cache clear failed:', redisErr.message);
      }

      res.json({
        success: true,
        message: 'Төлөв шинэчлэгдлээ',
        data: result.rows[0],
      });

    } catch (error) {
      console.error('PUT /accidents/:id/status error:', error);
      res.status(500).json({ 
        success: false, 
        error: 'Төлөв шинэчлэхэд алдаа гарлаа' 
      });
    }
  }
);

// Notify nearby users about new accident

async function notifyNearbyUsers(accident, radiusMeters) {
  try {
    const keys = await redis.keys('user:*:location');
    const nearbyUsers = [];
    
    for (const key of keys) {
      try {
        const locationData = await redis.get(key);
        if (!locationData) continue;
        
        const { latitude, longitude } = JSON.parse(locationData);
        const distance = calculateDistance(
          accident.latitude,
          accident.longitude,
          latitude,
          longitude
        );
        
        if (distance <= radiusMeters) {
          const userId = key.split(':')[1];
          nearbyUsers.push(userId);
        }
      } catch (err) {
        console.error('Error processing user location:', err);
      }
    }

    // Send notifications via Socket.IO
    for (const userId of nearbyUsers) {
      const socketId = userSockets.get(userId);
      if (socketId) {
        io.to(socketId).emit('new_accident', {
          accidentId: accident.id,
          latitude: accident.latitude,
          longitude: accident.longitude,
          severity: accident.severity,
          description: accident.description,
          timestamp: accident.accident_time,
        });
      }
    }

    console.log(`Notifications sent to ${nearbyUsers.length} users`);

  } catch (error) {
    console.error('Notify error:', error);
    throw error;
  }
}

// Haversine formula
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371e3; // Earth radius in meter
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;

  const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
            Math.cos(φ1) * Math.cos(φ2) *
            Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}

app.get('/health', async (req, res) => {
  const health = {
    status: 'healthy',
    service: 'accident-service',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  };

  let hasError = false;

  // Check database
  try {
    await pool.query('SELECT 1');
    health.database = 'connected';
  } catch (err) {
    health.database = 'disconnected';
    health.databaseError = err.message;
    health.status = 'unhealthy';
    hasError = true;
  }

  // Check Redis
  try {
    await redis.ping();
    health.redis = 'connected';
  } catch (err) {
    health.redis = 'disconnected';
    health.redisError = err.message;
    health.status = 'unhealthy';
    hasError = true;
  }

  // Socket.IO status
  health.socketio = {
    connected: io.engine.clientsCount,
    registered: userSockets.size
  };

  const statusCode = hasError ? 503 : 200;
  res.status(statusCode).json(health);
});

// Error handling middleware
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
  
  // Close server
  server.close(() => {
    console.log('HTTP server closed');
  });
  
  // Close Socket.IO connections
  io.close(() => {
    console.log('Socket.IO closed');
  });
  
  // Close database and Redis
  await pool.end();
  await redis.quit();
  
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, shutting down...');
  await pool.end();
  await redis.quit();
  process.exit(0);
});

server.listen(PORT, () => {
  console.log(`Accident Service running on port ${PORT}`);
  console.log(`Socket.IO ready for WebSocket connections`);
  console.log(`Security: Helmet enabled`);
  console.log(`Rate limiting: User-based (100 req/min)`);
  console.log(`Database: ${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || 5432}`);
  console.log(`Redis: ${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || 6379}`);
});

module.exports = app;