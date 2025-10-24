/**
 * Upload Service - Google Cloud Storage
 */

const { Storage } = require('@google-cloud/storage');
const { PubSub } = require('@google-cloud/pubsub');
const path = require('path');
const fs = require('fs').promises;
const logger = require('../utils/logger');

// Initialize GCS
const storage = new Storage({
  keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS
});

const bucket = storage.bucket(process.env.GCS_BUCKET_NAME);

// Initialize Pub/Sub
const pubsub = new PubSub({
  keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS
});

const topic = pubsub.topic(process.env.PUBSUB_TOPIC);

/**
 * Upload video to Google Cloud Storage
 * @param {string} filePath - Local file path
 * @param {Object} camera - Camera info
 * @returns {Promise<Object>}
 */
async function uploadVideo(filePath, camera) {
  const fileName = path.basename(filePath);
  const destination = `videos/camera_${camera.id}/${fileName}`;

  logger.info(`☁️  Uploading to GCS: ${destination}`);

  try {
    await bucket.upload(filePath, {
      destination,
      metadata: {
        contentType: 'video/mp4',
        metadata: {
          cameraId: camera.id.toString(),
          cameraName: camera.name,
          location: camera.location,
          uploadedAt: new Date().toISOString()
        }
      }
    });

    const publicUrl = `gs://${process.env.GCS_BUCKET_NAME}/${destination}`;
    logger.info(`✅ Upload complete: ${publicUrl}`);

    return {
      success: true,
      url: publicUrl,
      destination,
      fileName
    };
  } catch (error) {
    logger.error(`Upload error: ${error.message}`);
    throw error;
  }
}

/**
 * Publish message to Pub/Sub
 * @param {Object} data - Message data
 */
async function publishMessage(data) {
  try {
    const messageId = await topic.publishMessage({
      json: data
    });

    logger.info(`📨 Pub/Sub message published: ${messageId}`);
    return messageId;
  } catch (error) {
    logger.error(`Pub/Sub publish error: ${error.message}`);
    throw error;
  }
}

/**
 * Process and upload video
 * @param {string} filePath - Local file path
 * @param {Object} camera - Camera info
 */
async function processVideo(filePath, camera) {
  try {
    // Upload to GCS
    const uploadResult = await uploadVideo(filePath, camera);

    // Publish to Pub/Sub for AI processing
    await publishMessage({
      videoUrl: uploadResult.url,
      cameraId: camera.id,
      cameraName: camera.name,
      location: camera.location,
      coordinates: camera.coordinates,
      timestamp: new Date().toISOString(),
      fileName: uploadResult.fileName
    });

    // Delete local file
    await fs.unlink(filePath);
    logger.debug(`🗑️  Local file deleted: ${filePath}`);

    return uploadResult;
  } catch (error) {
    logger.error(`Process video error: ${error.message}`);
    throw error;
  }
}

module.exports = {
  uploadVideo,
  publishMessage,
  processVideo
};