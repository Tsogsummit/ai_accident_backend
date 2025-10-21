// services/report-service/server.js
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
  password: process.env.DB_PASSWORD || 'postgres'
});

// Redis
const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: process.env.REDIS_PORT || 6379
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
      params.push(accidentId);
    }

    if (userId) {
      query += ` AND fr.user_id = $${paramIndex++}`;
      params.push(userId);
    }

    if (reasonId) {
      query += ` AND fr.reason_id = $${paramIndex++}`;
      params.push(reasonId);
    }

    query += ` ORDER BY fr.reported_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
    params.push(limit, offset);

    const result = await pool.query(query, params);

    res.json({
      success: true,
      data: result.rows,
      total: result.rowCount
    });

  } catch (error) {
    console.error('Get false reports error:', error);
    res.status(500).json({ error: 'Буруу мэдээлэл авахад алдаа гарлаа' });
  }
});

// POST /false-reports - Шинэ буруу мэдээлэл бүртгэх
app.post('/false-reports', async (req, res) => {
  const client = await pool.connect();

  try {
    const { accidentId, userId, reasonId, comment } = req.body;

    if (!accidentId || !userId || !reasonId) {
      return res.status(400).json({
        error: 'accidentId, userId, reasonId заавал байх ёстой'
      });
    }

    await client.query('BEGIN');

    // False report бүртгэх
    const reportResult = await client.query(`
      INSERT INTO false_reports (accident_id, user_id, reason_id, comment, reported_at)
      VALUES ($1, $2, $3, $4, NOW())
      RETURNING *
    `, [accidentId, userId, reasonId, comment]);

    const report = reportResult.rows[0];

    // False report-ын тоо шалгах
    const countResult = await client.query(`
      SELECT COUNT(*) as count FROM false_reports WHERE accident_id = $1
    `, [accidentId]);

    const falseReportCount = parseInt(countResult.rows[0].count);

    // 3+ false report бол accident-ын статус false_alarm болгох
    if (falseReportCount >= 3) {
      await client.query(`
        UPDATE accidents 
        SET status = 'false_alarm', updated_at = NOW()
        WHERE id = $1
      `, [accidentId]);
    }

    await client.query('COMMIT');

    // Redis кэш устгах
    const keys = await redis.keys('cache:/accidents*');
    if (keys.length > 0) {
      await redis.del(...keys);
    }

    res.status(201).json({
      success: true,
      message: 'Буруу мэдээлэл бүртгэгдлээ',
      data: report,
      falseReportCount
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Create false report error:', error);
    res.status(500).json({ error: 'Бүртгэхэд алдаа гарлаа' });
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
    res.status(500).json({ error: 'Шалтгаан авахад алдаа гарлаа' });
  }
});

// ============================================
// STATISTICS & REPORTS (Статистик тайлан)
// ============================================

// GET /reports/statistics - Ерөнхий статистик
app.get('/reports/statistics', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    // Dates default values
    const start = startDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const end = endDate || new Date().toISOString();

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
        WHERE timestamp >= $1 AND timestamp <= $2
      `, [start, end]),

      // Хүндийн зэргээр
      pool.query(`
        SELECT severity, COUNT(*) as count
        FROM accidents
        WHERE timestamp >= $1 AND timestamp <= $2
        GROUP BY severity
      `, [start, end]),

      // Статусаар
      pool.query(`
        SELECT status, COUNT(*) as count
        FROM accidents
        WHERE timestamp >= $1 AND timestamp <= $2
        GROUP BY status
      `, [start, end]),

      // Эх үүсвэрээр
      pool.query(`
        SELECT source, COUNT(*) as count
        FROM accidents
        WHERE timestamp >= $1 AND timestamp <= $2
        GROUP BY source
      `, [start, end]),

      // Топ байршил
      pool.query(`
        SELECT 
          ROUND(latitude::numeric, 3) as lat,
          ROUND(longitude::numeric, 3) as lng,
          COUNT(*) as count
        FROM accidents
        WHERE timestamp >= $1 AND timestamp <= $2
        GROUP BY ROUND(latitude::numeric, 3), ROUND(longitude::numeric, 3)
        ORDER BY count DESC
        LIMIT 10
      `, [start, end]),

      // Өдрөөр статистик
      pool.query(`
        SELECT 
          DATE(timestamp) as date,
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE severity = 'severe') as severe,
          COUNT(*) FILTER (WHERE severity = 'moderate') as moderate,
          COUNT(*) FILTER (WHERE severity = 'minor') as minor
        FROM accidents
        WHERE timestamp >= $1 AND timestamp <= $2
        GROUP BY DATE(timestamp)
        ORDER BY date DESC
      `, [start, end]),

      // Камерын статистик
      pool.query(`
        SELECT 
          c.id,
          c.name,
          COUNT(a.id) as accident_count,
          COUNT(a.id) FILTER (WHERE a.timestamp >= $1) as recent_accidents
        FROM cameras c
        LEFT JOIN accidents a ON c.id = a.camera_id
        GROUP BY c.id, c.name
        ORDER BY accident_count DESC
        LIMIT 10
      `, [start])
    ]);

    res.json({
      success: true,
      data: {
        period: { start, end },
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
    res.status(500).json({ error: 'Статистик авахад алдаа гарлаа' });
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
        MAX(a.timestamp) as last_report_time
      FROM users u
      LEFT JOIN accidents a ON u.id = a.user_id
      LEFT JOIN false_reports fr ON u.id = fr.user_id
    `;

    const params = [];
    let paramIndex = 1;

    if (userId) {
      query += ` WHERE u.id = $${paramIndex++}`;
      params.push(userId);
    }

    query += `
      GROUP BY u.id, u.name, u.phone
      ORDER BY total_reports DESC
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}
    `;

    params.push(limit, offset);

    const result = await pool.query(query, params);

    res.json({
      success: true,
      data: result.rows
    });

  } catch (error) {
    console.error('Get user activity error:', error);
    res.status(500).json({ error: 'Идэвх авахад алдаа гарлаа' });
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
        COUNT(DISTINCT CASE WHEN a.timestamp >= NOW() - INTERVAL '24 hours' THEN a.id END) as accidents_24h,
        COUNT(DISTINCT CASE WHEN a.timestamp >= NOW() - INTERVAL '7 days' THEN a.id END) as accidents_7d,
        COUNT(DISTINCT v.id) as total_videos,
        AVG(aid.confidence) as avg_confidence,
        MAX(a.timestamp) as last_accident_time,
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
      params.push(cameraId);
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
    res.status(500).json({ error: 'Гүйцэтгэл авахад алдаа гарлаа' });
  }
});

// GET /reports/ai-accuracy - AI нарийвчлалын тайлан
app.get('/reports/ai-accuracy', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    const start = startDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const end = endDate || new Date().toISOString();

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
    `, [start, end]);

    const stats = result.rows[0];

    // Accuracy calculation
    const totalProcessed = parseInt(stats.total_videos_processed) || 1;
    const confirmed = parseInt(stats.confirmed_accidents) || 0;
    const falseAlarms = parseInt(stats.false_alarms) || 0;
    
    const accuracy = totalProcessed > 0 
      ? ((confirmed / (confirmed + falseAlarms)) * 100).toFixed(2)
      : 0;

    res.json({
      success: true,
      data: {
        period: { start, end },
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
    res.status(500).json({ error: 'AI нарийвчлал авахад алдаа гарлаа' });
  }
});

// GET /reports/export - Тайлан татаж авах (CSV)
app.get('/reports/export', async (req, res) => {
  try {
    const { type = 'accidents', startDate, endDate } = req.query;

    const start = startDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const end = endDate || new Date().toISOString();

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
            a.timestamp,
            u.name as reported_by,
            c.name as camera_name
          FROM accidents a
          LEFT JOIN users u ON a.user_id = u.id
          LEFT JOIN cameras c ON a.camera_id = c.id
          WHERE a.timestamp >= $1 AND a.timestamp <= $2
          ORDER BY a.timestamp DESC
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
          WHERE a.timestamp >= $1 AND a.timestamp <= $2
          GROUP BY u.id, u.name, u.phone
          ORDER BY total_reports DESC
        `;
        filename = 'user_activity.csv';
        break;

      default:
        return res.status(400).json({ error: 'Буруу тайлангийн төрөл' });
    }

    const result = await pool.query(query, [start, end]);

    // Convert to CSV
    const rows = result.rows;
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Өгөгдөл олдсонгүй' });
    }

    const headers = Object.keys(rows[0]).join(',');
    const csvData = [
      headers,
      ...rows.map(row => Object.values(row).map(val => 
        typeof val === 'string' && val.includes(',') ? `"${val}"` : val
      ).join(','))
    ].join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csvData);

  } catch (error) {
    console.error('Export report error:', error);
    res.status(500).json({ error: 'Тайлан татахад алдаа гарлаа' });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'report-service',
    timestamp: new Date().toISOString()
  });
});

app.listen(PORT, () => {
  console.log(`📊 Report Service запущен на порту ${PORT}`);
});

module.exports = app;