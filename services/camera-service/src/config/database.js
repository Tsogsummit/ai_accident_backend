/**
 * Database Configuration
 */

const { Pool } = require('pg');
const logger = require('../utils/logger');

const pool = new Pool({
  host: process.env.DB_HOST || 'postgres',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'accident_db',
  user: process.env.DB_USER || 'accident_user',
  password: process.env.DB_PASSWORD,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

/**
 * Update camera status
 */
async function updateCameraStatus(cameraId, status) {
  try {
    await pool.query(
      'UPDATE cameras SET status = $1, updated_at = NOW() WHERE id = $2',
      [status, cameraId]
    );
  } catch (error) {
    logger.error(`Database error: ${error.message}`);
  }
}

/**
 * Log camera activity
 */
async function logCameraActivity(cameraId, activity, details = {}) {
  try {
    await pool.query(
      `INSERT INTO camera_logs (camera_id, activity, details, created_at) 
       VALUES ($1, $2, $3, NOW())`,
      [cameraId, activity, JSON.stringify(details)]
    );
  } catch (error) {
    logger.error(`Log activity error: ${error.message}`);
  }
}

module.exports = {
  pool,
  updateCameraStatus,
  logCameraActivity
};