// services/video-service/server.js - FIXED VERSION
const express = require('express');
const multer = require('multer');
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs').promises;

const app = express();
const PORT = process.env.PORT || 3003;

app.use(express.json());

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// PostgreSQL
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'accident_db',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres'
});

// Multer setup - бичлэг түр хадгалах
const upload = multer({
  dest: 'uploads/',
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['video/mp4', 'video/quicktime', 'video/x-msvideo', 'video/webm'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Зөвхөн video файл зөвшөөрөгдөнө (mp4, mov, avi, webm)'));
    }
  }
});

// ✅✅✅ FIXED: POST /upload - Simplified workflow
app.post('/upload', upload.single('video'), async (req, res) => {
  const client = await pool.connect();
  
  try {
    const { userId, latitude, longitude, description, severity } = req.body;
    
    console.log('📹 Video upload started');
    console.log('   userId:', userId);
    console.log('   latitude:', latitude);
    console.log('   longitude:', longitude);
    console.log('   severity:', severity);
    
    // Validation
    if (!req.file) {
      return res.status(400).json({ 
        success: false,
        error: 'Бичлэг файл байхгүй байна' 
      });
    }

    if (!userId || !latitude || !longitude) {
      await fs.unlink(req.file.path);
      return res.status(400).json({ 
        success: false,
        error: 'userId, latitude, longitude шаардлагатай' 
      });
    }

    const file = req.file;
    const fileName = `${Date.now()}-${userId}-${file.originalname}`;
    const filePath = `uploads/${fileName}`;

    console.log(`📹 Video: ${file.originalname} (${(file.size / 1024 / 1024).toFixed(2)}MB)`);

    await client.query('BEGIN');

    // ✅ STEP 1: Create accident FIRST
    const accidentResult = await client.query(`
      INSERT INTO accidents (
        user_id, latitude, longitude, description, 
        severity, status, source, accident_time
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
      RETURNING *
    `, [
      userId,
      parseFloat(latitude),
      parseFloat(longitude),
      description || 'Камераас бичигдсэн осол',
      severity || 'moderate',
      'reported',
      'user'
    ]);

    const accident = accidentResult.rows[0];
    console.log(`✅ Accident created: ID=${accident.id}`);

    // ✅ STEP 2: Create video with accident_id
    const videoResult = await client.query(`
      INSERT INTO videos (
        user_id, accident_id, file_name, file_path, file_size, 
        mime_type, status, uploaded_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
      RETURNING *
    `, [
      userId,
      accident.id, // ✅ Link to accident
      file.originalname,
      filePath,
      file.size,
      file.mimetype,
      'uploaded'
    ]);

    const video = videoResult.rows[0];
    console.log(`✅ Video created: ID=${video.id}`);

    // ✅ STEP 3: Update accident with video_id
    await client.query(`
      UPDATE accidents 
      SET video_id = $1
      WHERE id = $2
    `, [video.id, accident.id]);

    console.log(`✅ Accident-Video linked: A-${accident.id} ↔ V-${video.id}`);

    // ✅ STEP 4: Move file from temp to uploads folder
    const finalPath = path.join(__dirname, 'uploads', fileName);
    await fs.rename(file.path, finalPath);
    console.log(`✅ File saved: ${finalPath}`);

    await client.query('COMMIT');

    // ✅ SUCCESS RESPONSE
    res.status(200).json({
      success: true,
      message: 'Видео амжилттай илгээгдлээ',
      videoId: video.id,
      accidentId: accident.id,
      status: 'uploaded',
      accident: {
        id: accident.id,
        latitude: accident.latitude,
        longitude: accident.longitude,
        severity: accident.severity,
        status: accident.status,
        description: accident.description
      }
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Video upload error:', error);
    
    // Cleanup temp file
    if (req.file) {
      try {
        await fs.unlink(req.file.path);
      } catch (e) {
        console.error('Failed to delete temp file:', e);
      }
    }
    
    res.status(500).json({ 
      success: false,
      error: error.message || 'Бичлэг upload хийхэд алдаа гарлаа'
    });
  } finally {
    client.release();
  }
});

// GET /videos/:id/status - Video status шалгах
app.get('/videos/:id/status', async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(`
      SELECT 
        v.*,
        a.id as accident_id,
        a.latitude,
        a.longitude,
        a.severity,
        a.status as accident_status
      FROM videos v
      LEFT JOIN accidents a ON v.accident_id = a.id
      WHERE v.id = $1
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ 
        success: false,
        error: 'Бичлэг олдсонгүй' 
      });
    }

    const video = result.rows[0];
    
    res.json({
      success: true,
      videoId: video.id,
      accidentId: video.accident_id,
      status: video.status,
      uploadedAt: video.uploaded_at,
      accident: {
        id: video.accident_id,
        latitude: video.latitude,
        longitude: video.longitude,
        severity: video.severity,
        status: video.accident_status
      }
    });

  } catch (error) {
    console.error('Video status error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Статус шалгахад алдаа гарлаа' 
    });
  }
});

// GET /videos - List videos
app.get('/videos', async (req, res) => {
  try {
    const { limit = 50, offset = 0, status } = req.query;

    let query = `
      SELECT 
        v.*,
        a.id as accident_id,
        a.latitude,
        a.longitude,
        a.severity
      FROM videos v
      LEFT JOIN accidents a ON v.accident_id = a.id
    `;

    const params = [];
    if (status) {
      query += ` WHERE v.status = $1`;
      params.push(status);
    }

    query += ` ORDER BY v.uploaded_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const result = await pool.query(query, params);

    res.json({
      success: true,
      data: result.rows,
      total: result.rows.length
    });

  } catch (error) {
    console.error('Get videos error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Бичлэг жагсаалт авахад алдаа гарлаа' 
    });
  }
});

// DELETE /videos/:id - Delete video
app.delete('/videos/:id', async (req, res) => {
  const client = await pool.connect();
  
  try {
    const { id } = req.params;
    const { userId } = req.body;

    await client.query('BEGIN');

    const result = await client.query(`
      SELECT file_path, user_id, accident_id FROM videos WHERE id = $1
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ 
        success: false,
        error: 'Бичлэг олдсонгүй' 
      });
    }

    const video = result.rows[0];

    if (video.user_id !== parseInt(userId)) {
      return res.status(403).json({ 
        success: false,
        error: 'Бичлэг устгах эрхгүй' 
      });
    }

    // Delete video file
    try {
      await fs.unlink(path.join(__dirname, video.file_path));
    } catch (e) {
      console.warn('File already deleted or not found:', e.message);
    }

    // Delete from database
    await client.query(`DELETE FROM videos WHERE id = $1`, [id]);

    await client.query('COMMIT');

    res.json({ 
      success: true,
      message: 'Бичлэг амжилттай устгагдлаа' 
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Video delete error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Бичлэг устгахад алдаа гарлаа' 
    });
  } finally {
    client.release();
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    service: 'video-service',
    timestamp: new Date().toISOString()
  });
});

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, 'uploads');
fs.mkdir(uploadsDir, { recursive: true }).catch(console.error);

app.listen(PORT, () => {
  console.log(`📹 Video Service running on port ${PORT}`);
  console.log(`📁 Uploads directory: ${uploadsDir}`);
});

module.exports = app;