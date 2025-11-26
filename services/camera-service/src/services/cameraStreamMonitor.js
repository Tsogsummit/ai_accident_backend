const cron = require('node-cron');
const HLSStreamProcessor = require('./hlsStreamProcessor');
const logger = require('../utils/logger');
const axios = require('axios');
const fs = require('fs');
const FormData = require('form-data');

class CameraStreamMonitor {
  constructor(pool, redis) {
    this.pool = pool;
    this.redis = redis;
    this.processor = new HLSStreamProcessor(redis);
    this.activeCameras = new Map();
    this.processingLocks = new Map();

    this.config = {
      videoDuration: 330, 
      checkInterval: '*/6 * * * *',
      aiServiceUrl: process.env.AI_SERVICE_URL || 'http://ai-detection-service:3004',
      videoServiceUrl: process.env.VIDEO_SERVICE_URL || 'http://video-service:3003',
      accidentServiceUrl: process.env.ACCIDENT_SERVICE_URL || 'http://accident-service:3002',
    };
  }

  async start() {
    logger.info('🎬 Starting Camera Stream Monitor...');

    await this.loadActiveCameras();

    this.scheduleProcessing();

    logger.info(`✅ Monitor started. Checking every 6 minutes.`);
    logger.info(`📹 Monitoring ${this.activeCameras.size} active cameras`);
  }

  async loadActiveCameras() {
    try {
      const result = await this.pool.query(`
        SELECT id, name, stream_url, latitude, longitude
        FROM cameras
        WHERE is_online = true
          AND stream_type = 'hls'
          AND stream_url IS NOT NULL
        ORDER BY id
      `);

      this.activeCameras.clear();
      for (const camera of result.rows) {
        this.activeCameras.set(camera.id, camera);
        logger.info(`📹 Camera ${camera.id}: ${camera.name}`);
      }

      logger.info(`Loaded ${result.rows.length} active HLS cameras`);
    } catch (error) {
      logger.error(`Error loading cameras: ${error.message}`);
    }
  }

  scheduleProcessing() {
    cron.schedule(this.config.checkInterval, async () => {
      logger.info('⏰ Scheduled processing triggered');
      await this.processAllCameras();
    });

    setTimeout(() => this.processAllCameras(), 5000);
  }

  async processAllCameras() {
    await this.loadActiveCameras();

    const promises = [];
    for (const [cameraId, camera] of this.activeCameras) {
      promises.push(this.processCamera(camera));
    }

    const results = await Promise.allSettled(promises);

    const successful = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;

    logger.info(`📊 Processing complete: ${successful} successful, ${failed} failed`);
  }

  async processCamera(camera) {
    const { id, name, stream_url, latitude, longitude } = camera;

    if (this.processingLocks.get(id)) {
      logger.warn(`⏭️ Camera ${id} is already being processed, skipping...`);
      return;
    }

    this.processingLocks.set(id, true);

    try {
      logger.info(`\n🎥 ========================================`);
      logger.info(`🎥 Processing Camera ${id}: ${name}`);
      logger.info(`🎥 Stream: ${stream_url}`);
      logger.info(`🎥 ========================================\n`);

      await this.updateCameraStatus(id, 'processing');

      const videoData = await this.processor.processStream(
        stream_url,
        id,
        this.config.videoDuration
      );

      logger.info(`📹 Video captured: ${videoData.videoPath}`);
      logger.info(`⏱️ Duration: ${videoData.duration}s`);

      const aiResult = await this.sendToAIDetection(id, videoData.videoPath);

      logger.info(`🤖 AI Detection Result:`);
      logger.info(`   - Accident Detected: ${aiResult.hasAccident}`);
      logger.info(`   - Confidence: ${aiResult.confidence}`);

      if (aiResult.hasAccident && aiResult.confidence >= 0.75) {
        logger.info(`🚨 ACCIDENT DETECTED! Creating accident record...`);

        await this.handleAccidentDetected(camera, videoData, aiResult);
      } else {
        logger.info(`✅ No accident detected. Cleaning up...`);

        await this.processor.cleanupDirectory(videoData.directory);
      }

      await this.updateCameraStatus(id, 'active');

      logger.info(`✅ Camera ${id} processing complete\n`);

    } catch (error) {
      logger.error(`❌ Error processing camera ${id}: ${error.message}`);
      logger.error(error.stack);

      await this.updateCameraError(id, error.message);

    } finally {
      this.processingLocks.delete(id);
    }
  }

  async sendToAIDetection(cameraId, videoPath) {
    try {
      logger.info(`🤖 Sending video to AI detection service...`);

      const formData = new FormData();
      formData.append('video', fs.createReadStream(videoPath));
      formData.append('cameraId', cameraId.toString());

      const response = await axios.post(
        `${this.config.aiServiceUrl}/detect/video`,
        formData,
        {
          headers: formData.getHeaders(),
          timeout: 120000, 
          maxContentLength: Infinity,
          maxBodyLength: Infinity
        }
      );

      return response.data;

    } catch (error) {
      logger.error(`AI detection failed: ${error.message}`);

      return {
        hasAccident: false,
        confidence: 0,
        error: error.message
      };
    }
  }

  async handleAccidentDetected(camera, videoData, aiResult) {
    try {
      logger.info(`📤 Uploading video to video service...`);

      const formData = new FormData();
      formData.append('video', fs.createReadStream(videoData.videoPath));
      formData.append('cameraId', camera.id.toString());
      formData.append('duration', Math.floor(videoData.duration).toString());

      const videoUploadResponse = await axios.post(
        `${this.config.videoServiceUrl}/upload`,
        formData,
        {
          headers: formData.getHeaders(),
          timeout: 60000,
          maxContentLength: Infinity,
          maxBodyLength: Infinity
        }
      );

      const videoId = videoUploadResponse.data.videoId || videoUploadResponse.data.id;
      logger.info(`✅ Video uploaded: ID ${videoId}`);

      logger.info(`🚨 Creating accident record...`);

      const accidentData = {
        latitude: camera.latitude,
        longitude: camera.longitude,
        description: `AI-аар илрүүлсэн осол - ${camera.name}`,
        cameraId: camera.id,
        videoId: videoId,
        source: 'camera',
        status: 'confirmed', 
        aiConfidence: aiResult.confidence
      };

      const accidentResponse = await axios.post(
        `${this.config.accidentServiceUrl}/accidents`,
        accidentData,
        { timeout: 10000 }
      );

      const accidentId = accidentResponse.data.data?.id || accidentResponse.data.id;
      logger.info(`✅ Accident created: ID ${accidentId}`);

      logger.info(`📢 Notifying nearby users...`);

      await axios.post(
        `${this.config.accidentServiceUrl}/accidents/${accidentId}/notify`,
        { radiusMeters: 5000 },
        { timeout: 10000 }
      );

      logger.info(`✅ Users notified!`);

      await this.processor.storeVideoMetadata(camera.id, {
        accidentId,
        videoId,
        cameraId: camera.id,
        timestamp: new Date().toISOString(),
        confidence: aiResult.confidence,
        videoPath: videoData.videoPath
      }, 7200); 
      await this.processor.cleanupDirectory(videoData.directory);

      logger.info(`🎉 Accident handling complete!`);

    } catch (error) {
      logger.error(`Failed to handle accident: ${error.message}`);
      logger.error(error.stack);
      throw error;
    }
  }

  async updateCameraStatus(cameraId, status) {
    try {
      await this.pool.query(`
        UPDATE cameras
        SET last_active = NOW(), updated_at = NOW()
        WHERE id = $1
      `, [cameraId]);
    } catch (error) {
      logger.error(`Failed to update camera status: ${error.message}`);
    }
  }

  async updateCameraError(cameraId, errorMessage) {
    try {
      await this.pool.query(`
        UPDATE cameras
        SET last_error = $1, updated_at = NOW()
        WHERE id = $2
      `, [errorMessage, cameraId]);

      await this.pool.query(`
        INSERT INTO camera_logs (camera_id, error_message, timestamp)
        VALUES ($1, $2, NOW())
      `, [cameraId, errorMessage]);

    } catch (error) {
      logger.error(`Failed to update camera error: ${error.message}`);
    }
  }

  stop() {
    logger.info('Stopping Camera Stream Monitor...');
  }
}

module.exports = CameraStreamMonitor;
