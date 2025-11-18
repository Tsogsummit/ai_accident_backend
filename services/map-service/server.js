
const express = require('express');
const { Pool } = require('pg');
const Redis = require('ioredis');

const app = express();
const PORT = process.env.PORT || 3006;

app.use(express.json());


const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'accident_db',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres'
});


const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: process.env.REDIS_PORT || 6379
});

const mapFeatureDisabledMessage = { error: 'Гадаад газрын зурагны үйлчилгээ идэвхгүй болсон' };


app.get('/maps/markers', async (req, res) => {
  try {
    const {
      bounds,  
      status,
      limit = 100
    } = req.query;

    
    const cacheKey = `map_markers:${bounds}:${status}:${limit}`;
    const cached = await redis.get(cacheKey);

    if (cached) {
      return res.json({
        source: 'cache',
        markers: JSON.parse(cached)
      });
    }

    let query = `
      SELECT 
        mm.id,
        mm.accident_id,
        mm.latitude,
        mm.longitude,
        mm.color,
        mm.icon_type,
        a.status,
        a.description,
        a.timestamp,
        a.verification_count,
        COUNT(fr.id) as false_report_count
      FROM map_markers mm
      INNER JOIN accidents a ON mm.accident_id = a.id
      LEFT JOIN false_reports fr ON a.id = fr.accident_id
      WHERE 1=1
    `;

    const params = [];
    let paramIndex = 1;

    
    if (bounds) {
      const [lat1, lng1, lat2, lng2] = bounds.split(',').map(Number);
      query += ` AND mm.latitude BETWEEN $${paramIndex} AND $${paramIndex + 1}`;
      query += ` AND mm.longitude BETWEEN $${paramIndex + 2} AND $${paramIndex + 3}`;
      params.push(
        Math.min(lat1, lat2),
        Math.max(lat1, lat2),
        Math.min(lng1, lng2),
        Math.max(lng1, lng2)
      );
      paramIndex += 4;
    }

    
    if (status) {
      query += ` AND a.status = $${paramIndex++}`;
      params.push(status);
    }

    
    if (severity) {
      query += ` AND a.severity = $${paramIndex++}`;
      params.push(severity);
    }

    query += `
      GROUP BY mm.id, a.severity, a.status, a.description, a.timestamp, a.verification_count
      ORDER BY a.timestamp DESC
      LIMIT $${paramIndex}
    `;
    params.push(limit);

    const result = await pool.query(query, params);

    
    const markers = result.rows.map(row => ({
      id: row.id,
      accidentId: row.accident_id,
      position: {
        lat: parseFloat(row.latitude),
        lng: parseFloat(row.longitude)
      },
      color: row.color,
      icon: row.icon_type,
      severity: row.severity,
      status: row.status,
      title: getMarkerTitle(row.severity, row.status),
      snippet: row.description?.substring(0, 100),
      timestamp: row.timestamp,
      verificationCount: row.verification_count,
      falseReportCount: row.false_report_count
    }));

    
    await redis.setex(cacheKey, 120, JSON.stringify(markers));

    res.json({
      source: 'database',
      markers,
      total: markers.length
    });

  } catch (error) {
    console.error('Get markers error:', error);
    res.status(500).json({ error: 'Marker авахад алдаа гарлаа' });
  }
});


app.get('/maps/geocode', (req, res) => {
  res.status(410).json(mapFeatureDisabledMessage);
});


app.get('/maps/reverse-geocode', (req, res) => {
  res.status(410).json(mapFeatureDisabledMessage);
});


app.get('/maps/directions', (req, res) => {
  res.status(410).json(mapFeatureDisabledMessage);
});


app.get('/maps/nearby-places', (req, res) => {
  res.status(410).json(mapFeatureDisabledMessage);
});


app.get('/maps/heatmap', async (req, res) => {
  try {
    const { days = 30 } = req.query;

    const result = await pool.query(`
      SELECT latitude, longitude, severity,
             COUNT(*) as weight
      FROM accidents
      WHERE timestamp >= NOW() - INTERVAL '${parseInt(days)} days'
        AND status != 'false_alarm'
      GROUP BY latitude, longitude, severity
    `);

    const heatmapData = result.rows.map(row => ({
      location: {
        lat: parseFloat(row.latitude),
        lng: parseFloat(row.longitude)
      },
      weight: parseInt(row.weight) * getSeverityWeight(row.severity)
    }));

    res.json({ heatmapData });

  } catch (error) {
    console.error('Heatmap error:', error);
    res.status(500).json({ error: 'Heatmap өгөгдөл авахад алдаа' });
  }
});


function getMarkerTitle(severity, status) {
  const severityText = {
    'minor': 'Бага',
    'moderate': 'Дунд',
    'severe': 'Ноцтой'
  };

  const statusText = {
    'reported': 'Мэдээлсэн',
    'confirmed': 'Баталгаажсан',
    'resolved': 'Шийдэгдсэн',
    'false_alarm': 'Худал'
  };

  return `${severityText[severity] || severity} - ${statusText[status] || status}`;
}

function getSeverityWeight(severity) {
  const weights = {
    'minor': 1,
    'moderate': 2,
    'severe': 3
  };
  return weights[severity] || 1;
}


app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'map-service',
    timestamp: new Date().toISOString()
  });
});

app.listen(PORT, () => {
  console.log(`🗺️  Map Service запущен на порту ${PORT}`);
});

module.exports = app;