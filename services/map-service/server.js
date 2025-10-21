// services/map-service/server.js
const express = require('express');
const { Pool } = require('pg');
const Redis = require('ioredis');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3006;

app.use(express.json());

// PostgreSQL
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'accident_db',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres'
});

// Redis
const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: process.env.REDIS_PORT || 6379
});

// Google Maps API Key
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || '';

// GET /maps/markers - Газрын зураг дээрх marker-ууд
app.get('/maps/markers', async (req, res) => {
  try {
    const {
      bounds,  // "lat1,lng1,lat2,lng2"
      status,
      severity,
      limit = 100
    } = req.query;

    // Cache key үүсгэх
    const cacheKey = `map_markers:${bounds}:${status}:${severity}:${limit}`;
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
        a.severity,
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

    // Bounds filter
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

    // Status filter
    if (status) {
      query += ` AND a.status = $${paramIndex++}`;
      params.push(status);
    }

    // Severity filter
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

    // Markers форматлах
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

    // Redis-д кэшлэх (2 минут)
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

// GET /maps/geocode - Координатаас хаяг олох
app.get('/maps/geocode', async (req, res) => {
  try {
    const { lat, lng } = req.query;

    if (!lat || !lng) {
      return res.status(400).json({ error: 'lat болон lng шаардлагатай' });
    }

    // Cache шалгах
    const cacheKey = `geocode:${lat}:${lng}`;
    const cached = await redis.get(cacheKey);

    if (cached) {
      return res.json({
        source: 'cache',
        address: JSON.parse(cached)
      });
    }

    if (!GOOGLE_MAPS_API_KEY) {
      return res.status(500).json({ 
        error: 'Google Maps API key тохируулаагүй байна' 
      });
    }

    // Google Geocoding API дуудах
    const response = await axios.get(
      'https://maps.googleapis.com/maps/api/geocode/json',
      {
        params: {
          latlng: `${lat},${lng}`,
          key: GOOGLE_MAPS_API_KEY,
          language: 'mn'
        }
      }
    );

    if (response.data.status === 'OK' && response.data.results.length > 0) {
      const result = response.data.results[0];
      const addressData = {
        formattedAddress: result.formatted_address,
        components: extractAddressComponents(result.address_components)
      };

      // Redis-д кэшлэх (7 өдөр)
      await redis.setex(cacheKey, 7 * 24 * 60 * 60, JSON.stringify(addressData));

      res.json({
        source: 'google',
        address: addressData
      });
    } else {
      res.status(404).json({ error: 'Хаяг олдсонгүй' });
    }

  } catch (error) {
    console.error('Geocode error:', error);
    res.status(500).json({ error: 'Geocoding алдаа' });
  }
});

// GET /maps/reverse-geocode - Хаягаас координат олох
app.get('/maps/reverse-geocode', async (req, res) => {
  try {
    const { address } = req.query;

    if (!address) {
      return res.status(400).json({ error: 'address шаардлагатай' });
    }

    // Cache шалгах
    const cacheKey = `reverse_geocode:${address}`;
    const cached = await redis.get(cacheKey);

    if (cached) {
      return res.json({
        source: 'cache',
        location: JSON.parse(cached)
      });
    }

    if (!GOOGLE_MAPS_API_KEY) {
      return res.status(500).json({ 
        error: 'Google Maps API key тохируулаагүй байна' 
      });
    }

    // Google Geocoding API
    const response = await axios.get(
      'https://maps.googleapis.com/maps/api/geocode/json',
      {
        params: {
          address: address,
          key: GOOGLE_MAPS_API_KEY,
          language: 'mn'
        }
      }
    );

    if (response.data.status === 'OK' && response.data.results.length > 0) {
      const result = response.data.results[0];
      const locationData = {
        latitude: result.geometry.location.lat,
        longitude: result.geometry.location.lng,
        formattedAddress: result.formatted_address
      };

      // Redis-д кэшлэх (7 өдөр)
      await redis.setex(cacheKey, 7 * 24 * 60 * 60, JSON.stringify(locationData));

      res.json({
        source: 'google',
        location: locationData
      });
    } else {
      res.status(404).json({ error: 'Байршил олдсонгүй' });
    }

  } catch (error) {
    console.error('Reverse geocode error:', error);
    res.status(500).json({ error: 'Reverse geocoding алдаа' });
  }
});

// GET /maps/directions - Зам харуулах
app.get('/maps/directions', async (req, res) => {
  try {
    const { originLat, originLng, destLat, destLng, mode = 'driving' } = req.query;

    if (!originLat || !originLng || !destLat || !destLng) {
      return res.status(400).json({ 
        error: 'Origin болон destination coordinates шаардлагатай' 
      });
    }

    if (!GOOGLE_MAPS_API_KEY) {
      return res.status(500).json({ 
        error: 'Google Maps API key тохируулаагүй байна' 
      });
    }

    // Google Directions API
    const response = await axios.get(
      'https://maps.googleapis.com/maps/api/directions/json',
      {
        params: {
          origin: `${originLat},${originLng}`,
          destination: `${destLat},${destLng}`,
          mode: mode,
          key: GOOGLE_MAPS_API_KEY,
          language: 'mn'
        }
      }
    );

    if (response.data.status === 'OK' && response.data.routes.length > 0) {
      const route = response.data.routes[0];
      const leg = route.legs[0];

      res.json({
        distance: leg.distance.text,
        duration: leg.duration.text,
        startAddress: leg.start_address,
        endAddress: leg.end_address,
        steps: leg.steps.map(step => ({
          instruction: step.html_instructions.replace(/<[^>]*>/g, ''),
          distance: step.distance.text,
          duration: step.duration.text
        })),
        polyline: route.overview_polyline.points
      });
    } else {
      res.status(404).json({ error: 'Зам олдсонгүй' });
    }

  } catch (error) {
    console.error('Directions error:', error);
    res.status(500).json({ error: 'Directions API алдаа' });
  }
});

// GET /maps/nearby-places - Ойролцоох газрууд (эмнэлэг, цагдаа гэх мэт)
app.get('/maps/nearby-places', async (req, res) => {
  try {
    const { lat, lng, type = 'hospital', radius = 5000 } = req.query;

    if (!lat || !lng) {
      return res.status(400).json({ error: 'lat болон lng шаардлагатай' });
    }

    if (!GOOGLE_MAPS_API_KEY) {
      return res.status(500).json({ 
        error: 'Google Maps API key тохируулаагүй байна' 
      });
    }

    // Google Places API
    const response = await axios.get(
      'https://maps.googleapis.com/maps/api/place/nearbysearch/json',
      {
        params: {
          location: `${lat},${lng}`,
          radius: radius,
          type: type,
          key: GOOGLE_MAPS_API_KEY,
          language: 'mn'
        }
      }
    );

    if (response.data.status === 'OK') {
      const places = response.data.results.map(place => ({
        name: place.name,
        address: place.vicinity,
        location: {
          lat: place.geometry.location.lat,
          lng: place.geometry.location.lng
        },
        rating: place.rating,
        isOpen: place.opening_hours?.open_now
      }));

      res.json({ places });
    } else {
      res.json({ places: [] });
    }

  } catch (error) {
    console.error('Nearby places error:', error);
    res.status(500).json({ error: 'Places API алдаа' });
  }
});

// GET /maps/heatmap - Ослын heatmap өгөгдөл
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

// Helper functions
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

function extractAddressComponents(components) {
  const extracted = {};
  
  components.forEach(component => {
    if (component.types.includes('street_number')) {
      extracted.streetNumber = component.long_name;
    }
    if (component.types.includes('route')) {
      extracted.street = component.long_name;
    }
    if (component.types.includes('locality')) {
      extracted.city = component.long_name;
    }
    if (component.types.includes('administrative_area_level_1')) {
      extracted.district = component.long_name;
    }
    if (component.types.includes('country')) {
      extracted.country = component.long_name;
    }
  });

  return extracted;
}

function getSeverityWeight(severity) {
  const weights = {
    'minor': 1,
    'moderate': 2,
    'severe': 3
  };
  return weights[severity] || 1;
}

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'map-service',
    googleMapsConfigured: !!GOOGLE_MAPS_API_KEY,
    timestamp: new Date().toISOString()
  });
});

app.listen(PORT, () => {
  console.log(`🗺️  Map Service запущен на порту ${PORT}`);
  console.log(`📍 Google Maps API: ${GOOGLE_MAPS_API_KEY ? 'настроен' : 'не настроен'}`);
});

module.exports = app;