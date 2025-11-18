/**
 * Camera Service - Main Logic
 * HLS + RTSP Camera Monitoring
 */

const { pool } = require('../config/database');
const { captureStream, cleanupTempFiles } = require('./streamService');
const { processVideo } = require('./uploadService');
const { HLSStreamProcessor } = require('./hlsProcessor');
const logger = require('../utils/logger');

let monitoringIntervals = new Map();
let hlsProcessors = new Map(); 

/**
 * Get active cameras from database
 */
async function getActiveCamerasFromDB() {
  try {
    const result = await pool.query(`
      SELECT * FROM cameras 
      WHERE status = 'active' 
      ORDER BY id
    `);
    return result.rows;
  } catch (error) {
    logger.error('Failed to get active cameras:', error);
    return [];
  }
}

/**
 * Start monitoring a camera
 * @param {Object} camera
 */
async function startCameraMonitoring(camera) {
  try {
    
    const isHLS = camera.stream_type === 'hls' || 
                  camera.stream_url?.includes('.m3u8');
    
    if (isHLS) {
      
      await startHLSMonitoring(camera);
    } else {
      
      await startRTSPMonitoring(camera);
    }

    logger.info(`▶️  Camera monitoring эхэллээ: ${camera.name} (ID: ${camera.id}, Type: ${isHLS ? 'HLS' : 'RTSP'})`);
    
  } catch (error) {
    logger.error(`Failed to start camera ${camera.id}:`, error);
    await updateCameraStatus(camera.id, 'error');
  }
}

/**
 * Start HLS stream monitoring (continuous)
 */
async function startHLSMonitoring(camera) {
  
  if (hlsProcessors.has(camera.id)) {
    logger.warn(`HLS processor already running for camera ${camera.id}`);
    return;
  }

  
  const processor = new HLSStreamProcessor(camera);
  hlsProcessors.set(camera.id, processor);

  
  await processor.start();
}

/**
 * Start RTSP stream monitoring (periodic)
 */
async function startRTSPMonitoring(camera) {
  const interval = parseInt(process.env.STREAM_INTERVAL) * 1000 || 300000; 
  const duration = parseInt(process.env.STREAM_DURATION) || 30; 

  logger.info(`▶️  RTSP monitoring: ${camera.name} (ID: ${camera.id})`);

  
  captureAndUpload(camera, duration);

  
  const intervalId = setInterval(() => {
    captureAndUpload(camera, duration);
  }, interval);

  monitoringIntervals.set(camera.id, intervalId);
}

/**
 * Stop monitoring a camera
 * @param {number} cameraId
 */
async function stopCameraMonitoring(cameraId) {
  try {
    
    const hlsProcessor = hlsProcessors.get(cameraId);
    if (hlsProcessor) {
      await hlsProcessor.stop();
      hlsProcessors.delete(cameraId);
    }

    
    const intervalId = monitoringIntervals.get(cameraId);
    if (intervalId) {
      clearInterval(intervalId);
      monitoringIntervals.delete(cameraId);
    }

    
    await pool.query(`
      UPDATE cameras 
      SET is_recording = false, updated_at = NOW()
      WHERE id = $1
    `, [cameraId]);

    logger.info(`⏸️  Camera monitoring зогслоо: ID ${cameraId}`);
    
  } catch (error) {
    logger.error(`Failed to stop camera ${cameraId}:`, error);
  }
}

/**
 * Capture and upload video (RTSP)
 * @param {Object} camera
 * @param {number} duration
 */
async function captureAndUpload(camera, duration) {
  try {
    logger.info(`📹 Capturing from camera: ${camera.name}`);

    
    await pool.query(`
      UPDATE cameras 
      SET is_recording = true, updated_at = NOW()
      WHERE id = $1
    `, [camera.id]);

    
    const videoPath = await captureStream(camera, duration);

    
    await processVideo(videoPath, camera);

    
    await pool.query(`
      UPDATE cameras 
      SET is_recording = false, status = 'active', updated_at = NOW()
      WHERE id = $1
    `, [camera.id]);

  } catch (error) {
    logger.error(`Camera ${camera.id} capture error:`, error);
    
    
    await pool.query(`
      UPDATE cameras 
      SET is_recording = false, status = 'error', 
          last_error = $1, updated_at = NOW()
      WHERE id = $2
    `, [error.message, camera.id]);
  }
}

/**
 * Start all active cameras
 */
async function startAllCameras() {
  try {
    const cameras = await getActiveCamerasFromDB();
    
    logger.info(`📡 ${cameras.length} идэвхтэй камер байна`);

    for (const camera of cameras) {
      await startCameraMonitoring(camera);
      
      
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    
    setInterval(() => {
      cleanupTempFiles(60);
    }, 3600000);

    logger.info('✅ All cameras started successfully');
    
  } catch (error) {
    logger.error('Failed to start all cameras:', error);
  }
}

/**
 * Stop all cameras
 */
async function stopAllCameras() {
  try {
    
    for (const [cameraId, processor] of hlsProcessors) {
      await processor.stop();
    }
    hlsProcessors.clear();

    
    for (const [cameraId, intervalId] of monitoringIntervals) {
      clearInterval(intervalId);
    }
    monitoringIntervals.clear();
    
    
    await pool.query(`
      UPDATE cameras 
      SET is_recording = false, updated_at = NOW()
      WHERE is_recording = true
    `);

    logger.info('⏹️  All cameras stopped');
    
  } catch (error) {
    logger.error('Failed to stop all cameras:', error);
  }
}

/**
 * Get monitoring status
 */
async function getMonitoringStatus() {
  try {
    const result = await pool.query(`
      SELECT 
        c.*,
        cls.total_frames,
        cls.total_detections,
        cls.potential_accidents,
        cls.last_detection_time
      FROM cameras c
      LEFT JOIN camera_live_stats cls ON c.id = cls.id
      ORDER BY c.id
    `);

    return result.rows.map(camera => ({
      id: camera.id,
      name: camera.name,
      location: camera.location,
      type: camera.stream_type,
      isOnline: camera.is_online,
      isRecording: camera.is_recording,
      status: camera.status,
      lastFrameTime: camera.last_frame_time,
      framesCaptured: camera.frames_captured,
      totalFrames: camera.total_frames || 0,
      totalDetections: camera.total_detections || 0,
      potentialAccidents: camera.potential_accidents || 0,
      lastDetectionTime: camera.last_detection_time,
      lastError: camera.last_error,
      activeProcessor: hlsProcessors.has(camera.id) || monitoringIntervals.has(camera.id)
    }));
    
  } catch (error) {
    logger.error('Failed to get monitoring status:', error);
    return [];
  }
}

/**
 * Restart camera monitoring
 */
async function restartCamera(cameraId) {
  try {
    await stopCameraMonitoring(cameraId);
    
    
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    const result = await pool.query(`
      SELECT * FROM cameras WHERE id = $1
    `, [cameraId]);

    if (result.rows.length > 0) {
      await startCameraMonitoring(result.rows[0]);
      logger.info(`🔄 Camera ${cameraId} restarted`);
      return true;
    }
    
    return false;
    
  } catch (error) {
    logger.error(`Failed to restart camera ${cameraId}:`, error);
    return false;
  }
}

module.exports = {
  startCameraMonitoring,
  stopCameraMonitoring,
  startAllCameras,
  stopAllCameras,
  getMonitoringStatus,
  restartCamera
};