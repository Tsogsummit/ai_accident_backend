const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs').promises;
const logger = require('../utils/logger');

if (process.env.FFMPEG_PATH) {
  ffmpeg.setFfmpegPath(process.env.FFMPEG_PATH);
}

async function captureStream(camera, duration = 30) {
  const timestamp = Date.now();
  const outputPath = path.join(
    process.env.TEMP_DIR || '/tmp',
    `camera_${camera.id}_${timestamp}.mp4`
  );

  logger.info(`📹 Бичлэг авч байна: ${camera.name} (${duration}s)`);

  const isHLS = camera.type === 'hls' || camera.streamUrl.includes('.m3u8');
  const isRTSP = camera.type === 'rtsp' || camera.streamUrl.startsWith('rtsp://');

  return new Promise((resolve, reject) => {
    const command = ffmpeg(camera.streamUrl);

    if (isHLS) {
      const inputOptions = [
        '-allowed_extensions', 'ALL',
        '-protocol_whitelist', 'file,http,https,tcp,tls',
        '-timeout', '5000000',     
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_delay_max', '5'
      ];
      
      command.inputOptions(inputOptions);
      logger.debug(`FFmpeg HLS input: ${inputOptions.join(' ')}`);
      
    } else if (isRTSP) {
      const inputOptions = [
        '-rtsp_transport', 'tcp',
        '-timeout', '5000000',        
        '-analyzeduration', '5000000',
        '-probesize', '5000000'
      ];
      
      command.inputOptions(inputOptions);
      logger.debug(`FFmpeg RTSP input: ${inputOptions.join(' ')}`);
      
    } else {
      logger.warn(`Unknown stream type for camera ${camera.id}`);
    }

    command
      .outputOptions([
        '-c:v', 'libx264',           
        '-preset', 'ultrafast',     
        '-crf', '28',               
        '-t', duration.toString(),  
        '-movflags', '+faststart'    
      ])
      .output(outputPath)
      .on('start', (commandLine) => {
        logger.debug(`FFmpeg command: ${commandLine}`);
      })
      .on('progress', (progress) => {
        if (progress.percent) {
          logger.debug(`Recording progress: ${Math.round(progress.percent)}%`);
        }
      })
      .on('end', async () => {
        try {
          const stats = await fs.stat(outputPath);
          const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
          logger.info(`✅ Бичлэг бэлэн: ${camera.name} (${sizeMB} MB)`);
          resolve(outputPath);
        } catch (error) {
          logger.error(`Error checking file: ${error.message}`);
          resolve(outputPath); 
        }
      })
      .on('error', (err, stdout, stderr) => {
        logger.error(`FFmpeg error: ${err.message}`);
        if (stderr) {
          logger.error(`FFmpeg stderr: ${stderr}`);
        }
        reject(err);
      });

    command.run();
  });
}

async function getStreamInfo(streamUrl) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(streamUrl, (err, metadata) => {
      if (err) {
        reject(err);
      } else {
        resolve(metadata);
      }
    });
  });
}

async function cleanupTempFiles(olderThanMinutes = 60) {
  const tempDir = process.env.TEMP_DIR || '/tmp';
  const now = Date.now();
  const cutoffTime = now - (olderThanMinutes * 60 * 1000);

  try {
    const files = await fs.readdir(tempDir);
    let deletedCount = 0;

    for (const file of files) {
      if (file.startsWith('camera_') && file.endsWith('.mp4')) {
        const filePath = path.join(tempDir, file);
        const stats = await fs.stat(filePath);

        if (stats.mtimeMs < cutoffTime) {
          await fs.unlink(filePath);
          deletedCount++;
          logger.debug(`Deleted old temp file: ${file}`);
        }
      }
    }

    if (deletedCount > 0) {
      logger.info(`🧹 Cleaned up ${deletedCount} old temp files`);
    }
  } catch (error) {
    logger.error(`Error cleaning temp files: ${error.message}`);
  }
}


async function testCameraConnection(camera) {
  try {
    logger.debug(`Testing camera: ${camera.name}`);
    const metadata = await getStreamInfo(camera.streamUrl);
    logger.info(`✅ Camera accessible: ${camera.name}`);
    return true;
  } catch (error) {
    logger.error(`❌ Camera not accessible: ${camera.name} - ${error.message}`);
    return false;
  }
}

module.exports = {
  captureStream,
  getStreamInfo,
  cleanupTempFiles,
  testCameraConnection
};