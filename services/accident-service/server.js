const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { Blob } = require('buffer');

const upload = multer({ dest: 'uploads/' });
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');
const Redis = require('ioredis');
const { body, query, validationResult } = require('express-validator');
const jwt = require('jsonwebtoken');
const cron = require('node-cron');

function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
    credentials: true
  }
});

const PORT = process.env.PORT || 3002;

app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

app.use(helmet());
app.use(express.json({ limit: '10mb' }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

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
  console.log(' PostgreSQL connected');
});

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
  console.log(' Redis connected');
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
  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) {
      console.error('Token verification failed:', err.message);
      console.log('Token:', token);
      console.log('Secret used:', process.env.JWT_SECRET);
      return res.status(403).json({
        success: false,
        error: 'Хүчингүй токен'
      });
    }
    req.user = user;
    next();
  });
};

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

app.get('/accidents',
  authenticateToken,
  [
    query('status').optional().isIn(['reported', 'confirmed', 'resolved', 'false_alarm']),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('offset').optional().isInt({ min: 0 }),
    query('forceRefresh').optional().isBoolean(),
    query('userOnly').optional().isBoolean(),
    query('activeOnly').optional().isBoolean(),
  ],
  validate,
  async (req, res) => {
    try {
      const { status, limit = 100, offset = 0, forceRefresh, userOnly, activeOnly, minFalseReports } = req.query;
      const cacheKey = `accidents:${status || 'all'}:${userOnly ? 'user' : 'all'}:${activeOnly ? 'active' : 'all'}:${minFalseReports || 0}:${limit}:${offset}`;
      if (!forceRefresh || forceRefresh === 'false') {
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
      }
      const currentUserId = req.user?.userId;
      console.log('🔍 DEBUG getAllAccidents:');
      console.log('  - userOnly parameter:', userOnly, 'type:', typeof userOnly);
      console.log('  - currentUserId from JWT:', currentUserId);
      console.log('  - req.user:', req.user);
      let queryText = `
        SELECT
          a.*,
          u.name as reported_by_name,
          u.phone as reported_by_phone,
          c.name as camera_name,
          COUNT(DISTINCT fr.id) as false_report_count,
          AVG(aid.confidence)::float as avg_confidence,
          EXISTS(
            SELECT 1 FROM false_reports fr2
            WHERE fr2.accident_id = a.id AND fr2.user_id = $1
          ) as user_has_reported
        FROM accidents a
        LEFT JOIN users u ON a.user_id = u.id
        LEFT JOIN cameras c ON a.camera_id = c.id
        LEFT JOIN false_reports fr ON a.id = fr.accident_id
        LEFT JOIN videos v ON a.video_id = v.id
        LEFT JOIN ai_detections aid ON v.id = aid.video_id
        WHERE 1=1
      `;
      const params = [currentUserId];
      let paramIndex = 2;
      if (userOnly === 'true' || userOnly === true) {
        console.log('   APPLYING userOnly filter - user_id =', currentUserId);
        queryText += ` AND a.user_id = $${paramIndex++}`;
        params.push(currentUserId);
      } else {
        console.log('   NOT applying userOnly filter');
      }
      if (status) {
        queryText += ` AND a.status = $${paramIndex++}`;
        params.push(status);
      }

      if (activeOnly === 'true' || activeOnly === true) {
        queryText += ` AND a.status IN ('reported', 'confirmed')`;
        queryText += ` AND a.resolved_at IS NULL`;
        queryText += ` AND (a.confirmed_at IS NULL OR a.confirmed_at > NOW() - INTERVAL '4 hours')`;
        queryText += ` AND a.accident_time > NOW() - INTERVAL '4 hours'`;
        console.log('   APPLYING activeOnly filter for map view');
      }

      queryText += `
        GROUP BY a.id, u.name, u.phone, c.name
      `;

      if (minFalseReports) {
        queryText += ` HAVING COUNT(DISTINCT fr.id) >= $${paramIndex++}`;
        params.push(parseInt(minFalseReports));
      }

      queryText += `
        ORDER BY a.accident_time DESC
        LIMIT $${paramIndex++} OFFSET $${paramIndex++}
      `;
      params.push(parseInt(limit), parseInt(offset));
      console.log('  - Final SQL params:', params);
      console.log('  - SQL includes user filter:', queryText.includes('a.user_id = $2') || queryText.includes('a.user_id = $3'));
      const result = await pool.query(queryText, params);
      console.log('  - Query returned', result.rows.length, 'accidents');
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
        videoId,
        imageUrl,
      } = req.body;
      const userId = req.user.userId;
      await client.query('BEGIN');

      const rateLimitCheck = await client.query(`
        SELECT ar.created_at, a.latitude, a.longitude, a.id
        FROM accident_reports ar
        JOIN accidents a ON ar.accident_id = a.id
        WHERE ar.user_id = $1
          AND ar.created_at > NOW() - INTERVAL '15 minutes'
        ORDER BY ar.created_at DESC
        LIMIT 1
      `, [userId]);

      if (rateLimitCheck.rows.length > 0) {
        const lastReport = rateLimitCheck.rows[0];
        const minutesAgo = Math.floor((Date.now() - new Date(lastReport.created_at).getTime()) / 60000);
        const remainingMinutes = 15 - minutesAgo;

        await client.query('ROLLBACK');

        return res.status(429).json({
          success: false,
          error: `Та ${remainingMinutes} минутын дараа дахин мэдээлэх боломжтой`,
          rateLimited: true,
          remainingMinutes: remainingMinutes,
          message: `Хэт олон мэдээлэл илгээж байна. ${remainingMinutes} минут хүлээнэ үү.`
        });
      }

      const DUPLICATE_RADIUS_METERS = 200;
      const DUPLICATE_TIME_MINUTES = 60;

      console.log(` Checking for duplicates at ${latitude}, ${longitude} within ${DUPLICATE_RADIUS_METERS}m and ${DUPLICATE_TIME_MINUTES} min`);

      let existingAccident = null;
      try {
        const recentAccidents = await client.query(`
          SELECT id, report_count, description, latitude, longitude, video_id
          FROM accidents
          WHERE status IN ('reported', 'confirmed')
          AND accident_time > NOW() - INTERVAL '${DUPLICATE_TIME_MINUTES} minutes'
          ORDER BY accident_time DESC
          LIMIT 100
        `);

        console.log(` Found ${recentAccidents.rows.length} recent accidents to check`);

        for (const accident of recentAccidents.rows) {
          if (videoId && accident.video_id && String(accident.video_id) === String(videoId)) {
            console.log(` Found duplicate by videoId! Accident #${accident.id}`);
            existingAccident = { ...accident, matchType: 'video' };
            break;
          }

          // 2. Check for proximity
          const distance = calculateDistance(
            parseFloat(latitude),
            parseFloat(longitude),
            parseFloat(accident.latitude),
            parseFloat(accident.longitude)
          );

          if (distance < DUPLICATE_RADIUS_METERS) {
            console.log(` Found duplicate by distance! Accident #${accident.id} at ${distance.toFixed(2)}m`);
            existingAccident = { ...accident, distance, matchType: 'distance' };
            break;
          }
        }

        if (!existingAccident) {
          console.log(` No duplicates found within ${DUPLICATE_RADIUS_METERS}m`);
        }
      } catch (dedupError) {
        console.error(` Deduplication check FAILED: ${dedupError.message}`);
        existingAccident = null;
      }

      const existingResult = existingAccident ? { rows: [existingAccident] } : { rows: [] };

      let accident;
      let isNewAccident = true;

      if (existingResult.rows.length > 0) {
        const existingAccident = existingResult.rows[0];

        const alreadyReported = await client.query(`
          SELECT id FROM accident_reports
          WHERE accident_id = $1 AND user_id = $2
        `, [existingAccident.id, userId]);

        const userHasReported = alreadyReported.rows.length > 0;

        const updateResult = await client.query(`
          UPDATE accidents
          SET report_count = report_count + 1,
              updated_at = NOW()
          WHERE id = $1
          RETURNING *
        `, [existingAccident.id]);

        accident = updateResult.rows[0];
        isNewAccident = false;

        if (!userHasReported) {
          await client.query(`
            INSERT INTO accident_reports (accident_id, user_id, video_id, latitude, longitude, description)
            VALUES ($1, $2, $3, $4, $5, $6)
            `, [existingAccident.id, userId, videoId, latitude, longitude, description]);
        } else {
          console.log(`ℹ User ${userId} already reported accident #${existingAccident.id}.Skipping report insertion.`);
          if (description) {
            await client.query(`
              UPDATE accident_reports
              SET description = $1
              WHERE accident_id = $2 AND user_id = $3
            `, [description, existingAccident.id, userId]);
          }
        }

        // Link video to existing accident if provided
        if (videoId) {
          await client.query(`
            UPDATE videos SET accident_id = $1 WHERE id = $2
            `, [existingAccident.id, videoId]);
        }

        console.log(` Added report to existing accident #${existingAccident.id}(now ${accident.report_count} reports)`);
      } else {
        const accidentResult = await client.query(`
          INSERT INTO accidents(
              user_id, latitude, longitude, description,
              status, source, video_id, image_url, accident_time, report_count
            )
          VALUES($1, $2, $3, $4, $5, $6, $7, $8, NOW(), 1)
          RETURNING *
            `, [userId, latitude, longitude, description, 'reported', 'user', videoId, imageUrl]);
        accident = accidentResult.rows[0];

        await client.query(`
          INSERT INTO accident_reports(accident_id, user_id, video_id, latitude, longitude, description)
          VALUES($1, $2, $3, $4, $5, $6)
              `, [accident.id, userId, videoId, latitude, longitude, description]);
      }

      await client.query(`
        INSERT INTO locations(user_id, latitude, longitude, timestamp)
        VALUES($1, $2, $3, NOW())
              `, [userId, latitude, longitude]);
      await client.query('COMMIT');
      try {
        const keys = await redis.keys('accidents:*');
        if (keys.length > 0) {
          await redis.del(...keys);
        }
      } catch (redisErr) {
        console.warn('Cache clear failed:', redisErr.message);
      }

      if (isNewAccident) {
        notifyNearbyUsers(accident, 5000).catch(err =>
          console.error('Notification error:', err)
        );
      }

      res.status(201).json({
        success: true,
        message: isNewAccident ? 'Осол амжилттай бүртгэгдлээ' : 'Одоо байгаа ослын мэдээлэлд нэмэгдлээ',
        data: accident,
        isNewAccident,
        reportCount: accident.report_count
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

app.post('/accidents/report-image',
  authenticateToken,
  upload.single('image'),
  async (req, res) => {
    const client = await pool.connect();
    try {
      const { latitude, longitude, description, analysisData } = req.body;
      const userId = req.user.userId;

      console.log(` Received image report from Report Service for user ${userId}`);

      if (!req.file) {
        return res.status(400).json({ success: false, error: 'Image file is required' });
      }

      let analysis = {};
      try {
        if (analysisData) {
          analysis = JSON.parse(analysisData);
        }
      } catch (e) {
        console.warn('Failed to parse analysis data:', e);
      }

      const imageUrl = `${process.env.API_URL || 'http://localhost:3002'}/uploads/${req.file.filename}`;

      await client.query('BEGIN');

      const rateLimitCheck = await client.query(`
        SELECT ar.created_at, a.latitude, a.longitude, a.id
        FROM accident_reports ar
        JOIN accidents a ON ar.accident_id = a.id
        WHERE ar.user_id = $1
          AND ar.created_at > NOW() - INTERVAL '15 minutes'
        ORDER BY ar.created_at DESC
        LIMIT 1
      `, [userId]);

      if (rateLimitCheck.rows.length > 0) {
        const lastReport = rateLimitCheck.rows[0];
        const minutesAgo = Math.floor((Date.now() - new Date(lastReport.created_at).getTime()) / 60000);
        const remainingMinutes = 15 - minutesAgo;

        await client.query('ROLLBACK');

        if (req.file && fs.existsSync(req.file.path)) {
          fs.unlinkSync(req.file.path);
        }

        return res.status(429).json({
          success: false,
          error: `Та ${remainingMinutes} минутын дараа дахин мэдээлэх боломжтой`,
          rateLimited: true,
          remainingMinutes: remainingMinutes,
          message: `Хэт олон мэдээлэл илгээж байна. ${remainingMinutes} минут хүлээнэ үү.`
        });
      }

      const nearbyCheck = await client.query(`
        SELECT id, latitude, longitude, report_count, description
        FROM accidents
        WHERE status IN ('reported', 'confirmed')
          AND accident_time > NOW() - INTERVAL '2 hours'
          AND calculate_distance($1, $2, latitude, longitude) <= 100
        ORDER BY calculate_distance($1, $2, latitude, longitude) ASC
        LIMIT 1
      `, [latitude, longitude]);

      let accident;
      let isNewAccident = false;

      if (nearbyCheck.rows.length > 0) {
        const existingAccident = nearbyCheck.rows[0];
        console.log(` Found existing accident ${existingAccident.id} within 100m - merging reports`);

        const updateResult = await client.query(`
          UPDATE accidents
          SET report_count = report_count + 1,
              updated_at = NOW()
          WHERE id = $1
          RETURNING *
        `, [existingAccident.id]);

        accident = updateResult.rows[0];
        isNewAccident = false;
      } else {
        console.log(` No nearby accident found - creating new accident`);

        const accidentResult = await client.query(`
          INSERT INTO accidents(
              user_id, latitude, longitude, description,
              status, source, image_url, accident_time, report_count
            )
          VALUES($1, $2, $3, $4, $5, $6, $7, NOW(), 1)
          RETURNING *
            `, [
          userId,
          latitude,
          longitude,
          description || analysis.description || 'AI Detected Accident',
          'confirmed',
          'user',
          imageUrl
        ]);

        accident = accidentResult.rows[0];
        isNewAccident = true;
      }

      try {
        await client.query(`
          INSERT INTO accident_reports(accident_id, user_id, latitude, longitude, description)
          VALUES($1, $2, $3, $4, $5)
          ON CONFLICT (user_id, accident_id) DO NOTHING
        `, [accident.id, userId, latitude, longitude, description || analysis.description]);
      } catch (reportErr) {
        console.warn('Report entry already exists:', reportErr.message);
      }

      await client.query('COMMIT');

      try {
        const keys = await redis.keys('accidents:*');
        if (keys.length > 0) await redis.del(...keys);
      } catch (redisErr) {
        console.warn('Cache clear failed:', redisErr.message);
      }

      if (isNewAccident) {
        console.log(` Notifying nearby users about new accident ${accident.id}`);
        notifyNearbyUsers(accident, 5000).catch(err =>
          console.error('Notification error:', err)
        );
      } else {
        console.log(` Skipping notification - duplicate report for existing accident ${accident.id}`);
      }

      res.status(201).json({
        success: true,
        message: isNewAccident ? 'Осол амжилттай бүртгэгдлээ' : 'Таны мэдээлэл бүртгэгдлээ',
        data: accident,
        isDuplicate: !isNewAccident
      });

    } catch (error) {
      await client.query('ROLLBACK');
      console.error('POST /accidents/report-image error:', error);
      if (req.file && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
      res.status(500).json({
        success: false,
        error: 'Осол бүртгэхэд алдаа гарлаа'
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
      const currentUserId = req.user?.userId;
      const result = await pool.query(`
        SELECT a.*,
            u.name as reported_by_name,
            u.phone as reported_by_phone,
            v.file_path as video_path,
            v.duration as video_duration,
            aid.confidence as ai_confidence,
            aid.detected_objects,
            c.name as camera_name,
            c.location as camera_location,
            EXISTS(
              SELECT 1 FROM false_reports fr
                 WHERE fr.accident_id = a.id AND fr.user_id = $2
            ) as user_has_reported
        FROM accidents a
        LEFT JOIN users u ON a.user_id = u.id
        LEFT JOIN videos v ON a.video_id = v.id
        LEFT JOIN ai_detections aid ON v.id = aid.video_id
        LEFT JOIN cameras c ON a.camera_id = c.id
        WHERE a.id = $1
      `, [id, currentUserId]);

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

      let additionalFields = '';
      if (status === 'confirmed') {
        additionalFields = ', confirmed_at = NOW()';
      } else if (status === 'resolved') {
        additionalFields = ', resolved_at = NOW()';
      }

      const result = await pool.query(`
        UPDATE accidents
        SET status = $1, updated_at = NOW()${additionalFields}
        WHERE id = $2
      RETURNING *
            `, [status, id]);
      if (result.rows.length === 0) {
        return res.status(404).json({
          success: false,
          error: 'Осол олдсонгүй'
        });
      }
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

app.post('/accidents/:id/resolve',
  authenticateToken,
  async (req, res) => {
    try {
      const { id } = req.params;
      const userId = req.user.userId;

      const accidentCheck = await pool.query(`
        SELECT user_id FROM accidents WHERE id = $1
            `, [id]);

      if (accidentCheck.rows.length === 0) {
        return res.status(404).json({
          success: false,
          error: 'Осол олдсонгүй'
        });
      }

      const result = await pool.query(`
        UPDATE accidents
        SET status = 'resolved', resolved_at = NOW(), updated_at = NOW()
        WHERE id = $1
      RETURNING *
            `, [id]);

      try {
        const keys = await redis.keys('accidents:*');
        if (keys.length > 0) {
          await redis.del(...keys);
        }
      } catch (redisErr) {
        console.warn('Cache clear failed:', redisErr.message);
      }

      io.emit('accident_resolved', {
        accidentId: parseInt(id),
        resolvedAt: new Date().toISOString()
      });

      console.log(` Accident #${id} resolved by user ${userId} `);

      res.json({
        success: true,
        message: 'Осол шийдэгдсэн гэж тэмдэглэгдлээ',
        data: result.rows[0]
      });
    } catch (error) {
      console.error('POST /accidents/:id/resolve error:', error);
      res.status(500).json({
        success: false,
        error: 'Осол шийдвэрлэхэд алдаа гарлаа'
      });
    }
  }
);

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
    for (const userId of nearbyUsers) {
      const socketId = userSockets.get(userId);
      if (socketId) {
        io.to(socketId).emit('new_accident', {
          accidentId: accident.id,
          latitude: accident.latitude,
          longitude: accident.longitude,
          description: accident.description,
          timestamp: accident.accident_time,
        });
      }
    }
    if (nearbyUsers.length > 0) {
      try {
        const notificationServiceUrl = process.env.NOTIFICATION_SERVICE_URL || 'http://notification-service:3005';
        const axios = require('axios');
        await axios.post(
          `${notificationServiceUrl}/notifications/send`,
          {
            userIds: nearbyUsers.map(id => parseInt(id)),
            accidentId: accident.id,
            type: 'accident_confirmed',
            title: `🚨 Осол илэрлээ`,
            message: `AI-аар баталгаажсан осол илэрлээ. ${accident.description ? accident.description.substring(0, 50) : 'Байршил: ' + accident.latitude + ', ' + accident.longitude}`,
            data: {
              latitude: String(accident.latitude),
              longitude: String(accident.longitude),
              accidentId: String(accident.id)
            }
          },
          { timeout: 10000 }
        );
        console.log(` Push notifications sent via notification service`);
      } catch (notifyErr) {
        console.error(' Failed to send push notifications:', notifyErr.message);
      }
    }
    console.log(`Notifications sent to ${nearbyUsers.length} users`);
  } catch (error) {
    console.error('Notify error:', error);
    throw error;
  }
}

app.post('/accidents/:id/report-false',
  authenticateToken,
  async (req, res) => {
    try {
      const { id } = req.params;
      const userId = req.user.userId;

      const accidentCheck = await pool.query('SELECT id FROM accidents WHERE id = $1', [id]);
      if (accidentCheck.rows.length === 0) {
        return res.status(404).json({ success: false, error: 'Осол олдсонгүй' });
      }

      const existingReport = await pool.query(
        'SELECT id FROM false_reports WHERE accident_id = $1 AND user_id = $2',
        [id, userId]
      );

      if (existingReport.rows.length > 0) {
        return res.status(400).json({ success: false, error: 'Та аль хэдийн худал дуудлага гэж мэдэгдсэн байна' });
      }

      await pool.query(
        'INSERT INTO false_reports (accident_id, user_id, reported_at) VALUES ($1, $2, NOW())',
        [id, userId]
      );

      try {
        const keys = await redis.keys('accidents:*');
        if (keys.length > 0) await redis.del(...keys);
      } catch (redisErr) {
        console.warn('Cache clear failed:', redisErr.message);
      }

      res.json({ success: true, message: 'Худал дуудлага гэж мэдэгдлээ' });
    } catch (error) {
      console.error('POST /accidents/:id/report-false error:', error);
      res.status(500).json({ success: false, error: 'Худал дуудлага мэдээлэхэд алдаа гарлаа' });
    }
  }
);

app.get('/admin/health', authenticateToken, async (req, res) => {
  const health = {
    service: 'accident-service',
    status: 'healthy',
    timestamp: new Date(),
    components: {
      database: { status: 'unknown' },
      redis: { status: 'unknown' },
      geminiService: { status: 'unknown' }
    }
  };

  try {
    await pool.query('SELECT 1');
    health.components.database.status = 'healthy';
  } catch (e) {
    health.components.database.status = 'unhealthy';
    health.components.database.error = e.message;
    health.status = 'degraded';
  }

  try {
    await redis.ping();
    health.components.redis.status = 'healthy';
  } catch (e) {
    health.components.redis.status = 'unhealthy';
    health.components.redis.error = e.message;
    health.status = 'degraded';
  }

  try {
    const axios = require('axios');
    const geminiUrl = process.env.GEMINI_SERVICE_URL || 'http://localhost:3010';
    const response = await axios.get(`${geminiUrl}/health`, { timeout: 2000 });
    health.components.geminiService.status = response.data.status === 'healthy' ? 'healthy' : 'unhealthy';
  } catch (e) {
    health.components.geminiService.status = 'unhealthy';
    health.components.geminiService.error = e.message;
    health.status = 'degraded';
  }

  res.json(health);
});

app.post('/accidents/:id/notify', async (req, res) => {
  try {
    const { id } = req.params;
    const { message } = req.body;
    const accidentResult = await pool.query('SELECT * FROM accidents WHERE id = $1', [id]);
    if (accidentResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Осол олдсонгүй'
      });
    }
    const accident = accidentResult.rows[0];
    notifyNearbyUsers(accident, 5000).catch(err =>
      console.error('Notification error:', err)
    );
    try {
      const mapKeys = await redis.keys('accidents:*');
      if (mapKeys.length > 0) {
        await redis.del(...mapKeys);
      }
    } catch (redisErr) {
      console.warn('Cache clear failed:', redisErr.message);
    }
    res.json({
      success: true,
      message: 'Мэдэгдэл илгээгдлээ'
    });
  } catch (error) {
    console.error('POST /accidents/:id/notify error:', error);
    res.status(500).json({
      success: false,
      error: 'Мэдэгдэл илгээхэд алдаа гарлаа'
    });
  }
});

app.get('/health', async (req, res) => {
  const health = {
    status: 'healthy',
    service: 'accident-service',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  };
  let hasError = false;
  try {
    await pool.query('SELECT 1');
    health.database = 'connected';
  } catch (err) {
    health.database = 'disconnected';
    health.databaseError = err.message;
    health.status = 'unhealthy';
    hasError = true;
  }
  try {
    await redis.ping();
    health.redis = 'connected';
  } catch (err) {
    health.redis = 'disconnected';
    health.redisError = err.message;
    health.status = 'unhealthy';
    hasError = true;
  }
  health.socketio = {
    connected: io.engine.clientsCount,
    registered: userSockets.size
  };
  const statusCode = hasError ? 503 : 200;
  res.status(statusCode).json(health);
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

process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully...');
  server.close(() => {
    console.log('HTTP server closed');
  });
  io.close(() => {
    console.log('Socket.IO closed');
  });
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

cron.schedule('*/10 * * * *', async () => {
  try {
    console.log(' Running auto-resolution check...');
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const result = await pool.query(`
      UPDATE accidents
      SET status = 'resolved', updated_at = NOW()
      WHERE id IN(
              SELECT a.id
        FROM accidents a
        LEFT JOIN false_reports fr ON a.id = fr.accident_id
        WHERE a.status IN('confirmed', 'reported')
          AND a.accident_time < $1
        GROUP BY a.id
        HAVING COUNT(fr.id) = 0
            )
      RETURNING id, accident_time, status
            `, [oneHourAgo]);
    if (result.rowCount > 0) {
      console.log(` Auto - resolved ${result.rowCount} accident(s) older than 1 hour`);
      result.rows.forEach(acc => {
        console.log(`   - Accident #${acc.id}(time: ${acc.accident_time})`);
      });
      try {
        const keys = await redis.keys('accidents:*');
        if (keys.length > 0) {
          await redis.del(...keys);
        }
      } catch (redisErr) {
        console.warn('Cache clear failed:', redisErr.message);
      }
    } else {
      console.log('   No accidents to auto-resolve');
    }
  } catch (error) {
    console.error(' Auto-resolution error:', error.message);
  }
});

console.log(' Auto-resolution scheduler started (every 10 minutes)');

server.listen(PORT, () => {
  console.log(`Accident Service running on port ${PORT} `);
  console.log(`Socket.IO ready for WebSocket connections`);
  console.log(`Security: Helmet enabled`);
  console.log(`Rate limiting: User - based(100 req / min)`);
  console.log(`Database: ${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || 5432} `);
  console.log(`Redis: ${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || 6379} `);
  console.log(`Auto - resolution: Enabled(1 hour threshold)`);
});

module.exports = app;