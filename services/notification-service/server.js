// services/notification-service/server.js - FIXED VERSION
const express = require('express');
const { Pool } = require('pg');
const Redis = require('ioredis');
const admin = require('firebase-admin');
const { Server } = require('socket.io');
const http = require('http');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { 
    origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
    credentials: true 
  }
});

const PORT = process.env.PORT || 3005;

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

// ✅ FIXED: Firebase Admin SDK initialization
let firebaseInitialized = false;
try {
  const credentialsPath = process.env.FIREBASE_CREDENTIALS;
  
  if (credentialsPath && fs.existsSync(credentialsPath)) {
    const serviceAccount = require(credentialsPath);
    
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: process.env.FIREBASE_DATABASE_URL
    });
    
    firebaseInitialized = true;
    console.log('✅ Firebase Admin SDK initialized successfully');
  } else {
    console.warn('⚠️  Firebase credentials file not found - Push notifications disabled');
  }
} catch (error) {
  console.error('❌ Firebase initialization error:', error.message);
  console.warn('⚠️  Push notifications will not work');
}

// Socket.IO user mapping
const userSockets = new Map(); // userId -> socketId

io.on('connection', (socket) => {
  console.log('Client холбогдсон:', socket.id);

  socket.on('register', (userId) => {
    if (!userId) {
      console.error('Invalid userId in register event');
      return;
    }
    userSockets.set(userId.toString(), socket.id);
    socket.userId = userId;
    console.log(`User ${userId} бүртгэгдлээ (socket: ${socket.id})`);
  });

  socket.on('disconnect', () => {
    if (socket.userId) {
      userSockets.delete(socket.userId.toString());
      console.log(`User ${socket.userId} салгалаа`);
    }
  });

  socket.on('error', (error) => {
    console.error('Socket error:', error);
  });
});

// GET /notifications - Хэрэглэгчийн мэдэгдлүүд
app.get('/notifications', async (req, res) => {
  try {
    const { userId, page = 1, limit = 20, unreadOnly } = req.query;

    if (!userId) {
      return res.status(400).json({ 
        success: false,
        error: 'userId шаардлагатай' 
      });
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
      success: true,
      notifications: result.rows,
      unreadCount: parseInt(countResult.rows[0].count),
      page: parseInt(page),
      limit: parseInt(limit),
      total: result.rowCount
    });

  } catch (error) {
    console.error('Get notifications error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Мэдэгдэл авахад алдаа гарлаа' 
    });
  }
});

// PUT /notifications/:id/read - Мэдэгдэл уншсан гэж тэмдэглэх
app.put('/notifications/:id/read', async (req, res) => {
  try {
    const { id } = req.params;

    if (!/^\d+$/.test(id)) {
      return res.status(400).json({
        success: false,
        error: 'Буруу ID формат'
      });
    }

    const result = await pool.query(
      'UPDATE notifications SET is_read = true WHERE id = $1 RETURNING *',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ 
        success: false,
        error: 'Мэдэгдэл олдсонгүй' 
      });
    }

    res.json({
      success: true,
      message: 'Мэдэгдэл уншигдлаа',
      notification: result.rows[0]
    });

  } catch (error) {
    console.error('Mark as read error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Алдаа гарлаа' 
    });
  }
});

// PUT /notifications/read-all - Бүх мэдэгдэл уншсан гэж тэмдэглэх
app.put('/notifications/read-all', async (req, res) => {
  try {
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ 
        success: false,
        error: 'userId шаардлагатай' 
      });
    }

    await pool.query(
      'UPDATE notifications SET is_read = true WHERE user_id = $1 AND is_read = false',
      [userId]
    );

    res.json({ 
      success: true,
      message: 'Бүх мэдэгдэл уншигдлаа' 
    });

  } catch (error) {
    console.error('Mark all as read error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Алдаа гарлаа' 
    });
  }
});

// DELETE /notifications/:id - Мэдэгдэл устгах
app.delete('/notifications/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({
        success: false,
        error: 'userId шаардлагатай'
      });
    }

    const result = await pool.query(
      'DELETE FROM notifications WHERE id = $1 AND user_id = $2',
      [id, userId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ 
        success: false,
        error: 'Мэдэгдэл олдсонгүй' 
      });
    }

    res.json({ 
      success: true,
      message: 'Мэдэгдэл устгагдлаа' 
    });

  } catch (error) {
    console.error('Delete notification error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Алдаа гарлаа' 
    });
  }
});

// ✅ FIXED: POST /notifications/send - Improved error handling
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

    // Validation
    if (!userIds || !Array.isArray(userIds) || userIds.length === 0) {
      return res.status(400).json({ 
        success: false,
        error: 'userIds array шаардлагатай' 
      });
    }

    if (!title || !message) {
      return res.status(400).json({
        success: false,
        error: 'title болон message шаардлагатай'
      });
    }

    const notifications = [];
    const fcmTokens = [];
    const socketsSent = [];

    // Database-д мэдэгдэл хадгалах + Socket.IO илгээх
    for (const userId of userIds) {
      try {
        // Database insert
        const result = await pool.query(`
          INSERT INTO notifications (user_id, accident_id, type, title, message, sent_at)
          VALUES ($1, $2, $3, $4, $5, NOW())
          RETURNING *
        `, [userId, accidentId, type, title, message]);

        notifications.push(result.rows[0]);

        // Socket.IO-оор мэдэгдэл илгээх
        const socketId = userSockets.get(userId.toString());
        if (socketId) {
          io.to(socketId).emit('notification', {
            ...result.rows[0],
            data
          });
          socketsSent.push(userId);
        }

        // FCM token авах
        const tokenResult = await redis.get(`fcm_token:${userId}`);
        if (tokenResult) {
          fcmTokens.push({
            token: tokenResult,
            userId
          });
        }
      } catch (err) {
        console.error(`Failed to send notification to user ${userId}:`, err);
      }
    }

    // ✅ FIXED: Firebase Push Notification with better error handling
    let fcmSuccess = 0;
    let fcmFailure = 0;
    
    if (firebaseInitialized && fcmTokens.length > 0) {
      try {
        const tokens = fcmTokens.map(t => t.token);
        
        const fcmMessage = {
          notification: {
            title,
            body: message
          },
          data: {
            type: type || 'general',
            accidentId: accidentId?.toString() || '',
            ...Object.fromEntries(
              Object.entries(data).map(([k, v]) => [k, String(v)])
            )
          }
        };

        // Send to each token (multicast can handle up to 500 tokens)
        const chunks = [];
        for (let i = 0; i < tokens.length; i += 500) {
          chunks.push(tokens.slice(i, i + 500));
        }

        for (const chunk of chunks) {
          const response = await admin.messaging().sendMulticast({
            ...fcmMessage,
            tokens: chunk
          });
          
          fcmSuccess += response.successCount;
          fcmFailure += response.failureCount;

          // Remove invalid tokens
          if (response.failureCount > 0) {
            response.responses.forEach((resp, idx) => {
              if (!resp.success) {
                const error = resp.error;
                if (error.code === 'messaging/invalid-registration-token' ||
                    error.code === 'messaging/registration-token-not-registered') {
                  const userId = fcmTokens[idx]?.userId;
                  if (userId) {
                    redis.del(`fcm_token:${userId}`).catch(console.error);
                  }
                }
              }
            });
          }
        }

        console.log(`📱 FCM: ${fcmSuccess} success, ${fcmFailure} failed`);
      } catch (fcmError) {
        console.error('FCM error:', fcmError);
      }
    }

    res.json({
      success: true,
      message: 'Мэдэгдэл илгээгдлээ',
      stats: {
        total: userIds.length,
        databaseSaved: notifications.length,
        socketSent: socketsSent.length,
        fcmSuccess,
        fcmFailure
      },
      notifications
    });

  } catch (error) {
    console.error('Send notification error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Мэдэгдэл илгээхэд алдаа гарлаа',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// POST /notifications/register-token - FCM токен бүртгэх
app.post('/notifications/register-token', async (req, res) => {
  try {
    const { userId, fcmToken } = req.body;

    if (!userId || !fcmToken) {
      return res.status(400).json({ 
        success: false,
        error: 'userId болон fcmToken шаардлагатай' 
      });
    }

    // Validate FCM token format (optional)
    if (typeof fcmToken !== 'string' || fcmToken.length < 20) {
      return res.status(400).json({
        success: false,
        error: 'Буруу FCM токен формат'
      });
    }

    // Redis-д хадгалах (30 өдөр)
    await redis.setex(`fcm_token:${userId}`, 30 * 24 * 60 * 60, fcmToken);

    res.json({ 
      success: true,
      message: 'FCM токен бүртгэгдлээ' 
    });

  } catch (error) {
    console.error('Register token error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Алдаа гарлаа' 
    });
  }
});

// DELETE /notifications/unregister-token - FCM токен устгах
app.delete('/notifications/unregister-token', async (req, res) => {
  try {
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({
        success: false,
        error: 'userId шаардлагатай'
      });
    }

    await redis.del(`fcm_token:${userId}`);

    res.json({
      success: true,
      message: 'FCM токен устгагдлаа'
    });

  } catch (error) {
    console.error('Unregister token error:', error);
    res.status(500).json({
      success: false,
      error: 'Алдаа гарлаа'
    });
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
    console.error('Get settings error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Тохиргоо авахад алдаа гарлаа' 
    });
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
    `, [
      pushEnabled, 
      radius, 
      accidentTypes ? JSON.stringify(accidentTypes) : null, 
      userId
    ]);

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
    console.error('Update settings error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Алдаа гарлаа' 
    });
  }
});

// Health check
app.get('/health', async (req, res) => {
  const health = {
    status: 'healthy',
    service: 'notification-service',
    firebase: firebaseInitialized,
    activeConnections: userSockets.size,
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
  
  server.close(() => {
    console.log('HTTP server closed');
  });
  
  await pool.end();
  await redis.quit();
  
  process.exit(0);
});

server.listen(PORT, () => {
  console.log(`🔔 Notification Service запущен на порту ${PORT}`);
  console.log(`🔌 Socket.IO готов для WebSocket соединений`);
  console.log(`📱 Firebase: ${firebaseInitialized ? 'готов' : 'не настроен'}`);
  console.log(`👥 Active connections: ${userSockets.size}`);
});

module.exports = app;