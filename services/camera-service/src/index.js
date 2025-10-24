/**
 * Camera Service - Main Entry
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { startAllCameras, stopAllCameras, getMonitoringStatus } = require('./services/cameraService');
const logger = require('./utils/logger');

const app = express();
const PORT = process.env.PORT || 3008;

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'camera-service',
    timestamp: new Date().toISOString()
  });
});

// Get camera status
app.get('/cameras', (req, res) => {
  const status = getMonitoringStatus();
  res.json({
    cameras: status,
    count: status.length
  });
});

// Start server
app.listen(PORT, () => {
  logger.info(`📹 Camera Service запущен на порту ${PORT}`);
  logger.info(`⏱️  Stream interval: ${process.env.STREAM_INTERVAL || 300}s`);
  logger.info(`🎬 Stream duration: ${process.env.STREAM_DURATION || 30}s`);
  logger.info(`💓 Health check interval: ${process.env.HEALTH_CHECK_INTERVAL || 60}s`);
  
  // Start camera monitoring
  startAllCameras();
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, stopping cameras...');
  stopAllCameras();
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, stopping cameras...');
  stopAllCameras();
  process.exit(0);
});