// shared/database/index.js
// PostgreSQL холболт ба нийтлэг queries

const { Pool } = require('pg');
const config = require('../config');
const { logError, logInfo } = require('../utils');

// Connection pool
let pool = null;

/**
 * Database холболт үүсгэх
 */
function createPool() {
  if (pool) {
    return pool;
  }

  pool = new Pool({
    host: config.database.host,
    port: config.database.port,
    database: config.database.name,
    user: config.database.user,
    password: config.database.password,
    max: config.database.maxConnections,
    idleTimeoutMillis: config.database.idleTimeout,
    connectionTimeoutMillis: config.database.connectionTimeout,
  });

  // Connection error handler
  pool.on('error', (err) => {
    logError(err, { context: 'PostgreSQL pool error' });
  });

  // Connection handler
  pool.on('connect', () => {
    logInfo('PostgreSQL холболт үүслээ');
  });

  return pool;
}

/**
 * Database pool авах
 */
function getPool() {
  if (!pool) {
    return createPool();
  }
  return pool;
}

/**
 * Database холболт хаах
 */
async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
    logInfo('PostgreSQL холболт хаагдлаа');
  }
}

/**
 * Transaction helper
 */
async function withTransaction(callback) {
  const client = await getPool().connect();
  
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Нийтлэг queries
 */
const queries = {
  // Users
  users: {
    findById: 'SELECT * FROM users WHERE id = $1',
    findByPhone: 'SELECT * FROM users WHERE phone = $1',
    findByEmail: 'SELECT * FROM users WHERE email = $1',
    create: `
      INSERT INTO users (phone, email, name, password_hash, role, status)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, phone, email, name, role, status, created_at
    `,
    update: `
      UPDATE users 
      SET name = COALESCE($1, name),
          email = COALESCE($2, email),
          updated_at = NOW()
      WHERE id = $3
      RETURNING *
    `,
    delete: 'DELETE FROM users WHERE id = $1',
  },

  // Accidents
  accidents: {
    findAll: `
      SELECT a.*, u.name as reported_by_name, c.name as camera_name
      FROM accidents a
      LEFT JOIN users u ON a.user_id = u.id
      LEFT JOIN cameras c ON a.camera_id = c.id
      ORDER BY a.timestamp DESC
      LIMIT $1 OFFSET $2
    `,
    findById: `
      SELECT a.*, 
             u.name as reported_by_name,
             u.phone as reported_by_phone,
             v.file_path as video_path,
             aid.confidence as ai_confidence,
             c.name as camera_name
      FROM accidents a
      LEFT JOIN users u ON a.user_id = u.id
      LEFT JOIN videos v ON a.video_id = v.id
      LEFT JOIN ai_detections aid ON v.id = aid.video_id
      LEFT JOIN cameras c ON a.camera_id = c.id
      WHERE a.id = $1
    `,
    findNearby: `
      SELECT id, latitude, longitude, severity, status, description, timestamp,
             calculate_distance($1, $2, latitude, longitude) as distance
      FROM accidents
      WHERE status NOT IN ('resolved', 'false_alarm')
        AND calculate_distance($1, $2, latitude, longitude) <= $3
      ORDER BY distance ASC
      LIMIT $4
    `,
    create: `
      INSERT INTO accidents (
        user_id, camera_id, latitude, longitude, 
        description, severity, status, source, 
        video_id, timestamp
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
      RETURNING *
    `,
    updateStatus: `
      UPDATE accidents 
      SET status = $1, updated_at = NOW()
      WHERE id = $2
      RETURNING *
    `,
    delete: 'DELETE FROM accidents WHERE id = $1',
    countByStatus: `
      SELECT status, COUNT(*) as count
      FROM accidents
      GROUP BY status
    `,
  },

  // Videos
  videos: {
    findById: 'SELECT * FROM videos WHERE id = $1',
    findByUserId: `
      SELECT * FROM videos 
      WHERE user_id = $1 
      ORDER BY uploaded_at DESC
      LIMIT $2 OFFSET $3
    `,
    create: `
      INSERT INTO videos (
        user_id, camera_id, file_name, file_path, 
        file_size, duration, mime_type, status
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `,
    updateStatus: `
      UPDATE videos 
      SET status = $1, 
          error_message = $2,
          processing_completed_at = CASE WHEN $1 = 'completed' THEN NOW() ELSE processing_completed_at END
      WHERE id = $3
      RETURNING *
    `,
    delete: 'DELETE FROM videos WHERE id = $1',
  },

  // AI Detections
  aiDetections: {
    findByVideoId: 'SELECT * FROM ai_detections WHERE video_id = $1',
    create: `
      INSERT INTO ai_detections (
        video_id, confidence, detected_objects, status
      )
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `,
    updateStatus: `
      UPDATE ai_detections 
      SET status = $1, processed_at = NOW()
      WHERE id = $2
      RETURNING *
    `,
  },

  // Cameras
  cameras: {
    findAll: 'SELECT * FROM cameras ORDER BY created_at DESC',
    findById: 'SELECT * FROM cameras WHERE id = $1',
    findActive: "SELECT * FROM cameras WHERE status = 'active'",
    create: `
      INSERT INTO cameras (
        name, location, latitude, longitude, 
        ip_address, stream_url, status
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `,
    updateStatus: `
      UPDATE cameras 
      SET is_online = $1, last_active = NOW()
      WHERE id = $2
      RETURNING *
    `,
    delete: 'DELETE FROM cameras WHERE id = $1',
  },

  // Notifications
  notifications: {
    findByUserId: `
      SELECT * FROM notifications 
      WHERE user_id = $1 
      ORDER BY sent_at DESC
      LIMIT $2 OFFSET $3
    `,
    findUnread: `
      SELECT * FROM notifications 
      WHERE user_id = $1 AND is_read = false
      ORDER BY sent_at DESC
    `,
    create: `
      INSERT INTO notifications (
        user_id, accident_id, type, title, message
      )
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `,
    markAsRead: `
      UPDATE notifications 
      SET is_read = true 
      WHERE id = $1
      RETURNING *
    `,
    markAllAsRead: `
      UPDATE notifications 
      SET is_read = true 
      WHERE user_id = $1
    `,
    delete: 'DELETE FROM notifications WHERE id = $1',
  },

  // False Reports
  falseReports: {
    findByAccidentId: `
      SELECT fr.*, u.name as reporter_name, rr.name as reason_name
      FROM false_reports fr
      LEFT JOIN users u ON fr.user_id = u.id
      LEFT JOIN report_reasons rr ON fr.reason_id = rr.id
      WHERE fr.accident_id = $1
      ORDER BY fr.reported_at DESC
    `,
    create: `
      INSERT INTO false_reports (
        accident_id, user_id, reason_id, comment
      )
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `,
    count: `
      SELECT COUNT(*) as count 
      FROM false_reports 
      WHERE accident_id = $1
    `,
  },

  // Statistics
  statistics: {
    accidentsByDate: `
      SELECT DATE(timestamp) as date, COUNT(*) as count
      FROM accidents
      WHERE timestamp >= NOW() - INTERVAL '30 days'
      GROUP BY DATE(timestamp)
      ORDER BY date DESC
    `,
    accidentsBySeverity: `
      SELECT severity, COUNT(*) as count
      FROM accidents
      WHERE timestamp >= NOW() - INTERVAL '30 days'
      GROUP BY severity
    `,
    topCameras: `
      SELECT c.id, c.name, COUNT(a.id) as accident_count
      FROM cameras c
      LEFT JOIN accidents a ON c.id = a.camera_id
      GROUP BY c.id, c.name
      ORDER BY accident_count DESC
      LIMIT $1
    `,
    userStatistics: `
      SELECT 
        COUNT(DISTINCT a.id) as total_reports,
        COUNT(DISTINCT CASE WHEN a.status = 'confirmed' THEN a.id END) as confirmed_reports,
        COUNT(DISTINCT fr.id) as false_reports
      FROM users u
      LEFT JOIN accidents a ON u.id = a.user_id
      LEFT JOIN false_reports fr ON u.id = fr.user_id
      WHERE u.id = $1
    `,
  },
};

/**
 * Query helper function
 */
async function query(text, params = []) {
  const start = Date.now();
  try {
    const result = await getPool().query(text, params);
    const duration = Date.now() - start;
    
    if (duration > 1000) {
      logInfo('Slow query detected', { 
        duration: `${duration}ms`, 
        query: text.substring(0, 100) 
      });
    }
    
    return result;
  } catch (error) {
    logError(error, { query: text, params });
    throw error;
  }
}

/**
 * Paginated query helper
 */
async function paginatedQuery(baseQuery, params, page = 1, limit = 50) {
  const offset = (page - 1) * limit;
  
  // Count total
  const countQuery = `SELECT COUNT(*) FROM (${baseQuery}) as count_query`;
  const countResult = await query(countQuery, params);
  const total = parseInt(countResult.rows[0].count);
  
  // Get data
  const dataQuery = `${baseQuery} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
  const dataResult = await query(dataQuery, [...params, limit, offset]);
  
  return {
    data: dataResult.rows,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      hasNext: page * limit < total,
      hasPrev: page > 1,
    },
  };
}

/**
 * Bulk insert helper
 */
async function bulkInsert(tableName, columns, values) {
  const placeholders = values.map((_, i) => 
    `(${columns.map((_, j) => `$${i * columns.length + j + 1}`).join(', ')})`
  ).join(', ');
  
  const flatValues = values.flat();
  const query = `
    INSERT INTO ${tableName} (${columns.join(', ')})
    VALUES ${placeholders}
    RETURNING *
  `;
  
  return await query(query, flatValues);
}

module.exports = {
  createPool,
  getPool,
  closePool,
  withTransaction,
  query,
  paginatedQuery,
  bulkInsert,
  queries,
};