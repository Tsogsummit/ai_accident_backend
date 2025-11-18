
const axios = require('axios');
const { Parser } = require('m3u8-parser');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

class HLSStreamProcessor {
  constructor(redis) {
    this.redis = redis;
    this.tempDir = path.join(__dirname, '../../temp');
    this.ensureTempDir();
  }

  ensureTempDir() {
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
      logger.info(`Created temp directory: ${this.tempDir}`);
    }
  }

  /**
   * Parse HLS master playlist and get chunklist URL
   * @param {string} playlistUrl - Master playlist URL
   * @returns {Promise<string>} Chunklist URL
   */
  async getMasterPlaylist(playlistUrl) {
    try {
      logger.info(`Fetching master playlist: ${playlistUrl}`);
      const response = await axios.get(playlistUrl, { timeout: 10000 });
      const parser = new Parser();
      parser.push(response.data);
      parser.end();

      const manifest = parser.manifest;

      
      if (manifest.playlists && manifest.playlists.length > 0) {
        const chunklistUri = manifest.playlists[0].uri;
        const baseUrl = playlistUrl.substring(0, playlistUrl.lastIndexOf('/'));
        const chunklistUrl = chunklistUri.startsWith('http')
          ? chunklistUri
          : `${baseUrl}/${chunklistUri}`;

        logger.info(`Found chunklist: ${chunklistUrl}`);
        return chunklistUrl;
      }

      
      return playlistUrl;
    } catch (error) {
      logger.error(`Error fetching master playlist: ${error.message}`);
      throw error;
    }
  }

  /**
   * Parse chunklist and get media segment URLs
   * @param {string} chunklistUrl - Chunklist URL
   * @param {number} count - Number of segments to fetch
   * @returns {Promise<Array<string>>} Media segment URLs
   */
  async getMediaSegments(chunklistUrl, count = 33) {
    try {
      logger.info(`Fetching chunklist: ${chunklistUrl}`);
      const response = await axios.get(chunklistUrl, { timeout: 10000 });
      const parser = new Parser();
      parser.push(response.data);
      parser.end();

      const manifest = parser.manifest;
      const baseUrl = chunklistUrl.substring(0, chunklistUrl.lastIndexOf('/'));

      if (!manifest.segments || manifest.segments.length === 0) {
        throw new Error('No segments found in chunklist');
      }

      
      const segments = manifest.segments.slice(-count);
      const segmentUrls = segments.map(segment => {
        const uri = segment.uri;
        return uri.startsWith('http') ? uri : `${baseUrl}/${uri}`;
      });

      logger.info(`Found ${segmentUrls.length} segments (requested: ${count})`);
      return segmentUrls;
    } catch (error) {
      logger.error(`Error fetching chunklist: ${error.message}`);
      throw error;
    }
  }

  /**
   * Download media segments to temp directory
   * @param {Array<string>} segmentUrls - Array of segment URLs
   * @param {string} cameraId - Camera ID for naming
   * @returns {Promise<Array<string>>} Local file paths
   */
  async downloadSegments(segmentUrls, cameraId) {
    const timestamp = Date.now();
    const cameraDir = path.join(this.tempDir, `camera_${cameraId}_${timestamp}`);

    if (!fs.existsSync(cameraDir)) {
      fs.mkdirSync(cameraDir, { recursive: true });
    }

    const localPaths = [];

    for (let i = 0; i < segmentUrls.length; i++) {
      const segmentUrl = segmentUrls[i];
      const filename = `segment_${i.toString().padStart(5, '0')}.ts`;
      const localPath = path.join(cameraDir, filename);

      try {
        logger.debug(`Downloading segment ${i + 1}/${segmentUrls.length}: ${segmentUrl}`);
        const response = await axios.get(segmentUrl, {
          responseType: 'arraybuffer',
          timeout: 15000
        });

        fs.writeFileSync(localPath, response.data);
        localPaths.push(localPath);
      } catch (error) {
        logger.error(`Failed to download segment ${i}: ${error.message}`);
        
      }
    }

    logger.info(`Downloaded ${localPaths.length}/${segmentUrls.length} segments to ${cameraDir}`);
    return { directory: cameraDir, segments: localPaths };
  }

  /**
   * Concatenate TS segments into a single MP4 video
   * @param {Array<string>} segmentPaths - Array of segment file paths
   * @param {string} outputPath - Output MP4 file path
   * @returns {Promise<string>} Output file path
   */
  async concatenateSegments(segmentPaths, outputPath) {
    return new Promise((resolve, reject) => {
      if (segmentPaths.length === 0) {
        return reject(new Error('No segments to concatenate'));
      }

      logger.info(`Concatenating ${segmentPaths.length} segments into ${outputPath}`);

      
      const concatFile = outputPath.replace('.mp4', '_concat.txt');
      const concatContent = segmentPaths
        .map(p => `file '${p.replace(/\\/g, '/')}'`)
        .join('\n');
      fs.writeFileSync(concatFile, concatContent);

      ffmpeg()
        .input(concatFile)
        .inputOptions(['-f concat', '-safe 0'])
        .outputOptions([
          '-c copy',  
          '-bsf:a aac_adtstoasc'  
        ])
        .output(outputPath)
        .on('start', (commandLine) => {
          logger.debug(`FFmpeg command: ${commandLine}`);
        })
        .on('progress', (progress) => {
          logger.debug(`Processing: ${progress.percent}% done`);
        })
        .on('end', () => {
          logger.info(`✅ Video created: ${outputPath}`);
          
          fs.unlinkSync(concatFile);
          resolve(outputPath);
        })
        .on('error', (err) => {
          logger.error(`❌ FFmpeg error: ${err.message}`);
          reject(err);
        })
        .run();
    });
  }

  /**
   * Get video duration in seconds
   * @param {string} videoPath - Path to video file
   * @returns {Promise<number>} Duration in seconds
   */
  async getVideoDuration(videoPath) {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(videoPath, (err, metadata) => {
        if (err) return reject(err);
        const duration = metadata.format.duration;
        logger.info(`Video duration: ${duration} seconds`);
        resolve(duration);
      });
    });
  }

  /**
   * Process HLS stream: download 5min30sec of video
   * @param {string} playlistUrl - HLS playlist URL
   * @param {string} cameraId - Camera ID
   * @param {number} durationSeconds - Desired duration (default 330 = 5m30s)
   * @returns {Promise<Object>} { videoPath, duration, segmentCount }
   */
  async processStream(playlistUrl, cameraId, durationSeconds = 330) {
    try {
      logger.info(`📹 Processing HLS stream for camera ${cameraId}`);
      logger.info(`Target duration: ${durationSeconds} seconds (${Math.floor(durationSeconds / 60)}m ${durationSeconds % 60}s)`);

      
      const chunklistUrl = await this.getMasterPlaylist(playlistUrl);

      
      
      const segmentDuration = 10;
      const segmentCount = Math.ceil(durationSeconds / segmentDuration);

      logger.info(`Fetching ${segmentCount} segments (${segmentDuration}s each)`);

      
      const segmentUrls = await this.getMediaSegments(chunklistUrl, segmentCount);

      
      const { directory, segments } = await this.downloadSegments(segmentUrls, cameraId);

      if (segments.length === 0) {
        throw new Error('No segments were downloaded');
      }

      
      const timestamp = Date.now();
      const outputPath = path.join(directory, `camera_${cameraId}_${timestamp}.mp4`);
      await this.concatenateSegments(segments, outputPath);

      
      const actualDuration = await this.getVideoDuration(outputPath);

      
      logger.info('Cleaning up segment files...');
      for (const segmentPath of segments) {
        try {
          fs.unlinkSync(segmentPath);
        } catch (err) {
          logger.warn(`Failed to delete segment: ${segmentPath}`);
        }
      }

      logger.info(`✅ Stream processing complete: ${outputPath}`);

      return {
        videoPath: outputPath,
        duration: actualDuration,
        segmentCount: segments.length,
        directory: directory
      };

    } catch (error) {
      logger.error(`❌ Stream processing failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Clean up temp directory for camera
   * @param {string} directory - Directory to clean up
   */
  async cleanupDirectory(directory) {
    try {
      if (fs.existsSync(directory)) {
        fs.rmSync(directory, { recursive: true, force: true });
        logger.info(`Cleaned up directory: ${directory}`);
      }
    } catch (error) {
      logger.error(`Failed to cleanup directory ${directory}: ${error.message}`);
    }
  }

  /**
   * Store video metadata in Redis (temporary storage)
   * @param {string} cameraId - Camera ID
   * @param {Object} videoData - Video metadata
   * @param {number} ttl - Time to live in seconds (default 1 hour)
   */
  async storeVideoMetadata(cameraId, videoData, ttl = 3600) {
    const key = `camera:${cameraId}:video:${Date.now()}`;
    await this.redis.setex(key, ttl, JSON.stringify(videoData));
    logger.info(`Stored video metadata in Redis: ${key} (TTL: ${ttl}s)`);
    return key;
  }

  /**
   * Get video metadata from Redis
   * @param {string} key - Redis key
   * @returns {Promise<Object|null>}
   */
  async getVideoMetadata(key) {
    const data = await this.redis.get(key);
    return data ? JSON.parse(data) : null;
  }
}

module.exports = HLSStreamProcessor;
