// services/video-service/server.js - БҮРЭН ЗАСВАРЛАСАН
const express = require('express');
const multer = require('multer');
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs').promises;
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3003;

// ============================================
// MIDDLEWARE
// ============================================

app.use(cors());
app.use(express.json());

// ============================================
// DATABASE CONNECTION
// ============================================

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

// Test database connection
pool.on('connect', () => {
  console.log('✅ PostgreSQL холбогдлоо');
});

pool.on('error', (err) => {
  console.error('❌ PostgreSQL алдаа:', err);
});

// ============================================
// MULTER SETUP - VIDEO UPLOAD
// ============================================

const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const uploadDir = path.join(__dirname, 'uploads');
    try {
      await fs.mkdir(uploadDir, { recursive: true });
      cb(null, uploadDir);
    } catch (error) {
      cb(error, uploadDir);
    }
  },
  filename: (req, file, cb) => {
    const uniqueName = `${Date.now()}-${Math.random().toString(36).substring(7)}-${file.originalname}`;
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['video/mp4', 'video/quicktime', 'video/x-msvideo', 'video/webm'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Зөвхөн видео файл зөвшөөрөгдөнө. Танай файл: ${file.mimetype}`));
    }
  }
});

// ============================================
// HELPER FUNCTIONS
// ============================================

async function createAccidentFromVideo(videoData, client) {
  const { userId, latitude, longitude, description, severity, videoPath } = videoData;
  
  const result = await client.query(`
    INSERT INTO accidents (
      user_id,
      latitude,
      longitude,
      description,
      severity,
      status,
      source,
      image_url,
      accident_time,
      reported_by
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), $9)
    RETURNING *
  `, [
    userId,
    latitude,
    longitude,
    description || 'Камераас бичигдсэн осол',
    severity || 'moderate',
    'reported',
    'camera',
    videoPath, // Store video path in image_url for now
    'Camera Detection'
  ]);
  
  return result.rows[0];
}

async function storeVideoMetadata(videoData, client) {
  const { userId, fileName, filePath, fileSize, mimeType } = videoData;
  
  const result = await client.query(`
    INSERT INTO videos (
      user_id,
      file_name,
      file_path,
      file_size,
      mime_type,
      status,
      uploaded_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, NOW())
    RETURNING *
  `, [
    userId,
    fileName,
    filePath,
    fileSize,
    mimeType,
    'uploaded'
  ]);
  
  return result.rows[0];
}

// ============================================
// ROUTES
// ============================================

// POST /upload - VIDEO UPLOAD (SIMPLIFIED - NO GCS)
app.post('/upload', upload.single('video'), async (req, res) => {
  const client = await pool.connect();
  
  try {
    console.log('📹 Video upload эхэллээ...');
    console.log('Body:', req.body);
    console.log('File:', req.file ? {
      filename: req.file.filename,
      size: req.file.size,
      mimetype: req.file.mimetype
    } : 'No file');

    // Validate request
    if (!req.file) {
      return res.status(400).json({ 
        success: false,
        error: 'Видео файл байхгүй байна' 
      });
    }

    const { userId, latitude, longitude, description, severity } = req.body;

    if (!userId || !latitude || !longitude) {
      // Delete uploaded file
      await fs.unlink(req.file.path).catch(console.error);
      return res.status(400).json({ 
        success: false,
        error: 'userId, latitude, longitude шаардлагатай' 
      });
    }

    await client.query('BEGIN');

    // 1. Store video metadata
    const videoRecord = await storeVideoMetadata({
      userId: parseInt(userId),
      fileName: req.file.originalname,
      filePath: `/videos/${req.file.filename}`,
      fileSize: req.file.size,
      mimeType: req.file.mimetype
    }, client);

    console.log('✅ Video metadata хадгалагдлаа:', videoRecord.id);

    // 2. Create accident record
    const accident = await createAccidentFromVideo({
      userId: parseInt(userId),
      latitude: parseFloat(latitude),
      longitude: parseFloat(longitude),
      description,
      severity: severity || 'moderate',
      videoPath: `/videos/${req.file.filename}`
    }, client);

    console.log('✅ Accident үүсгэгдлээ:', accident.id);

    // 3. Link video to accident
    await client.query(`
      UPDATE videos 
      SET accident_id = $1, status = 'processed'
      WHERE id = $2
    `, [accident.id, videoRecord.id]);

    await client.query('COMMIT');

    console.log('✅ Video амжилттай боловсруулагдлаа');

    res.status(200).json({
      success: true,
      message: 'Видео амжилттай илгээгдлээ',
      videoId: videoRecord.id,
      accidentId: accident.id,
      status: 'processed',
      data: {
        accident: accident,
        video: videoRecord
      }
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Video upload error:', error);
    
    // Cleanup: delete uploaded file
    if (req.file) {
      await fs.unlink(req.file.path).catch(err => 
        console.error('Failed to delete temp file:', err)
      );
    }
    
    res.status(500).json({ 
      success: false,
      error: 'Видео илгээхэд алдаа гарлаа',
      details: error.message 
    });
  } finally {
    client.release();
  }
});

// GET /videos/:id/status - VIDEO STATUS
app.get('/videos/:id/status', async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(`
      SELECT 
        v.*,
        a.id as accident_id,
        a.latitude,
        a.longitude,
        a.description as accident_description
      FROM videos v
      LEFT JOIN accidents a ON v.accident_id = a.id
      WHERE v.id = $1
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ 
        success: false,
        error: 'Видео олдсонгүй' 
      });
    }

    const video = result.rows[0];
    
    res.json({
      success: true,
      videoId: video.id,
      status: video.status,
      accidentId: video.accident_id,
      uploadedAt: video.uploaded_at,
      data: video
    });

  } catch (error) {
    console.error('Video status error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Статус шалгахад алдаа гарлаа' 
    });
  }
});

// GET /videos - GET ALL VIDEOS
app.get('/videos', async (req, res) => {
  try {
    const { userId, limit = 20, offset = 0 } = req.query;

    let query = `
      SELECT 
        v.*,
        a.id as accident_id,
        a.latitude,
        a.longitude
      FROM videos v
      LEFT JOIN accidents a ON v.accident_id = a.id
    `;
    
    const params = [];
    
    if (userId) {
      query += ` WHERE v.user_id = $1`;
      params.push(userId);
      query += ` ORDER BY v.uploaded_at DESC LIMIT $2 OFFSET $3`;
      params.push(limit, offset);
    } else {
      query += ` ORDER BY v.uploaded_at DESC LIMIT $1 OFFSET $2`;
      params.push(limit, offset);
    }

    const result = await pool.query(query, params);

    res.json({
      success: true,
      data: result.rows,
      count: result.rows.length
    });

  } catch (error) {
    console.error('Get videos error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Видео жагсаалт авахад алдаа гарлаа' 
    });
  }
});

// DELETE /videos/:id - DELETE VIDEO
app.delete('/videos/:id', async (req, res) => {
  const client = await pool.connect();
  
  try {
    const { id } = req.params;
    const { userId } = req.body;

    await client.query('BEGIN');

    // Get video info
    const result = await client.query(`
      SELECT file_path, user_id FROM videos WHERE id = $1
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ 
        success: false,
        error: 'Видео олдсонгүй' 
      });
    }

    const video = result.rows[0];

    // Check ownership
    if (video.user_id !== parseInt(userId)) {
      return res.status(403).json({ 
        success: false,
        error: 'Видео устгах эрхгүй' 
      });
    }

    // Delete file from disk
    const filePath = path.join(__dirname, 'uploads', path.basename(video.file_path));
    await fs.unlink(filePath).catch(err => 
      console.warn('File already deleted or not found:', err.message)
    );

    // Delete from database
    await client.query(`DELETE FROM videos WHERE id = $1`, [id]);

    await client.query('COMMIT');

    res.json({ 
      success: true,
      message: 'Видео амжилттай устгагдлаа' 
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Video delete error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Видео устгахад алдаа гарлаа' 
    });
  } finally {
    client.release();
  }
});

// GET /videos/:id/download - GET VIDEO FILE
app.get('/videos/:id/download', async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(`
      SELECT file_path, file_name FROM videos WHERE id = $1
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ 
        success: false,
        error: 'Видео олдсонгүй' 
      });
    }

    const { file_path, file_name } = result.rows[0];
    const filePath = path.join(__dirname, 'uploads', path.basename(file_path));

    // Check if file exists
    try {
      await fs.access(filePath);
    } catch {
      return res.status(404).json({ 
        success: false,
        error: 'Видео файл олдсонгүй' 
      });
    }

    // Send file
    res.download(filePath, file_name);

  } catch (error) {
    console.error('Video download error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Видео татахад алдаа гарлаа' 
    });
  }
});

// ============================================
// HEALTH CHECK
// ============================================

app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    service: 'video-service',
    timestamp: new Date().toISOString(),
    storage: 'local', // Changed from GCS to local
    uptime: process.uptime()
  });
});

// ============================================
// ERROR HANDLING
// ============================================

app.use((error, req, res, next) => {
  console.error('Server error:', error);
  
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ 
        success: false,
        error: 'Файл хэт том байна. Максимум 100MB' 
      });
    }
    return res.status(400).json({ 
      success: false,
      error: `Upload алдаа: ${error.message}` 
    });
  }
  
  res.status(500).json({ 
    success: false,
    error: error.message || 'Серверийн алдаа' 
  });
});

// ============================================
// START SERVER
// ============================================

app.listen(PORT, () => {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📹 VIDEO SERVICE');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`🚀 Server: http://localhost:${PORT}`);
  console.log(`💾 Storage: Local (uploads/)`);
  console.log(`🗄️  Database: ${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || 5432}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, closing server...');
  await pool.end();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, closing server...');
  await pool.end();
  process.exit(0);
});

module.exports = app;