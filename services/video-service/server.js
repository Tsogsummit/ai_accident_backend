// services/video-service/server.js - FIXED VERSION
const express = require('express');
const multer = require('multer');
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs').promises;
const axios = require('axios');

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
    const { userId, latitude, longitude, description } = req.body;
    
    console.log('📹 Video upload started');
    console.log('   userId:', userId);
    console.log('   latitude:', latitude);
    console.log('   longitude:', longitude);
    
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
        status, source, accident_time
      )
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
      RETURNING *
    `, [
      userId,
      parseFloat(latitude),
      parseFloat(longitude),
      description || 'Камераас бичигдсэн осол',
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

    // ✅ STEP 5: Trigger AI detection (async, don't wait)
    // Pass relative file path (filename only) since volumes are shared
    const aiServiceUrl = process.env.AI_SERVICE_URL || 'http://ai-detection-service:3004';
    const relativeFilePath = fileName; // Just the filename, AI service will find it in /app/uploads
    triggerAIDetection(video.id, userId, relativeFilePath, parseFloat(latitude), parseFloat(longitude), description || 'Камераас бичигдсэн осол')
      .catch(err => {
        console.error('⚠️ Failed to trigger AI detection:', err.message);
        // Don't fail the upload if AI service is unavailable
      });

    // ✅ SUCCESS RESPONSE
    res.status(200).json({
      success: true,
      message: 'Видео амжилттай илгээгдлээ. AI шалгалт эхэллээ.',
      videoId: video.id,
      accidentId: accident.id,
      status: 'uploaded',
      aiProcessing: true,
      accident: {
        id: accident.id,
        latitude: accident.latitude,
        longitude: accident.longitude,
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

// GET /videos/:id/status - Video status шалгах (with AI detection results)
app.get('/videos/:id/status', async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(`
      SELECT 
        v.*,
        a.id as accident_id,
        a.latitude,
        a.longitude,
        a.status as accident_status,
        aid.confidence as ai_confidence,
        aid.detected_objects as ai_detected_objects,
        aid.status as ai_detection_status,
        aid.processed_at as ai_processed_at
      FROM videos v
      LEFT JOIN accidents a ON v.accident_id = a.id
      LEFT JOIN ai_detections aid ON v.id = aid.video_id
      WHERE v.id = $1
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ 
        success: false,
        error: 'Бичлэг олдсонгүй' 
      });
    }

    const video = result.rows[0];
    
    // Parse AI detection results if available
    let aiDetection = null;
    if (video.ai_detected_objects) {
      try {
        const detectedObjects = typeof video.ai_detected_objects === 'string' 
          ? JSON.parse(video.ai_detected_objects) 
          : video.ai_detected_objects;
        
        aiDetection = {
          status: video.ai_detection_status || 'pending',
          confidence: video.ai_confidence || null,
          hasAccident: detectedObjects.hasAccident || false,
          totalFrames: detectedObjects.totalFrames || null,
          confirmedTracks: detectedObjects.confirmedTracks || null,
          suspiciousFrames: detectedObjects.suspiciousFrames || [],
          indicatorCounts: detectedObjects.indicatorCounts || {},
          processedAt: video.ai_processed_at || null,
          details: detectedObjects
        };
      } catch (e) {
        console.warn('Failed to parse AI detection results:', e);
        aiDetection = {
          status: video.ai_detection_status || 'pending',
          confidence: video.ai_confidence || null,
          hasAccident: false,
          error: 'Failed to parse detection results'
        };
      }
    }
    
    // Determine AI processing status
    let aiProcessingStatus = 'pending';
    if (video.status === 'processing') {
      aiProcessingStatus = 'processing';
    } else if (video.status === 'completed' && aiDetection) {
      aiProcessingStatus = 'completed';
    } else if (video.status === 'failed') {
      aiProcessingStatus = 'failed';
    }
    
    res.json({
      success: true,
      videoId: video.id,
      accidentId: video.accident_id,
      status: video.status,
      uploadedAt: video.uploaded_at,
      processingStartedAt: video.processing_started_at || null,
      processingCompletedAt: video.processing_completed_at || null,
      errorMessage: video.error_message || null,
      aiDetection: aiDetection,
      aiProcessingStatus: aiProcessingStatus,
      accident: {
        id: video.accident_id,
        latitude: video.latitude,
        longitude: video.longitude,
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
        a.longitude
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

// Function to trigger AI detection
async function triggerAIDetection(videoId, userId, filePath, latitude, longitude, description) {
  const aiServiceUrl = process.env.AI_SERVICE_URL || 'http://ai-detection-service:3004';
  
  try {
    console.log(`🤖 Triggering AI detection for video ${videoId}`);
    
    const response = await axios.post(`${aiServiceUrl}/detect/video`, {
      videoId: videoId,
      userId: userId,
      filePath: filePath,
      latitude: latitude,
      longitude: longitude,
      description: description
    }, {
      timeout: 5000 // 5 second timeout for initial request
    });
    
    console.log(`✅ AI detection triggered: videoId=${videoId}, status=${response.data.status}`);
    return response.data;
    
  } catch (error) {
    console.error(`❌ AI detection trigger error for video ${videoId}:`, error.message);
    
    // Update video status to indicate AI service unavailable
    try {
      const client = await pool.connect();
      await client.query(`
        UPDATE videos 
        SET status = 'uploaded', 
            error_message = $1
        WHERE id = $2
      `, [`AI service unavailable: ${error.message}`, videoId]);
      client.release();
    } catch (dbErr) {
      console.error('Failed to update video status:', dbErr);
    }
    
    throw error;
  }
}

// POST /videos/:id/retry-ai - Retry AI detection for a video
app.post('/videos/:id/retry-ai', async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await pool.query(`
      SELECT v.*, a.latitude, a.longitude, a.description
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
    const fileName = path.basename(video.file_path);
    
    console.log(`🔄 Retrying AI detection for video ${id}`);
    
    // Trigger AI detection
    try {
      await triggerAIDetection(
        video.id,
        video.user_id,
        fileName,
        parseFloat(video.latitude || 0),
        parseFloat(video.longitude || 0),
        video.description || ''
      );
      
      res.json({
        success: true,
        message: 'AI шалгалт дахин эхэллээ',
        videoId: video.id
      });
    } catch (aiError) {
      res.status(500).json({
        success: false,
        error: `AI шалгалт эхлүүлэхэд алдаа: ${aiError.message}`
      });
    }
    
  } catch (error) {
    console.error('Retry AI detection error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Алдаа гарлаа' 
    });
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