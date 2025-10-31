// services/camera-service/src/services/hlsProcessor.js
/**
 * HLS Stream Processor
 * UB Traffic болон бусад HLS stream-үүдийг боловсруулах
 */

const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');
const { createWriteStream, createReadStream, unlinkSync, existsSync } = require('fs');
const { join } = require('path');
const { tmpdir } = require('os');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../config/database');
const logger = require('../utils/logger');

class HLSStreamProcessor {
  constructor(camera) {
    this.camera = camera;
    this.activeProcessing = false;
    this.processedSegments = new Set();
    this.frameInterval = parseInt(process.env.FRAME_INTERVAL) || 5000; // 5 секунд
  }

  /**
   * HLS stream боловсруулалт эхлүүлэх
   */
  async start() {
    if (this.activeProcessing) {
      logger.warn(`Camera ${this.camera.id} already processing`);
      return;
    }

    logger.info(`▶️  Starting HLS processing: ${this.camera.name}`);
    
    this.activeProcessing = true;
    
    // Database-д recording төлөв өөрчлөх
    await this.updateRecordingStatus(true);

    // Frame extraction loop эхлүүлэх
    this.processingLoop();
  }

  /**
   * Боловсруулалт зогсоох
   */
  async stop() {
    logger.info(`⏸️  Stopping HLS processing: ${this.camera.name}`);
    this.activeProcessing = false;
    await this.updateRecordingStatus(false);
  }

  /**
   * Үндсэн боловсруулалтын loop
   */
  async processingLoop() {
    while (this.activeProcessing) {
      try {
        await this.processStreamCycle();
        
        // Интервал
        await this.sleep(this.frameInterval);
        
      } catch (error) {
        logger.error(`Processing loop error for camera ${this.camera.id}:`, error);
        
        // Алдааны статус хадгалах
        await this.updateError(error.message);
        
        // 10 секунд хүлээх
        await this.sleep(10000);
      }
    }
  }

  /**
   * Нэг цикл боловсруулалт
   */
  async processStreamCycle() {
    try {
      // 1. M3U8 playlist татаж авах
      const chunklistUrl = await this.getChunklistUrl();
      
      // 2. Сүүлийн TS segment авах
      const segmentUrl = await this.getLatestSegment(chunklistUrl);
      
      if (!segmentUrl) {
        logger.debug(`No new segments for camera ${this.camera.id}`);
        return;
      }

      // 3. TS segment татаж, frame-үүд задлах
      const frames = await this.extractFramesFromSegment(segmentUrl);
      
      // 4. Frame-үүдийг хадгалж, AI detection руу илгээх
      for (const frame of frames) {
        await this.processFrame(frame);
      }

      logger.info(`✅ Processed ${frames.length} frames from camera ${this.camera.id}`);
      
    } catch (error) {
      logger.error(`Stream cycle error:`, error);
      throw error;
    }
  }

  /**
   * M3U8 playlist-ээс chunklist URL авах
   */
  async getChunklistUrl() {
    try {
      const response = await axios.get(this.camera.stream_url, {
        timeout: 5000,
        headers: {
          'User-Agent': 'Mozilla/5.0'
        }
      });

      const content = response.data;
      const lines = content.split('\n');
      
      // chunklist.m3u8 файлыг олох
      const chunklistLine = lines.find(line => 
        line.includes('chunklist') && line.endsWith('.m3u8')
      );

      if (!chunklistLine) {
        throw new Error('Chunklist not found in playlist');
      }

      // Base URL + chunklist
      const baseUrl = this.camera.stream_url.substring(
        0, 
        this.camera.stream_url.lastIndexOf('/')
      );
      
      return `${baseUrl}/${chunklistLine.trim()}`;
      
    } catch (error) {
      logger.error(`Failed to get chunklist:`, error);
      throw error;
    }
  }

  /**
   * Chunklist-ээс сүүлийн segment URL авах
   */
  async getLatestSegment(chunklistUrl) {
    try {
      const response = await axios.get(chunklistUrl, {
        timeout: 5000,
        headers: {
          'User-Agent': 'Mozilla/5.0'
        }
      });

      const content = response.data;
      const lines = content.split('\n');
      
      // .ts файлуудыг олох
      const tsFiles = lines.filter(line => line.trim().endsWith('.ts'));
      
      if (tsFiles.length === 0) {
        return null;
      }

      // Сүүлийн 2 segment (илүү тогтвортой)
      const latestSegment = tsFiles[tsFiles.length - 2] || tsFiles[tsFiles.length - 1];
      const segmentName = latestSegment.trim();
      
      // Давхар боловсруулахгүй байх
      if (this.processedSegments.has(segmentName)) {
        return null;
      }

      // Cache-д нэмэх
      this.processedSegments.add(segmentName);
      
      // Cache хэт том болохоос сэргийлэх
      if (this.processedSegments.size > 50) {
        const firstItem = this.processedSegments.values().next().value;
        this.processedSegments.delete(firstItem);
      }

      // Base URL + segment
      const baseUrl = chunklistUrl.substring(0, chunklistUrl.lastIndexOf('/'));
      return `${baseUrl}/${segmentName}`;
      
    } catch (error) {
      logger.error(`Failed to get latest segment:`, error);
      return null;
    }
  }

  /**
   * TS segment-ээс frame-үүд задлах
   */
  async extractFramesFromSegment(segmentUrl) {
    const tempDir = tmpdir();
    const segmentPath = join(tempDir, `${uuidv4()}.ts`);
    const outputPattern = join(tempDir, `${uuidv4()}-frame-%03d.jpg`);

    try {
      // 1. TS segment татаж авах
      logger.debug(`Downloading segment: ${segmentUrl}`);
      
      const response = await axios.get(segmentUrl, {
        responseType: 'stream',
        timeout: 10000,
        headers: {
          'User-Agent': 'Mozilla/5.0'
        }
      });

      await new Promise((resolve, reject) => {
        const writer = createWriteStream(segmentPath);
        response.data.pipe(writer);
        writer.on('finish', resolve);
        writer.on('error', reject);
      });

      logger.debug(`Segment downloaded: ${segmentPath}`);

      // 2. FFmpeg ашиглан frame-үүд задлах
      const frames = await this.ffmpegExtractFrames(segmentPath, outputPattern);

      // 3. Temp segment файл устгах
      if (existsSync(segmentPath)) {
        unlinkSync(segmentPath);
      }

      return frames;
      
    } catch (error) {
      logger.error(`Failed to extract frames:`, error);
      
      // Cleanup
      if (existsSync(segmentPath)) {
        try {
          unlinkSync(segmentPath);
        } catch (e) {
          logger.error('Cleanup error:', e);
        }
      }
      
      throw error;
    }
  }

  /**
   * FFmpeg ашиглан frame-үүд задлах
   */
  ffmpegExtractFrames(inputPath, outputPattern) {
    return new Promise((resolve, reject) => {
      const frames = [];
      let frameCount = 0;

      ffmpeg(inputPath)
        .outputOptions([
          '-vf', 'fps=0.5', // 2 секунд тутам 1 frame
          '-q:v', '2',      // JPEG чанар
          '-s', '640x480'   // Хэмжээ багасгах (хурдтай боловсруулах)
        ])
        .output(outputPattern)
        .on('end', () => {
          // Frame файлуудын жагсаалт
          const tempDir = tmpdir();
          const basePattern = outputPattern.substring(0, outputPattern.lastIndexOf('-frame-'));
          const baseName = basePattern.split('/').pop();
          
          for (let i = 1; i <= frameCount; i++) {
            const framePath = join(
              tempDir, 
              `${baseName}-frame-${String(i).padStart(3, '0')}.jpg`
            );
            
            if (existsSync(framePath)) {
              frames.push({
                frameNumber: i,
                imagePath: framePath,
                timestamp: new Date()
              });
            }
          }

          logger.debug(`Extracted ${frames.length} frames`);
          resolve(frames);
        })
        .on('error', (err) => {
          logger.error('FFmpeg error:', err);
          reject(err);
        })
        .on('progress', (progress) => {
          if (progress.frames) {
            frameCount = progress.frames;
          }
        })
        .run();
    });
  }

  /**
   * Frame боловсруулах - Database хадгалах + AI руу илгээх
   */
  async processFrame(frame) {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');

      // 1. Database-д frame хадгалах
      const frameResult = await client.query(`
        INSERT INTO camera_frames (
          camera_id, frame_number, timestamp, image_path, processed
        )
        VALUES ($1, $2, $3, $4, false)
        RETURNING id
      `, [
        this.camera.id,
        frame.frameNumber,
        frame.timestamp,
        frame.imagePath
      ]);

      const frameId = frameResult.rows[0].id;

      // 2. Frame-ийн зургийг base64 болгох
      const imageBuffer = await new Promise((resolve, reject) => {
        const chunks = [];
        const stream = createReadStream(frame.imagePath);
        
        stream.on('data', chunk => chunks.push(chunk));
        stream.on('end', () => resolve(Buffer.concat(chunks)));
        stream.on('error', reject);
      });

      // 3. AI Detection Service руу илгээх (HTTP API)
      const detectionResponse = await axios.post(
        `${process.env.AI_SERVICE_URL || 'http://ai-detection-service:3004'}/detect`,
        {
          cameraId: this.camera.id,
          frameId: frameId,
          timestamp: frame.timestamp.toISOString(),
          image: imageBuffer.toString('base64'),
          metadata: {
            latitude: this.camera.latitude,
            longitude: this.camera.longitude,
            location: this.camera.location
          }
        },
        {
          timeout: 30000,
          headers: {
            'Content-Type': 'application/json'
          }
        }
      );

      const detections = detectionResponse.data.predictions || [];

      // 4. Detections-ийг database-д хадгалах
      for (const detection of detections) {
        // Осол байж болзошгүй эсэхийг шалгах
        const isPotentialAccident = this.checkPotentialAccident(detection);

        await client.query(`
          INSERT INTO camera_detections (
            camera_id, frame_id, detection_time,
            object_class, confidence,
            bbox_x, bbox_y, bbox_width, bbox_height,
            potential_accident
          )
          VALUES ($1, $2, NOW(), $3, $4, $5, $6, $7, $8, $9)
        `, [
          this.camera.id,
          frameId,
          detection.class_name,
          detection.confidence,
          detection.bbox.x,
          detection.bbox.y,
          detection.bbox.width,
          detection.bbox.height,
          isPotentialAccident
        ]);

        // 5. Хэрэв осол байж болзошгүй бол Accident үүсгэх
        if (isPotentialAccident && detection.confidence > 0.85) {
          await this.createAccidentFromDetection(client, frameId, detection);
        }
      }

      // 6. Frame processed гэж тэмдэглэх
      await client.query(`
        UPDATE camera_frames 
        SET processed = true, detection_count = $1
        WHERE id = $2
      `, [detections.length, frameId]);

      await client.query('COMMIT');

      // 7. Temp frame файл устгах
      if (existsSync(frame.imagePath)) {
        unlinkSync(frame.imagePath);
      }

      logger.debug(`Frame ${frameId} processed: ${detections.length} detections`);
      
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error(`Failed to process frame:`, error);
      
      // Cleanup
      if (existsSync(frame.imagePath)) {
        try {
          unlinkSync(frame.imagePath);
        } catch (e) {
          logger.error('Cleanup error:', e);
        }
      }
      
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Ослын шинж тэмдэг шалгах
   */
  checkPotentialAccident(detection) {
    // Өндөр confidence-тэй тээврийн хэрэгсэл + хүн
    const accidentClasses = ['car', 'truck', 'bus', 'person', 'motorcycle'];
    
    if (accidentClasses.includes(detection.class_name.toLowerCase())) {
      // Confidence > 0.7 бол potential accident
      return detection.confidence > 0.7;
    }
    
    return false;
  }

  /**
   * Detection-аас Accident үүсгэх
   */
  async createAccidentFromDetection(client, frameId, detection) {
    try {
      const result = await client.query(`
        INSERT INTO accidents (
          camera_id, latitude, longitude, description,
          severity, status, source, accident_time,
          verification_count
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), 0)
        RETURNING id
      `, [
        this.camera.id,
        this.camera.latitude,
        this.camera.longitude,
        `AI илэрсэн: ${detection.class_name} (${(detection.confidence * 100).toFixed(1)}%)`,
        detection.confidence > 0.9 ? 'moderate' : 'minor',
        'reported',
        'camera'
      ]);

      const accidentId = result.rows[0].id;

      // Detection-д accident_id холбох
      await client.query(`
        UPDATE camera_detections
        SET accident_id = $1
        WHERE frame_id = $2 AND object_class = $3
      `, [accidentId, frameId, detection.class_name]);

      logger.info(`🚨 Accident created from camera detection: ${accidentId}`);
      
      return accidentId;
      
    } catch (error) {
      logger.error('Failed to create accident:', error);
      throw error;
    }
  }

  /**
   * Recording статус шинэчлэх
   */
  async updateRecordingStatus(isRecording) {
    try {
      await pool.query(`
        UPDATE cameras 
        SET is_recording = $1, updated_at = NOW()
        WHERE id = $2
      `, [isRecording, this.camera.id]);
    } catch (error) {
      logger.error('Failed to update recording status:', error);
    }
  }

  /**
   * Алдааны статус хадгалах
   */
  async updateError(errorMessage) {
    try {
      await pool.query(`
        UPDATE cameras 
        SET last_error = $1, updated_at = NOW()
        WHERE id = $2
      `, [errorMessage, this.camera.id]);

      // Log хадгалах
      await pool.query(`
        INSERT INTO camera_logs (camera_id, timestamp, status, error_message)
        VALUES ($1, NOW(), 'error', $2)
      `, [this.camera.id, errorMessage]);
      
    } catch (error) {
      logger.error('Failed to update error:', error);
    }
  }

  /**
   * Helper: Sleep function
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = { HLSStreamProcessor };