// services/video-service/server.js
const express = require('express');
const multer = require('multer');
const { Pool } = require('pg');
const { Storage } = require('@google-cloud/storage');
const { PubSub } = require('@google-cloud/pubsub');
const path = require('path');
const fs = require('fs').promises;

const app = express();
const PORT = process.env.PORT || 3003;

app.use(express.json());

// PostgreSQL
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'accident_db',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres'
});

// Google Cloud Storage
const storage = new Storage({
  projectId: process.env.GCP_PROJECT_ID,
  keyFilename: process.env.GCP_KEY_FILE
});

const bucketName = process.env.GCS_BUCKET_NAME || 'accident-videos';
const bucket = storage.bucket(bucketName);

// Google Cloud Pub/Sub (AI боловсруулалтын queue)
const pubsub = new PubSub({
  projectId: process.env.GCP_PROJECT_ID,
  keyFilename: process.env.GCP_KEY_FILE
});

const topicName = 'video-processing';
const topic = pubsub.topic(topicName);

// Multer setup - бичлэг түр хадгалах
const upload = multer({
  dest: 'uploads/',
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB хязгаар
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['video/mp4', 'video/quicktime', 'video/x-msvideo'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Зөвхөн video файл зөвшөөрөгдөнө (mp4, mov, avi)'));
    }
  }
});

// POST /videos/upload - Бичлэг upload хийх
app.post('/videos/upload', upload.single('video'), async (req, res) => {
  const client = await pool.connect();
  
  try {
    const { userId, latitude, longitude, description } = req.body;
    
    if (!req.file) {
      return res.status(400).json({ error: 'Бичлэг файл байхгүй байна' });
    }

    if (!userId || !latitude || !longitude) {
      await fs.unlink(req.file.path); // Файл устгах
      return res.status(400).json({ 
        error: 'userId, latitude, longitude шаардлагатай' 
      });
    }

    const file = req.file;
    const fileName = `${Date.now()}-${userId}-${file.originalname}`;
    const filePath = `videos/${fileName}`;

    console.log(`📹 Бичлэг хүлээн авлаа: ${file.originalname} (${(file.size / 1024 / 1024).toFixed(2)}MB)`);

    await client.query('BEGIN');

    // 1. Database-д video бүртгэл үүсгэх
    const videoResult = await client.query(`
      INSERT INTO videos (
        user_id, file_name, file_path, file_size, 
        duration, mime_type, status, uploaded_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
      RETURNING *
    `, [
      userId,
      file.originalname,
      filePath,
      file.size,
      null, // Duration AI боловсруулалтаас авна
      file.mimetype,
      'uploading'
    ]);

    const video = videoResult.rows[0];

    // 2. Google Cloud Storage-д upload
    await bucket.upload(file.path, {
      destination: filePath,
      metadata: {
        contentType: file.mimetype,
        metadata: {
          userId: userId,
          videoId: video.id,
          uploadedAt: new Date().toISOString()
        }
      }
    });

    console.log(`☁️  GCS-д амжилттай: ${filePath}`);

    // 3. Локал файл устгах
    await fs.unlink(file.path);

    // 4. Video статус шинэчлэх
    await client.query(`
      UPDATE videos 
      SET status = 'uploaded', file_path = $1
      WHERE id = $2
    `, [filePath, video.id]);

    // 5. AI боловсруулалтын queue-д илгээх
    const messageData = {
      videoId: video.id,
      userId: userId,
      filePath: filePath,
      latitude: parseFloat(latitude),
      longitude: parseFloat(longitude),
      description: description || '',
      timestamp: new Date().toISOString()
    };

    await topic.publishMessage({
      data: Buffer.from(JSON.stringify(messageData))
    });

    console.log(`🤖 AI queue-д нэмэгдлээ: videoId=${video.id}`);

    await client.query('COMMIT');

    res.status(202).json({
      message: 'Бичлэг амжилттай илгээгдлээ, боловсруулж байна',
      videoId: video.id,
      status: 'processing',
      estimatedTime: '30-60 seconds'
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Video upload error:', error);
    
    // Cleanup on error
    if (req.file) {
      try {
        await fs.unlink(req.file.path);
      } catch (unlinkError) {
        console.error('Failed to delete temp file:', unlinkError);
      }
    }
    
    res.status(500).json({ 
      error: 'Бичлэг upload хийхэд алдаа гарлаа',
      details: error.message 
    });
  } finally {
    client.release();
  }
});

// GET /videos/:id/status - Бичлэг боловсруулалтын статус
app.get('/videos/:id/status', async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(`
      SELECT v.*, aid.status as ai_status, aid.confidence, aid.detected_objects
      FROM videos v
      LEFT JOIN ai_detections aid ON v.id = aid.video_id
      WHERE v.id = $1
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Бичлэг олдсонгүй' });
    }

    const video = result.rows[0];
    
    res.json({
      videoId: video.id,
      status: video.status,
      aiStatus: video.ai_status,
      confidence: video.confidence,
      detectedObjects: video.detected_objects,
      uploadedAt: video.uploaded_at,
      processedAt: video.processed_at
    });

  } catch (error) {
    console.error('Video status error:', error);
    res.status(500).json({ error: 'Статус шалгахад алдаа гарлаа' });
  }
});

// GET /videos/:id/download - Бичлэг татаж авах
app.get('/videos/:id/download', async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(`
      SELECT file_path, file_name FROM videos WHERE id = $1
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Бичлэг олдсонгүй' });
    }

    const { file_path, file_name } = result.rows[0];

    // Signed URL үүсгэх (15 минутын хугацаатай)
    const [url] = await bucket.file(file_path).getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: Date.now() + 15 * 60 * 1000, // 15 минут
    });

    res.json({
      downloadUrl: url,
      fileName: file_name,
      expiresIn: '15 minutes'
    });

  } catch (error) {
    console.error('Video download error:', error);
    res.status(500).json({ error: 'Download URL үүсгэхэд алдаа гарлаа' });
  }
});

// DELETE /videos/:id - Бичлэг устгах
app.delete('/videos/:id', async (req, res) => {
  const client = await pool.connect();
  
  try {
    const { id } = req.params;
    const { userId } = req.body;

    await client.query('BEGIN');

    // Бичлэгийн мэдээлэл авах
    const result = await client.query(`
      SELECT file_path, user_id FROM videos WHERE id = $1
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Бичлэг олдсонгүй' });
    }

    const video = result.rows[0];

    // Зөвхөн өөрийн бичлэгийг устгах эрхтэй
    if (video.user_id !== userId) {
      return res.status(403).json({ error: 'Бичлэг устгах эрхгүй' });
    }

    // GCS-ээс устгах
    await bucket.file(video.file_path).delete();

    // Database-ээс устгах
    await client.query(`DELETE FROM videos WHERE id = $1`, [id]);

    await client.query('COMMIT');

    res.json({ message: 'Бичлэг амжилттай устгагдлаа' });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Video delete error:', error);
    res.status(500).json({ error: 'Бичлэг устгахад алдаа гарлаа' });
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

app.listen(PORT, () => {
  console.log(`📹 Video Service запущен на порту ${PORT}`);
  console.log(`☁️  GCS bucket: ${bucketName}`);
  console.log(`📨 Pub/Sub topic: ${topicName}`);
});

module.exports = app;