// services/cameraStreamMonitor.js - Monitor and process camera streams periodically
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

    // Configuration
    this.config = {
      videoDuration: 330, // 5 minutes 30 seconds
      checkInterval: '*/6 * * * *', // Every 6 minutes (allows 30s buffer)
      aiServiceUrl: process.env.AI_SERVICE_URL || 'http://ai-detection-service:3004',
      videoServiceUrl: process.env.VIDEO_SERVICE_URL || 'http://video-service:3003',
      accidentServiceUrl: process.env.ACCIDENT_SERVICE_URL || 'http://accident-service:3002',
    };
  }

  /**
   * Start monitoring all active cameras
   */
  async start() {
    logger.info('🎬 Starting Camera Stream Monitor...');

    // Load active cameras from database
    await this.loadActiveCameras();

    // Schedule periodic processing
    this.scheduleProcessing();

    logger.info(`✅ Monitor started. Checking every 6 minutes.`);
    logger.info(`📹 Monitoring ${this.activeCameras.size} active cameras`);
  }

  /**
   * Load active HLS cameras from database
   */
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

  /**
   * Schedule periodic camera processing
   */
  scheduleProcessing() {
    // Run every 6 minutes
    cron.schedule(this.config.checkInterval, async () => {
      logger.info('⏰ Scheduled processing triggered');
      await this.processAllCameras();
    });

    // Also run immediately on start (optional)
    setTimeout(() => this.processAllCameras(), 5000);
  }

  /**
   * Process all active cameras
   */
  async processAllCameras() {
    // Reload cameras in case of updates
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

  /**
   * Process a single camera
   * @param {Object} camera - Camera object from database
   */
  async processCamera(camera) {
    const { id, name, stream_url, latitude, longitude } = camera;

    // Check if already processing (prevent overlapping)
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

      // Update camera last_active timestamp
      await this.updateCameraStatus(id, 'processing');

      // Step 1: Capture 5m30s video from HLS stream
      const videoData = await this.processor.processStream(
        stream_url,
        id,
        this.config.videoDuration
      );

      logger.info(`📹 Video captured: ${videoData.videoPath}`);
      logger.info(`⏱️ Duration: ${videoData.duration}s`);

      // Step 2: Send video to AI detection service
      const aiResult = await this.sendToAIDetection(id, videoData.videoPath);

      logger.info(`🤖 AI Detection Result:`);
      logger.info(`   - Accident Detected: ${aiResult.hasAccident}`);
      logger.info(`   - Confidence: ${aiResult.confidence}`);

      // Step 3: If accident detected, create accident record and save video
      if (aiResult.hasAccident && aiResult.confidence >= 0.75) {
        logger.info(`🚨 ACCIDENT DETECTED! Creating accident record...`);

        await this.handleAccidentDetected(camera, videoData, aiResult);
      } else {
        logger.info(`✅ No accident detected. Cleaning up...`);

        // Clean up video file and directory
        await this.processor.cleanupDirectory(videoData.directory);
      }

      // Update camera status
      await this.updateCameraStatus(id, 'active');

      logger.info(`✅ Camera ${id} processing complete\n`);

    } catch (error) {
      logger.error(`❌ Error processing camera ${id}: ${error.message}`);
      logger.error(error.stack);

      // Update camera with error
      await this.updateCameraError(id, error.message);

    } finally {
      this.processingLocks.delete(id);
    }
  }

  /**
   * Send video to AI detection service
   * @param {number} cameraId - Camera ID
   * @param {string} videoPath - Path to video file
   * @returns {Promise<Object>} AI detection result
   */
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
          timeout: 120000, // 2 minutes timeout for AI processing
          maxContentLength: Infinity,
          maxBodyLength: Infinity
        }
      );

      return response.data;

    } catch (error) {
      logger.error(`AI detection failed: ${error.message}`);

      // Return default "no accident" if AI fails
      return {
        hasAccident: false,
        confidence: 0,
        error: error.message
      };
    }
  }

  /**
   * Handle accident detection: save video and create accident record
   * @param {Object} camera - Camera object
   * @param {Object} videoData - Video data from processor
   * @param {Object} aiResult - AI detection result
   */
  async handleAccidentDetected(camera, videoData, aiResult) {
    try {
      // Step 1: Upload video to video service
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

      // Step 2: Create accident record
      logger.info(`🚨 Creating accident record...`);

      const accidentData = {
        latitude: camera.latitude,
        longitude: camera.longitude,
        description: `AI-аар илрүүлсэн осол - ${camera.name}`,
        cameraId: camera.id,
        videoId: videoId,
        source: 'camera',
        status: 'confirmed', // AI-detected accidents are auto-confirmed
        aiConfidence: aiResult.confidence
      };

      const accidentResponse = await axios.post(
        `${this.config.accidentServiceUrl}/accidents`,
        accidentData,
        { timeout: 10000 }
      );

      const accidentId = accidentResponse.data.data?.id || accidentResponse.data.id;
      logger.info(`✅ Accident created: ID ${accidentId}`);

      // Step 3: Notify nearby users
      logger.info(`📢 Notifying nearby users...`);

      await axios.post(
        `${this.config.accidentServiceUrl}/accidents/${accidentId}/notify`,
        { radiusMeters: 5000 },
        { timeout: 10000 }
      );

      logger.info(`✅ Users notified!`);

      // Step 4: Store metadata in Redis (temporary)
      await this.processor.storeVideoMetadata(camera.id, {
        accidentId,
        videoId,
        cameraId: camera.id,
        timestamp: new Date().toISOString(),
        confidence: aiResult.confidence,
        videoPath: videoData.videoPath
      }, 7200); // 2 hours TTL

      // Step 5: Clean up local video file
      await this.processor.cleanupDirectory(videoData.directory);

      logger.info(`🎉 Accident handling complete!`);

    } catch (error) {
      logger.error(`Failed to handle accident: ${error.message}`);
      logger.error(error.stack);
      throw error;
    }
  }

  /**
   * Update camera status
   * @param {number} cameraId - Camera ID
   * @param {string} status - New status
   */
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

  /**
   * Update camera with error message
   * @param {number} cameraId - Camera ID
   * @param {string} errorMessage - Error message
   */
  async updateCameraError(cameraId, errorMessage) {
    try {
      await this.pool.query(`
        UPDATE cameras
        SET last_error = $1, updated_at = NOW()
        WHERE id = $2
      `, [errorMessage, cameraId]);

      // Log to camera_logs table
      await this.pool.query(`
        INSERT INTO camera_logs (camera_id, error_message, timestamp)
        VALUES ($1, $2, NOW())
      `, [cameraId, errorMessage]);

    } catch (error) {
      logger.error(`Failed to update camera error: ${error.message}`);
    }
  }

  /**
   * Stop monitoring
   */
  stop() {
    logger.info('Stopping Camera Stream Monitor...');
    // Cron jobs will be stopped automatically
  }
}

module.exports = CameraStreamMonitor;
