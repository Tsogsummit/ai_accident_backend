/**
 * Camera Service - Main Logic
 */

const { getActiveCameras, getCameraById } = require('../config/cameras');
const { captureStream, cleanupTempFiles } = require('./streamService');
const { processVideo } = require('./uploadService');
const { updateCameraStatus } = require('../config/database');
const logger = require('../utils/logger');

let monitoringIntervals = new Map();

/**
 * Start monitoring a camera
 * @param {Object} camera
 */
function startCameraMonitoring(camera) {
  const interval = parseInt(process.env.STREAM_INTERVAL) * 1000 || 300000; // Default 5 min
  const duration = parseInt(process.env.STREAM_DURATION) || 30; // Default 30 sec

  logger.info(`▶️  Камер monitoring эхэллээ: ${camera.name} (ID: ${camera.id})`);

  // Initial capture
  captureAndUpload(camera, duration);

  // Set interval for continuous monitoring
  const intervalId = setInterval(() => {
    captureAndUpload(camera, duration);
  }, interval);

  monitoringIntervals.set(camera.id, intervalId);
}

/**
 * Stop monitoring a camera
 * @param {number} cameraId
 */
function stopCameraMonitoring(cameraId) {
  const intervalId = monitoringIntervals.get(cameraId);
  
  if (intervalId) {
    clearInterval(intervalId);
    monitoringIntervals.delete(cameraId);
    logger.info(`⏸️  Камер monitoring зогслоо: ID ${cameraId}`);
  }
}

/**
 * Capture and upload video
 * @param {Object} camera
 * @param {number} duration
 */
async function captureAndUpload(camera, duration) {
  try {
    // Update status to recording
    await updateCameraStatus(camera.id, 'recording');

    // Capture stream
    const videoPath = await captureStream(camera, duration);

    // Process and upload
    await processVideo(videoPath, camera);

    // Update status to active
    await updateCameraStatus(camera.id, 'active');

  } catch (error) {
    logger.error(`Camera ${camera.id} error: ${error.message}`);
    
    // Update status to error
    await updateCameraStatus(camera.id, 'error');
  }
}

/**
 * Start all active cameras
 */
function startAllCameras() {
  const cameras = getActiveCameras();
  
  logger.info(`📡 ${cameras.length} идэвхтэй камер байна`);

  cameras.forEach(camera => {
    startCameraMonitoring(camera);
  });

  // Cleanup task every hour
  setInterval(() => {
    cleanupTempFiles(60);
  }, 3600000);
}

/**
 * Stop all cameras
 */
function stopAllCameras() {
  monitoringIntervals.forEach((intervalId, cameraId) => {
    stopCameraMonitoring(cameraId);
  });
  
  logger.info('⏹️  All cameras stopped');
}

/**
 * Get monitoring status
 */
function getMonitoringStatus() {
  const cameras = getActiveCameras();
  
  return cameras.map(camera => ({
    id: camera.id,
    name: camera.name,
    active: monitoringIntervals.has(camera.id),
    type: camera.type,
    location: camera.location
  }));
}

module.exports = {
  startCameraMonitoring,
  stopCameraMonitoring,
  startAllCameras,
  stopAllCameras,
  getMonitoringStatus
};