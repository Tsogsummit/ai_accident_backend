// services/report-service/server.js - FIXED VERSION
const express = require('express');
const { Pool } = require('pg');
const Redis = require('ioredis');

const app = express();
const PORT = process.env.PORT || 3007;

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

// ============================================
// FALSE REPORTS (Буруу мэдээлэл)
// ============================================

// GET /false-reports - Бүх буруу мэдээллүүд
app.get('/false-reports', async (req, res) => {
  try {
    const { accidentId, userId, reasonId, limit = 50, offset = 0 } = req.query;

    let query = `
      SELECT fr.*, 
             u.name as reporter_name,
             rr.name as reason_name,
             rr.description as reason_description,
             a.description as accident_description,
             a.latitude,
             a.longitude
      FROM false_reports fr
      LEFT JOIN users u ON fr.user_id = u.id
      LEFT JOIN report_reasons rr ON fr.reason_id = rr.id
      LEFT JOIN accidents a ON fr.accident_id = a.id
      WHERE 1=1
    `;

    const params = [];
    let paramIndex = 1;

    if (accidentId) {
      query += ` AND fr.accident_id = $${paramIndex++}`;
      params.push(parseInt(accidentId));
    }

    if (userId) {
      query += ` AND fr.user_id = $${paramIndex++}`;
      params.push(parseInt(userId));
    }

    if (reasonId) {
      query += ` AND fr.reason_id = $${paramIndex++}`;
      params.push(parseInt(reasonId));
    }

    query += ` ORDER BY fr.reported_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await pool.query(query, params);

    res.json({
      success: true,
      data: result.rows,
      total: result.rowCount
    });

  } catch (error) {
    console.error('Get false reports error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Буруу мэдээлэл авахад алдаа гарлаа' 
    });
  }
});

// POST /false-reports - Шинэ буруу мэдээлэл бүртгэх
app.post('/false-reports', async (req, res) => {
  const client = await pool.connect();

  try {
    const { accidentId, userId, reasonId, comment } = req.body;

    if (!accidentId || !userId || !reasonId) {
      return res.status(400).json({
        success: false,
        error: 'accidentId, userId, reasonId заавал байх ёстой'
      });
    }

    await client.query('BEGIN');

    // ✅ CHECK: Has this user already reported this accident?
    const existingReport = await client.query(`
      SELECT id FROM false_reports
      WHERE accident_id = $1 AND user_id = $2
    `, [accidentId, userId]);

    if (existingReport.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        success: false,
        error: 'Та энэ ослыг аль хэдийн мэдээлсэн байна',
        alreadyReported: true
      });
    }

    // False report бүртгэх
    const reportResult = await client.query(`
      INSERT INTO false_reports (accident_id, user_id, reason_id, comment, reported_at)
      VALUES ($1, $2, $3, $4, NOW())
      RETURNING *
    `, [accidentId, userId, reasonId, comment]);

    const report = reportResult.rows[0];

    // Get false report count (for response only, don't change status)
    const countResult = await client.query(`
      SELECT COUNT(*) as count FROM false_reports WHERE accident_id = $1
    `, [accidentId]);

    const falseReportCount = parseInt(countResult.rows[0].count);

    await client.query('COMMIT');

    // Redis кэш устгах
    const keys = await redis.keys('accidents:*');
    if (keys.length > 0) {
      await redis.del(...keys);
    }

    // ✅ DON'T auto-change status - admin will decide
    // Just return the count and whether it needs admin review
    const needsAdminReview = falseReportCount >= 3;

    res.status(201).json({
      success: true,
      message: 'Мэдээлэл амжилттай илгээгдлээ',
      data: {
        report,
        falseReportCount,
        needsAdminReview,
        adminMessage: needsAdminReview
          ? 'Админ шалгах шаардлагатай (3+ хуурмаг мэдээлэл)'
          : null
      }
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Report false accident error:', error);

    // Handle UNIQUE constraint violation
    if (error.code === '23505' && error.constraint === 'unique_user_accident_report') {
      return res.status(409).json({
        success: false,
        error: 'Та энэ ослыг аль хэдийн мэдээлсэн байна',
        alreadyReported: true
      });
    }

    res.status(500).json({
      success: false,
      error: 'Мэдээлэл илгээхэд алдаа гарлаа'
    });
  } finally {
    client.release();
  }
});

// ===== OLD CODE REMOVED - Notification sending when status auto-changed =====
// The following block has been removed because admins now manually approve status changes:
/*
    if (statusChanged) {
      try {
        const accidentResult = await pool.query(
          'SELECT * FROM accidents WHERE id = $1',
          [accidentId]
        );

        if (accidentResult.rows.length > 0) {
          const accident = accidentResult.rows[0];

          const notifiedUsersResult = await pool.query(`
            SELECT DISTINCT user_id
            FROM notifications
            WHERE accident_id = $1 AND type = 'accident_confirmed'
          `, [accidentId]);

          const userIds = notifiedUsersResult.rows.map(row => row.user_id);

          if (userIds.length > 0) {
            const notificationServiceUrl = process.env.NOTIFICATION_SERVICE_URL || 'http://localhost:3005';
*/

// Get report reasons

    // ✅ Handle duplicate key violation (UNIQUE constraint)
    if (error.code === '23505' && error.constraint === 'unique_user_accident_report') {
      return res.status(409).json({
        success: false,
        error: 'Та энэ ослыг аль хэдийн мэдээлсэн байна',
        alreadyReported: true
      });
    }

    res.status(500).json({
      success: false,
      error: 'Бүртгэхэд алдаа гарлаа',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    client.release();
  }
});

// GET /false-reports/reasons - Буруу мэдээллийн шалтгаанууд
app.get('/false-reports/reasons', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT * FROM report_reasons ORDER BY id
    `);

    res.json({
      success: true,
      data: result.rows
    });

  } catch (error) {
    console.error('Get report reasons error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Шалтгаан авахад алдаа гарлаа' 
    });
  }
});

// ============================================
// STATISTICS & REPORTS (Статистик тайлан)
// ============================================

// ✅ FIXED: GET /reports/statistics - SQL injection prevention
app.get('/reports/statistics', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    // ✅ FIXED: Validate and sanitize dates
    let start, end;
    
    if (startDate) {
      start = new Date(startDate);
      if (isNaN(start.getTime())) {
        return res.status(400).json({
          success: false,
          error: 'Буруу startDate формат'
        });
      }
    } else {
      start = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    }
    
    if (endDate) {
      end = new Date(endDate);
      if (isNaN(end.getTime())) {
        return res.status(400).json({
          success: false,
          error: 'Буруу endDate формат'
        });
      }
    } else {
      end = new Date();
    }

    // Parallel queries for better performance
    const [
      totalAccidents,
      accidentsBySeverity,
      accidentsByStatus,
      accidentsBySource,
      topLocations,
      dailyStats,
      cameraStats
    ] = await Promise.all([
      // Нийт ослын тоо
      pool.query(`
        SELECT COUNT(*) as count
        FROM accidents
        WHERE accident_time >= $1 AND accident_time <= $2
      `, [start.toISOString(), end.toISOString()]),

      // Хүндийн зэргээр
      pool.query(`
        SELECT severity, COUNT(*) as count
        FROM accidents
        WHERE accident_time >= $1 AND accident_time <= $2
        GROUP BY severity
      `, [start.toISOString(), end.toISOString()]),

      // Статусаар
      pool.query(`
        SELECT status, COUNT(*) as count
        FROM accidents
        WHERE accident_time >= $1 AND accident_time <= $2
        GROUP BY status
      `, [start.toISOString(), end.toISOString()]),

      // Эх үүсвэрээр
      pool.query(`
        SELECT source, COUNT(*) as count
        FROM accidents
        WHERE accident_time >= $1 AND accident_time <= $2
        GROUP BY source
      `, [start.toISOString(), end.toISOString()]),

      // Топ байршил
      pool.query(`
        SELECT 
          ROUND(latitude::numeric, 3) as lat,
          ROUND(longitude::numeric, 3) as lng,
          COUNT(*) as count
        FROM accidents
        WHERE accident_time >= $1 AND accident_time <= $2
        GROUP BY ROUND(latitude::numeric, 3), ROUND(longitude::numeric, 3)
        ORDER BY count DESC
        LIMIT 10
      `, [start.toISOString(), end.toISOString()]),

      // Өдрөөр статистик
      pool.query(`
        SELECT 
          DATE(accident_time) as date,
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE severity = 'severe') as severe,
          COUNT(*) FILTER (WHERE severity = 'moderate') as moderate,
          COUNT(*) FILTER (WHERE severity = 'minor') as minor
        FROM accidents
        WHERE accident_time >= $1 AND accident_time <= $2
        GROUP BY DATE(accident_time)
        ORDER BY date DESC
      `, [start.toISOString(), end.toISOString()]),

      // Камерын статистик
      pool.query(`
        SELECT 
          c.id,
          c.name,
          COUNT(a.id) as accident_count,
          COUNT(a.id) FILTER (WHERE a.accident_time >= $1) as recent_accidents
        FROM cameras c
        LEFT JOIN accidents a ON c.id = a.camera_id
        GROUP BY c.id, c.name
        ORDER BY accident_count DESC
        LIMIT 10
      `, [start.toISOString()])
    ]);

    res.json({
      success: true,
      data: {
        period: { 
          start: start.toISOString(), 
          end: end.toISOString() 
        },
        summary: {
          totalAccidents: parseInt(totalAccidents.rows[0].count),
          bySeverity: accidentsBySeverity.rows.reduce((acc, row) => {
            acc[row.severity] = parseInt(row.count);
            return acc;
          }, {}),
          byStatus: accidentsByStatus.rows.reduce((acc, row) => {
            acc[row.status] = parseInt(row.count);
            return acc;
          }, {}),
          bySource: accidentsBySource.rows.reduce((acc, row) => {
            acc[row.source] = parseInt(row.count);
            return acc;
          }, {})
        },
        topLocations: topLocations.rows,
        dailyStats: dailyStats.rows,
        cameraStats: cameraStats.rows
      }
    });

  } catch (error) {
    console.error('Get statistics error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Статистик авахад алдаа гарлаа',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// GET /reports/user-activity - Хэрэглэгчийн идэвх
app.get('/reports/user-activity', async (req, res) => {
  try {
    const { userId, limit = 50, offset = 0 } = req.query;

    let query = `
      SELECT 
        u.id,
        u.name,
        u.phone,
        COUNT(DISTINCT a.id) as total_reports,
        COUNT(DISTINCT CASE WHEN a.status = 'confirmed' THEN a.id END) as confirmed_reports,
        COUNT(DISTINCT CASE WHEN a.status = 'false_alarm' THEN a.id END) as false_alarms,
        COUNT(DISTINCT fr.id) as false_reports_made,
        MAX(a.accident_time) as last_report_time
      FROM users u
      LEFT JOIN accidents a ON u.id = a.user_id
      LEFT JOIN false_reports fr ON u.id = fr.user_id
    `;

    const params = [];
    let paramIndex = 1;

    if (userId) {
      query += ` WHERE u.id = $${paramIndex++}`;
      params.push(parseInt(userId));
    }

    query += `
      GROUP BY u.id, u.name, u.phone
      ORDER BY total_reports DESC
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}
    `;

    params.push(parseInt(limit), parseInt(offset));

    const result = await pool.query(query, params);

    res.json({
      success: true,
      data: result.rows
    });

  } catch (error) {
    console.error('Get user activity error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Идэвх авахад алдаа гарлаа' 
    });
  }
});

// GET /reports/camera-performance - Камерын гүйцэтгэл
app.get('/reports/camera-performance', async (req, res) => {
  try {
    const { cameraId } = req.query;

    let query = `
      SELECT 
        c.id,
        c.name,
        c.location,
        c.status,
        c.is_online,
        COUNT(DISTINCT a.id) as total_accidents,
        COUNT(DISTINCT CASE WHEN a.accident_time >= NOW() - INTERVAL '24 hours' THEN a.id END) as accidents_24h,
        COUNT(DISTINCT CASE WHEN a.accident_time >= NOW() - INTERVAL '7 days' THEN a.id END) as accidents_7d,
        COUNT(DISTINCT v.id) as total_videos,
        AVG(aid.confidence) as avg_confidence,
        MAX(a.accident_time) as last_accident_time,
        MAX(cl.timestamp) as last_log_time
      FROM cameras c
      LEFT JOIN accidents a ON c.id = a.camera_id
      LEFT JOIN videos v ON c.id = v.camera_id
      LEFT JOIN ai_detections aid ON v.id = aid.video_id
      LEFT JOIN camera_logs cl ON c.id = cl.camera_id
    `;

    const params = [];
    let paramIndex = 1;

    if (cameraId) {
      query += ` WHERE c.id = $${paramIndex++}`;
      params.push(parseInt(cameraId));
    }

    query += `
      GROUP BY c.id, c.name, c.location, c.status, c.is_online
      ORDER BY total_accidents DESC
    `;

    const result = await pool.query(query, params);

    res.json({
      success: true,
      data: result.rows
    });

  } catch (error) {
    console.error('Get camera performance error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Гүйцэтгэл авахад алдаа гарлаа' 
    });
  }
});

// ✅ FIXED: GET /reports/ai-accuracy - Parameterized queries
app.get('/reports/ai-accuracy', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    // ✅ FIXED: Validate dates
    let start, end;
    
    if (startDate) {
      start = new Date(startDate);
      if (isNaN(start.getTime())) {
        return res.status(400).json({
          success: false,
          error: 'Буруу startDate формат'
        });
      }
    } else {
      start = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    }
    
    if (endDate) {
      end = new Date(endDate);
      if (isNaN(end.getTime())) {
        return res.status(400).json({
          success: false,
          error: 'Буруу endDate формат'
        });
      }
    } else {
      end = new Date();
    }

    const result = await pool.query(`
      SELECT 
        COUNT(DISTINCT v.id) as total_videos_processed,
        COUNT(DISTINCT CASE WHEN aid.confidence >= 0.85 THEN v.id END) as high_confidence,
        COUNT(DISTINCT CASE WHEN aid.confidence >= 0.5 AND aid.confidence < 0.85 THEN v.id END) as medium_confidence,
        COUNT(DISTINCT CASE WHEN aid.confidence < 0.5 THEN v.id END) as low_confidence,
        AVG(aid.confidence) as avg_confidence,
        MIN(aid.confidence) as min_confidence,
        MAX(aid.confidence) as max_confidence,
        COUNT(DISTINCT a.id) as accidents_created,
        COUNT(DISTINCT CASE WHEN a.status = 'confirmed' THEN a.id END) as confirmed_accidents,
        COUNT(DISTINCT CASE WHEN a.status = 'false_alarm' THEN a.id END) as false_alarms
      FROM videos v
      LEFT JOIN ai_detections aid ON v.id = aid.video_id
      LEFT JOIN accidents a ON v.id = a.video_id
      WHERE v.uploaded_at >= $1 AND v.uploaded_at <= $2
        AND v.status = 'completed'
    `, [start.toISOString(), end.toISOString()]);

    const stats = result.rows[0];

    // Accuracy calculation
    const totalProcessed = parseInt(stats.total_videos_processed) || 1;
    const confirmed = parseInt(stats.confirmed_accidents) || 0;
    const falseAlarms = parseInt(stats.false_alarms) || 0;
    
    const accuracy = totalProcessed > 0 && (confirmed + falseAlarms) > 0
      ? ((confirmed / (confirmed + falseAlarms)) * 100).toFixed(2)
      : 0;

    res.json({
      success: true,
      data: {
        period: { 
          start: start.toISOString(), 
          end: end.toISOString() 
        },
        processing: {
          totalVideos: parseInt(stats.total_videos_processed),
          highConfidence: parseInt(stats.high_confidence),
          mediumConfidence: parseInt(stats.medium_confidence),
          lowConfidence: parseInt(stats.low_confidence)
        },
        confidence: {
          average: parseFloat(stats.avg_confidence)?.toFixed(4) || 0,
          min: parseFloat(stats.min_confidence)?.toFixed(4) || 0,
          max: parseFloat(stats.max_confidence)?.toFixed(4) || 0
        },
        detection: {
          accidentsCreated: parseInt(stats.accidents_created),
          confirmed: confirmed,
          falseAlarms: falseAlarms,
          accuracy: `${accuracy}%`
        }
      }
    });

  } catch (error) {
    console.error('Get AI accuracy error:', error);
    res.status(500).json({ 
      success: false,
      error: 'AI нарийвчлал авахад алдаа гарлаа' 
    });
  }
});

// GET /reports/export - Тайлан татаж авах (CSV)
app.get('/reports/export', async (req, res) => {
  try {
    const { type = 'accidents', startDate, endDate } = req.query;

    // ✅ FIXED: Validate dates
    let start, end;
    
    if (startDate) {
      start = new Date(startDate);
      if (isNaN(start.getTime())) {
        return res.status(400).json({
          success: false,
          error: 'Буруу startDate формат'
        });
      }
    } else {
      start = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    }
    
    if (endDate) {
      end = new Date(endDate);
      if (isNaN(end.getTime())) {
        return res.status(400).json({
          success: false,
          error: 'Буруу endDate формат'
        });
      }
    } else {
      end = new Date();
    }

    let query;
    let filename;

    switch (type) {
      case 'accidents':
        query = `
          SELECT 
            a.id,
            a.latitude,
            a.longitude,
            a.description,
            a.severity,
            a.status,
            a.source,
            a.accident_time,
            u.name as reported_by,
            c.name as camera_name
          FROM accidents a
          LEFT JOIN users u ON a.user_id = u.id
          LEFT JOIN cameras c ON a.camera_id = c.id
          WHERE a.accident_time >= $1 AND a.accident_time <= $2
          ORDER BY a.accident_time DESC
        `;
        filename = 'accidents_report.csv';
        break;

      case 'false_reports':
        query = `
          SELECT 
            fr.id,
            fr.accident_id,
            u.name as reporter,
            rr.name as reason,
            fr.comment,
            fr.reported_at
          FROM false_reports fr
          LEFT JOIN users u ON fr.user_id = u.id
          LEFT JOIN report_reasons rr ON fr.reason_id = rr.id
          WHERE fr.reported_at >= $1 AND fr.reported_at <= $2
          ORDER BY fr.reported_at DESC
        `;
        filename = 'false_reports.csv';
        break;

      case 'user_activity':
        query = `
          SELECT 
            u.id,
            u.name,
            u.phone,
            COUNT(a.id) as total_reports
          FROM users u
          LEFT JOIN accidents a ON u.id = a.user_id
          WHERE a.accident_time >= $1 AND a.accident_time <= $2
          GROUP BY u.id, u.name, u.phone
          ORDER BY total_reports DESC
        `;
        filename = 'user_activity.csv';
        break;

      default:
        return res.status(400).json({ 
          success: false,
          error: 'Буруу тайлангийн төрөл' 
        });
    }

    const result = await pool.query(query, [start.toISOString(), end.toISOString()]);

    // Convert to CSV
    const rows = result.rows;
    if (rows.length === 0) {
      return res.status(404).json({ 
        success: false,
        error: 'Өгөгдөл олдсонгүй' 
      });
    }

    const headers = Object.keys(rows[0]).join(',');
    const csvData = [
      headers,
      ...rows.map(row => Object.values(row).map(val => {
        // Escape commas and quotes
        if (val === null || val === undefined) return '';
        const str = String(val);
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
          return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
      }).join(','))
    ].join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send('\uFEFF' + csvData); // UTF-8 BOM for Excel

  } catch (error) {
    console.error('Export report error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Тайлан татахад алдаа гарлаа' 
    });
  }
});

// Health check
app.get('/health', async (req, res) => {
  const health = {
    status: 'healthy',
    service: 'report-service',
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
  console.log(`📊 Report Service запущен на порту ${PORT}`);
});

module.exports = app;