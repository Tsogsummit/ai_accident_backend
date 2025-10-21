// services/notification-service/server.js
const express = require('express');
const { Pool } = require('pg');
const Redis = require('ioredis');
const admin = require('firebase-admin');
const { Server } = require('socket.io');
const http = require('http');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const PORT = process.env.PORT || 3005;

app.use(express.json());

// PostgreSQL
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'accident_db',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres'
});

// Redis
const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: process.env.REDIS_PORT || 6379
});

// Firebase Admin SDK
let firebaseInitialized = false;
try {
  if (process.env.FCM_SERVER_KEY) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n')
      })
    });
    firebaseInitialized = true;
    console.log('✅ Firebase initialized');
  } else {
    console.warn('⚠️  Firebase credentials байхгүй - Push notification ажиллахгүй');
  }
} catch (error) {
  console.error('Firebase initialization error:', error.message);
}

// Socket.IO user mapping
const userSockets = new Map(); // userId -> socketId

io.on('connection', (socket) => {
  console.log('Client холбогдсон:', socket.id);

  socket.on('register', (userId) => {
    userSockets.set(userId, socket.id);
    socket.userId = userId;
    console.log(`User ${userId} бүртгэгдлээ`);
  });

  socket.on('disconnect', () => {
    if (socket.userId) {
      userSockets.delete(socket.userId);
      console.log(`User ${socket.userId} салгалаа`);
    }
  });
});

// GET /notifications - Хэрэглэгчийн мэдэгдлүүд
app.get('/notifications', async (req, res) => {
  try {
    const { userId, page = 1, limit = 20, unreadOnly } = req.query;

    if (!userId) {
      return res.status(400).json({ error: 'userId шаардлагатай' });
    }

    const offset = (page - 1) * limit;

    let query = `
      SELECT n.*, a.latitude, a.longitude, a.severity, a.description
      FROM notifications n
      LEFT JOIN accidents a ON n.accident_id = a.id
      WHERE n.user_id = $1
    `;

    const params = [userId];

    if (unreadOnly === 'true') {
      query += ' AND n.is_read = false';
    }

    query += ' ORDER BY n.sent_at DESC LIMIT $2 OFFSET $3';
    params.push(limit, offset);

    const result = await pool.query(query, params);

    // Unread count
    const countResult = await pool.query(
      'SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND is_read = false',
      [userId]
    );

    res.json({
      notifications: result.rows,
      unreadCount: parseInt(countResult.rows[0].count),
      page: parseInt(page),
      limit: parseInt(limit),
      total: result.rowCount
    });

  } catch (error) {
    console.error('Get notifications error:', error);
    res.status(500).json({ error: 'Мэдэгдэл авахад алдаа гарлаа' });
  }
});

// PUT /notifications/:id/read - Мэдэгдэл уншсан гэж тэмдэглэх
app.put('/notifications/:id/read', async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      'UPDATE notifications SET is_read = true WHERE id = $1 RETURNING *',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Мэдэгдэл олдсонгүй' });
    }

    res.json({
      message: 'Мэдэгдэл уншигдлаа',
      notification: result.rows[0]
    });

  } catch (error) {
    console.error('Mark as read error:', error);
    res.status(500).json({ error: 'Алдаа гарлаа' });
  }
});

// PUT /notifications/read-all - Бүх мэдэгдэл уншсан гэж тэмдэглэх
app.put('/notifications/read-all', async (req, res) => {
  try {
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ error: 'userId шаардлагатай' });
    }

    await pool.query(
      'UPDATE notifications SET is_read = true WHERE user_id = $1 AND is_read = false',
      [userId]
    );

    res.json({ message: 'Бүх мэдэгдэл уншигдлаа' });

  } catch (error) {
    console.error('Mark all as read error:', error);
    res.status(500).json({ error: 'Алдаа гарлаа' });
  }
});

// DELETE /notifications/:id - Мэдэгдэл устгах
app.delete('/notifications/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = req.body;

    const result = await pool.query(
      'DELETE FROM notifications WHERE id = $1 AND user_id = $2',
      [id, userId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Мэдэгдэл олдсонгүй' });
    }

    res.json({ message: 'Мэдэгдэл устгагдлаа' });

  } catch (error) {
    console.error('Delete notification error:', error);
    res.status(500).json({ error: 'Алдаа гарлаа' });
  }
});

// POST /notifications/send - Мэдэгдэл илгээх (Internal API)
app.post('/notifications/send', async (req, res) => {
  try {
    const {
      userIds,  // Array of user IDs
      accidentId,
      type,
      title,
      message,
      data = {}
    } = req.body;

    if (!userIds || !Array.isArray(userIds) || userIds.length === 0) {
      return res.status(400).json({ error: 'userIds array шаардлагатай' });
    }

    const notifications = [];
    const fcmTokens = [];

    // Database-д мэдэгдэл хадгалах
    for (const userId of userIds) {
      const result = await pool.query(`
        INSERT INTO notifications (user_id, accident_id, type, title, message, sent_at)
        VALUES ($1, $2, $3, $4, $5, NOW())
        RETURNING *
      `, [userId, accidentId, type, title, message]);

      notifications.push(result.rows[0]);

      // Socket.IO-оор мэдэгдэл илгээх
      const socketId = userSockets.get(userId);
      if (socketId) {
        io.to(socketId).emit('notification', {
          ...result.rows[0],
          data
        });
      }

      // FCM token авах
      const tokenResult = await redis.get(`fcm_token:${userId}`);
      if (tokenResult) {
        fcmTokens.push(tokenResult);
      }
    }

    // Firebase Push Notification
    if (firebaseInitialized && fcmTokens.length > 0) {
      try {
        const fcmMessage = {
          notification: {
            title,
            body: message
          },
          data: {
            type,
            accidentId: accidentId?.toString() || '',
            ...data
          },
          tokens: fcmTokens
        };

        const response = await admin.messaging().sendMulticast(fcmMessage);
        console.log(`📱 Push notification илгээгдлээ: ${response.successCount}/${fcmTokens.length}`);
      } catch (fcmError) {
        console.error('FCM error:', fcmError);
      }
    }

    res.json({
      message: 'Мэдэгдэл илгээгдлээ',
      count: notifications.length,
      notifications
    });

  } catch (error) {
    console.error('Send notification error:', error);
    res.status(500).json({ error: 'Мэдэгдэл илгээхэд алдаа гарлаа' });
  }
});

// POST /notifications/register-token - FCM токен бүртгэх
app.post('/notifications/register-token', async (req, res) => {
  try {
    const { userId, fcmToken } = req.body;

    if (!userId || !fcmToken) {
      return res.status(400).json({ error: 'userId болон fcmToken шаардлагатай' });
    }

    // Redis-д хадгалах (30 өдөр)
    await redis.setex(`fcm_token:${userId}`, 30 * 24 * 60 * 60, fcmToken);

    res.json({ message: 'FCM токен бүртгэгдлээ' });

  } catch (error) {
    console.error('Register token error:', error);
    res.status(500).json({ error: 'Алдаа гарлаа' });
  }
});

// GET /notifications/settings/:userId - Мэдэгдлийн тохиргоо
app.get('/notifications/settings/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    const result = await pool.query(
      'SELECT * FROM notification_settings WHERE user_id = $1',
      [userId]
    );

    if (result.rows.length === 0) {
      // Default settings үүсгэх
      const newSettings = await pool.query(`
        INSERT INTO notification_settings (user_id, push_enabled, radius, accident_types)
        VALUES ($1, true, 5000, '[]')
        RETURNING *
      `, [userId]);

      return res.json(newSettings.rows[0]);
    }

    res.json(result.rows[0]);

  } catch (error) {
    console.error('Get settings error:', error);
    res.status(500).json({ error: 'Тохиргоо авахад алдаа гарлаа' });
  }
});

// PUT /notifications/settings/:userId - Тохиргоо шинэчлэх
app.put('/notifications/settings/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { pushEnabled, radius, accidentTypes } = req.body;

    const result = await pool.query(`
      UPDATE notification_settings
      SET push_enabled = COALESCE($1, push_enabled),
          radius = COALESCE($2, radius),
          accident_types = COALESCE($3, accident_types),
          updated_at = NOW()
      WHERE user_id = $4
      RETURNING *
    `, [pushEnabled, radius, JSON.stringify(accidentTypes), userId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Тохиргоо олдсонгүй' });
    }

    res.json({
      message: 'Тохиргоо шинэчлэгдлээ',
      settings: result.rows[0]
    });

  } catch (error) {
    console.error('Update settings error:', error);
    res.status(500).json({ error: 'Алдаа гарлаа' });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'notification-service',
    firebase: firebaseInitialized,
    activeConnections: userSockets.size,
    timestamp: new Date().toISOString()
  });
});

server.listen(PORT, () => {
  console.log(`🔔 Notification Service запущен на порту ${PORT}`);
  console.log(`🔌 Socket.IO готов для WebSocket соединений`);
  console.log(`📱 Firebase: ${firebaseInitialized ? 'готов' : 'не настроен'}`);
});

module.exports = app;