// services/accident-service/server.js
const express = require('express');
const { Pool } = require('pg');
const Redis = require('ioredis');
const { Server } = require('socket.io');
const http = require('http');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const PORT = process.env.PORT || 3002;

app.use(express.json());

// PostgreSQL холболт
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

// Redis кэш
const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: process.env.REDIS_PORT || 6379,
  retryStrategy: (times) => Math.min(times * 50, 2000)
});

// Socket.IO холболт удирдах
const userSockets = new Map(); // userId -> socketId маппинг

io.on('connection', (socket) => {
  console.log('Client холбогдсон:', socket.id);

  socket.on('register', (userId) => {
    userSockets.set(userId, socket.id);
    socket.userId = userId;
    console.log(`User ${userId} бүртгэгдлээ`);
  });

  socket.on('update-location', async ({ latitude, longitude }) => {
    if (socket.userId) {
      await redis.setex(
        `user:${socket.userId}:location`,
        300, // 5 минут
        JSON.stringify({ latitude, longitude, timestamp: Date.now() })
      );
    }
  });

  socket.on('disconnect', () => {
    if (socket.userId) {
      userSockets.delete(socket.userId);
      console.log(`User ${socket.userId} салгалаа`);
    }
  });
});

// GET /accidents - Бүх ослын жагсаалт (кэштэй)
app.get('/accidents', async (req, res) => {
  try {
    const { status, severity, limit = 100, offset = 0 } = req.query;

    // Redis-ээс кэш шалгах
    const cacheKey = `accidents:${status || 'all'}:${severity || 'all'}:${limit}:${offset}`;
    const cached = await redis.get(cacheKey);
    
    if (cached) {
      return res.json({
        source: 'cache',
        data: JSON.parse(cached)
      });
    }

    // Database-ээс татах
    let query = `
      SELECT a.*, u.name as reported_by_name, u.phone as reported_by_phone,
             COUNT(fr.id) as false_report_count,
             AVG(aid.confidence) as avg_confidence
      FROM accidents a
      LEFT JOIN users u ON a.user_id = u.id
      LEFT JOIN false_reports fr ON a.id = fr.accident_id
      LEFT JOIN ai_detections aid ON a.video_id = aid.video_id
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

    query += `
      GROUP BY a.id, u.name, u.phone
      ORDER BY a.timestamp DESC
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}
    `;
    
    params.push(limit, offset);

    const result = await pool.query(query, params);

    // Redis-д кэшлэх (5 минут)
    await redis.setex(cacheKey, 300, JSON.stringify(result.rows));

    res.json({
      source: 'database',
      data: result.rows,
      total: result.rowCount
    });

  } catch (error) {
    console.error('Accidents fetch error:', error);
    res.status(500).json({ error: 'Ослын мэдээлэл татахад алдаа гарлаа' });
  }
});

// GET /accidents/:id - Ослын дэлгэрэнгүй
app.get('/accidents/:id', async (req, res) => {
  try {
    const { id } = req.params;

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
      return res.status(404).json({ error: 'Осол олдсонгүй' });
    }

    res.json(result.rows[0]);

  } catch (error) {
    console.error('Accident detail error:', error);
    res.status(500).json({ error: 'Дэлгэрэнгүй татахад алдаа гарлаа' });
  }
});

// POST /accidents - Шинэ осол мэдээлэх (хэрэглэгчээс)
app.post('/accidents', async (req, res) => {
  const client = await pool.connect();
  
  try {
    const {
      userId,
      latitude,
      longitude,
      description,
      severity = 'minor',
      videoId,
      imageUrl
    } = req.body;

    // Validation
    if (!userId || !latitude || !longitude) {
      return res.status(400).json({ 
        error: 'userId, latitude, longitude заавал байх ёстой' 
      });
    }

    await client.query('BEGIN');

    // Accident үүсгэх
    const accidentResult = await client.query(`
      INSERT INTO accidents (
        user_id, latitude, longitude, description, 
        severity, status, source, video_id, image_url, timestamp
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
      RETURNING *
    `, [userId, latitude, longitude, description, severity, 'reported', 'user', videoId, imageUrl]);

    const accident = accidentResult.rows[0];

    // Location хадгалах
    await client.query(`
      INSERT INTO locations (accident_id, latitude, longitude, timestamp)
      VALUES ($1, $2, $3, NOW())
    `, [accident.id, latitude, longitude]);

    await client.query('COMMIT');

    // Redis кэш устгах
    const keys = await redis.keys('accidents:*');
    if (keys.length > 0) {
      await redis.del(...keys);
    }

    // Ойролцоох хэрэглэгчдэд мэдэгдэл илгээх (5км радиус)
    await notifyNearbyUsers(accident, 5000); // 5км

    res.status(201).json({
      message: 'Осол амжилттай бүртгэгдлээ',
      accident
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Create accident error:', error);
    res.status(500).json({ error: 'Осол бүртгэхэд алдаа гарлаа' });
  } finally {
    client.release();
  }
});

// PUT /accidents/:id/status - Ослын төлөв шинэчлэх
app.put('/accidents/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, userId } = req.body;

    const validStatuses = ['reported', 'confirmed', 'resolved', 'false_alarm'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Буруу төлөв' });
    }

    const result = await pool.query(`
      UPDATE accidents 
      SET status = $1, updated_at = NOW()
      WHERE id = $2
      RETURNING *
    `, [status, id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Осол олдсонгүй' });
    }

    // Redis кэш устгах
    const keys = await redis.keys('accidents:*');
    if (keys.length > 0) {
      await redis.del(...keys);
    }

    res.json({
      message: 'Төлөв шинэчлэгдлээ',
      accident: result.rows[0]
    });

  } catch (error) {
    console.error('Update status error:', error);
    res.status(500).json({ error: 'Төлөв шинэчлэхэд алдаа гарлаа' });
  }
});

// POST /accidents/:id/false-report - Буруу мэдээлэл засварлах
app.post('/accidents/:id/false-report', async (req, res) => {
  const client = await pool.connect();
  
  try {
    const { id } = req.params;
    const { userId, reasonId, comment } = req.body;

    await client.query('BEGIN');

    // False report бүртгэх
    await client.query(`
      INSERT INTO false_reports (accident_id, user_id, reason_id, comment, reported_at)
      VALUES ($1, $2, $3, $4, NOW())
    `, [id, userId, reasonId, comment]);

    // False report тоо шалгах
    const countResult = await client.query(`
      SELECT COUNT(*) as count FROM false_reports WHERE accident_id = $1
    `, [id]);

    const falseReportCount = parseInt(countResult.rows[0].count);

    // 3+ false report бол status өөрчлөх
    if (falseReportCount >= 3) {
      await client.query(`
        UPDATE accidents 
        SET status = 'false_alarm', updated_at = NOW()
        WHERE id = $1
      `, [id]);
    }

    await client.query('COMMIT');

    // Redis кэш устгах
    const keys = await redis.keys('accidents:*');
    if (keys.length > 0) {
      await redis.del(...keys);
    }

    res.json({
      message: 'Буруу мэдээлэл бүртгэгдлээ',
      falseReportCount
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('False report error:', error);
    res.status(500).json({ error: 'Мэдээлэл бүртгэхэд алдаа гарлаа' });
  } finally {
    client.release();
  }
});

// Ойролцоох хэрэглэгчдэд мэдэгдэл илгээх функц
async function notifyNearbyUsers(accident, radiusMeters) {
  try {
    // Redis-ээс бүх идэвхтэй хэрэглэгчдийн байршил авах
    const keys = await redis.keys('user:*:location');
    
    const nearbyUsers = [];
    
    for (const key of keys) {
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
    }

    // Socket.IO-оор мэдэгдэл илгээх
    for (const userId of nearbyUsers) {
      const socketId = userSockets.get(userId);
      if (socketId) {
        io.to(socketId).emit('new_accident', {
          accidentId: accident.id,
          latitude: accident.latitude,
          longitude: accident.longitude,
          severity: accident.severity,
          description: accident.description,
          timestamp: accident.timestamp
        });
      }
    }

    console.log(`Мэдэгдэл илгээгдсэн: ${nearbyUsers.length} хэрэглэгч`);

  } catch (error) {
    console.error('Notify error:', error);
  }
}

// Haversine формулаар зай тооцоолох (метрээр)
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371e3; // Дэлхийн радиус метрээр
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

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    service: 'accident-service',
    timestamp: new Date().toISOString()
  });
});

server.listen(PORT, () => {
  console.log(`🚗 Accident Service запущен на порту ${PORT}`);
  console.log(`🔌 Socket.IO готов для WebSocket соединений`);
});

module.exports = app;