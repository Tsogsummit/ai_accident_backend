const express = require('express');
const { Pool } = require('pg');
const Redis = require('ioredis');
const multer = require('multer');
const FormData = require('form-data');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const rootEnvPath = path.resolve(__dirname, '../../.env');
if (fs.existsSync(rootEnvPath)) {
  dotenv.config({ path: rootEnvPath });
  console.log(` Loaded .env from ${rootEnvPath}`);
} else {
  dotenv.config();
  console.log(' Loaded .env from current directory (or defaults)');
}

const app = express();
const PORT = process.env.PORT || 3007;
app.use(express.json());

const upload = multer({ dest: 'uploads/' });
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
    const reportResult = await client.query(`
      INSERT INTO false_reports (accident_id, user_id, reason_id, comment, reported_at)
      VALUES ($1, $2, $3, $4, NOW())
      RETURNING *
    `, [accidentId, userId, reasonId, comment]);
    const report = reportResult.rows[0];
    const countResult = await client.query(`
      SELECT COUNT(*) as count FROM false_reports WHERE accident_id = $1
    `, [accidentId]);
    const falseReportCount = parseInt(countResult.rows[0].count);
    await client.query('COMMIT');
    const keys = await redis.keys('accidents:*');
    if (keys.length > 0) {
      await redis.del(...keys);
    }
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

app.get('/reports/statistics', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
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
    const [
      totalAccidents,
      accidentsByStatus,
      accidentsBySource,
      topLocations,
      dailyStats,
      cameraStats
    ] = await Promise.all([
      pool.query(`
        SELECT COUNT(*) as count
        FROM accidents
        WHERE accident_time >= $1 AND accident_time <= $2
      `, [start.toISOString(), end.toISOString()]),
      pool.query(`
        SELECT status, COUNT(*) as count
        FROM accidents
        WHERE accident_time >= $1 AND accident_time <= $2
        GROUP BY status
      `, [start.toISOString(), end.toISOString()]),
      pool.query(`
        SELECT source, COUNT(*) as count
        FROM accidents
        WHERE accident_time >= $1 AND accident_time <= $2
        GROUP BY source
      `, [start.toISOString(), end.toISOString()]),
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
      pool.query(`
        SELECT
          DATE(accident_time) as date,
          COUNT(*) as total
        FROM accidents
        WHERE accident_time >= $1 AND accident_time <= $2
        GROUP BY DATE(accident_time)
        ORDER BY date DESC
      `, [start.toISOString(), end.toISOString()]),
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

app.get('/reports/ai-accuracy', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
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

app.get('/reports/export', async (req, res) => {
  try {
    const { type = 'accidents', startDate, endDate } = req.query;
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
    const rows = result.rows;
    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Өгөгдөл олдсонгүй'
      });
    }
    const headers = Object.keys(rows[0]).join(',');
    const csv = [headers, ...rows.map(row => Object.values(row).map(val =>
      typeof val === 'string' ? `"${val.replace(/"/g, '""')}"` : val
    ).join(','))].join('\n');

    res.header('Content-Type', 'text/csv');
    res.attachment(filename);
    return res.send(csv);

  } catch (error) {
    console.error('Export error:', error);
    res.status(500).json({
      success: false,
      error: 'Тайлан татахад алдаа гарлаа'
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
  const jwt = require('jsonwebtoken');
  const JWT_SECRET = process.env.JWT_SECRET;
  console.log(' Report Service JWT Secret:', JWT_SECRET.substring(0, 5) + '...');

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      console.error('Token verification failed:', err.message);
      return res.status(403).json({
        success: false,
        error: 'Хүчингүй токен'
      });
    }
    req.user = user;
    next();
  });
};

app.get('/reports/submissions',
  authenticateToken,
  async (req, res) => {
    try {
      const userId = req.user?.userId;
      const { limit = 50, offset = 0 } = req.query;

      const result = await pool.query(`
        SELECT
          s.*,
          a.status as accident_status,
          a.description as accident_description
        FROM image_submissions s
        LEFT JOIN accidents a ON s.accident_id = a.id
        WHERE s.user_id = $1
        ORDER BY s.created_at DESC
        LIMIT $2 OFFSET $3
      `, [userId, parseInt(limit), parseInt(offset)]);

      const countResult = await pool.query(
        'SELECT COUNT(*) FROM image_submissions WHERE user_id = $1',
        [userId]
      );

      res.json({
        success: true,
        data: result.rows,
        total: parseInt(countResult.rows[0].count),
        limit: parseInt(limit),
        offset: parseInt(offset)
      });
    } catch (error) {
      console.error('Get submissions error:', error);
      res.status(500).json({
        success: false,
        error: 'Түүх татахад алдаа гарлаа'
      });
    }
  });

app.post('/reports/image',
  authenticateToken,
  upload.single('image'),
  async (req, res) => {
    let submissionId = null;

    try {
      const { latitude, longitude, description } = req.body;
      const authHeader = req.headers['authorization'];
      const userId = req.user?.userId;

      if (!req.file) {
        return res.status(400).json({ success: false, error: 'Image file is required' });
      }

      if (!latitude || !longitude) {
        fs.unlinkSync(req.file.path);
        return res.status(400).json({ success: false, error: 'latitude, longitude заавал байх ёстой' });
      }

      console.log(` Processing image report in Report Service`);

      const imageUrl = req.file.path;
      const insertResult = await pool.query(`
        INSERT INTO image_submissions (user_id, latitude, longitude, description, image_url, status)
        VALUES ($1, $2, $3, $4, $5, 'analyzing')
        RETURNING id
      `, [userId, latitude, longitude, description || '', imageUrl]);

      submissionId = insertResult.rows[0].id;
      console.log(` Created image_submission #${submissionId}`);

      const geminiServiceUrl = process.env.GEMINI_SERVICE_URL || 'http://gemini-service:3010';
      console.log(` Calling Gemini Service at ${geminiServiceUrl}...`);

      let analysis;
      try {
        const formData = new FormData();
        formData.append('image', fs.createReadStream(req.file.path), {
          filename: req.file.originalname,
          contentType: req.file.mimetype,
        });

        const geminiResponse = await axios.post(`${geminiServiceUrl}/analyze`, formData, {
          headers: { ...formData.getHeaders() },
          timeout: 30000
        });

        if (!geminiResponse.data.success) {
          throw new Error(geminiResponse.data.error || 'Gemini service failed');
        }
        analysis = geminiResponse.data;
        console.log(' Gemini Analysis Result:', analysis);

      } catch (geminiErr) {
        console.error(' Gemini Service Error:', geminiErr.message);

        await pool.query(`
          UPDATE image_submissions
          SET status = 'error', error_message = $1, analyzed_at = NOW()
          WHERE id = $2
        `, [geminiErr.message, submissionId]);

        if (geminiErr.response) {
          console.error('Gemini Service Response Data:', geminiErr.response.data);
        }
        throw new Error('AI шалгалт амжилтгүй боллоо: ' + (geminiErr.response?.data?.error || geminiErr.message));
      }

      await pool.query(`
        UPDATE image_submissions
        SET ai_analyzed = true,
            is_accident = $1,
            ai_confidence = $2,
            ai_description = $3,
            ai_type = $4,
            analyzed_at = NOW(),
            status = $5
        WHERE id = $6
      `, [
        analysis.isAccident,
        analysis.confidence,
        analysis.description,
        analysis.type,
        analysis.isAccident ? 'accident_detected' : 'no_accident',
        submissionId
      ]);

      if (analysis.isAccident) {
        console.log(' Accident detected! Creating accident...');

        const accidentServiceUrl = process.env.ACCIDENT_SERVICE_URL || 'http://accident-service:3002';
        const formData = new FormData();

        formData.append('image', fs.createReadStream(req.file.path), {
          filename: req.file.originalname,
          contentType: req.file.mimetype,
        });

        formData.append('latitude', latitude);
        formData.append('longitude', longitude);
        formData.append('description', analysis.description || description || '');

        formData.append('skipAnalysis', 'true');
        formData.append('analysisData', JSON.stringify(analysis));
        formData.append('submissionId', submissionId.toString());

        const response = await axios.post(
          `${accidentServiceUrl}/accidents/report-image`,
          formData,
          {
            headers: {
              ...formData.getHeaders(),
              'Authorization': authHeader,
            },
            timeout: 60000,
          }
        );

        if (response.data.success && response.data.data?.id) {
          await pool.query(`
            UPDATE image_submissions
            SET accident_id = $1, status = 'accident_created'
            WHERE id = $2
          `, [response.data.data.id, submissionId]);
        }

        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);

        res.status(response.status).json(response.data);

      } else {
        console.log(' No accident detected. Image saved to submissions.');

        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);

        res.json({
          success: true,
          message: 'Зураг шалгагдлаа. Осол илрээгүй.',
          data: {
            submissionId: submissionId,
            isAccident: false,
            analysis: {
              confidence: analysis.confidence,
              description: analysis.description,
              type: analysis.type
            }
          }
        });
      }

    } catch (error) {
      console.error('Report image error:', error.message);

      if (req.file && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }

      if (error.response) {
        return res.status(error.response.status).json(error.response.data);
      }

      res.status(500).json({
        success: false,
        error: 'Зураг илгээхэд алдаа гарлаа',
        submissionId: submissionId,
        details: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  });

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

process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully...');
  await pool.end();
  await redis.quit();
  process.exit(0);
});

app.listen(PORT, () => {
  console.log(` Report Service запущен на порту ${PORT}`);
});

module.exports = app;