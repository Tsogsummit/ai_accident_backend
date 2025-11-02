// services/api-gateway/server.js - FIXED VERSION
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { createProxyMiddleware } = require('http-proxy-middleware');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;

// ✅ FIXED: Environment validation
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET === 'your-secret-key') {
  console.error('❌ CRITICAL: JWT_SECRET not properly configured!');
  if (process.env.NODE_ENV === 'production') {
    process.exit(1);
  }
}

// ✅ FIXED: Production-ready security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
    },
  },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  }
}));

// ✅ FIXED: Production-ready CORS configuration
const allowedOrigins = process.env.ALLOWED_ORIGINS 
  ? process.env.ALLOWED_ORIGINS.split(',').map(origin => origin.trim())
  : ['http://localhost:3000'];

const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, Postman, etc.)
    if (!origin) {
      return callback(null, true);
    }
    
    // Check if origin is allowed
    if (allowedOrigins.includes(origin) || allowedOrigins.includes('*')) {
      callback(null, true);
    } else {
      console.warn(`❌ CORS blocked origin: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  exposedHeaders: ['X-RateLimit-Limit', 'X-RateLimit-Remaining'],
  maxAge: 86400 // 24 hours
};

app.use(cors(corsOptions));

// Body parser
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ✅ FIXED: Advanced rate limiting with different tiers
const createRateLimiter = (windowMs, max, message) => {
  return rateLimit({
    windowMs,
    max,
    message: { error: message },
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => {
      // Skip rate limiting for health checks
      return req.path === '/health';
    },
    keyGenerator: (req) => {
      // Use JWT userId if available, otherwise IP
      return req.user?.userId?.toString() || req.ip;
    }
  });
};

// General API rate limit
const generalLimiter = createRateLimiter(
  60 * 1000, // 1 minute
  100, // 100 requests
  'Хэт олон хүсэлт илгээлээ, түр хүлээнэ үү'
);

// Upload rate limit (stricter)
const uploadLimiter = createRateLimiter(
  24 * 60 * 60 * 1000, // 24 hours
  10, // 10 uploads
  'Өдөрт зөвшөөрөгдөх бичлэгийн тоо хэтэрлээ'
);

// Auth rate limit (strictest)
const authLimiter = createRateLimiter(
  15 * 60 * 1000, // 15 minutes
  5, // 5 attempts
  'Хэт олон нэвтрэх оролдлого. 15 минутын дараа дахин оролдоно уу'
);

// Apply rate limiters
app.use('/api/', generalLimiter);

// JWT Authentication middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ 
      success: false,
      error: 'Нэвтрэх шаардлагатай' 
    });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      const message = err.name === 'TokenExpiredError' 
        ? 'Токен хугацаа дууссан' 
        : 'Хүчингүй токен';
      return res.status(403).json({ 
        success: false,
        error: message 
      });
    }
    req.user = user;
    next();
  });
};

// Admin role check middleware
const requireAdmin = (req, res, next) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ 
      success: false,
      error: 'Админ эрх шаардлагатай' 
    });
  }
  next();
};

// Service endpoints
const SERVICES = {
  user: process.env.USER_SERVICE_URL || 'http://localhost:3001',
  accident: process.env.ACCIDENT_SERVICE_URL || 'http://localhost:3002',
  video: process.env.VIDEO_SERVICE_URL || 'http://localhost:3003',
  ai: process.env.AI_SERVICE_URL || 'http://localhost:3004',
  notification: process.env.NOTIFICATION_SERVICE_URL || 'http://localhost:3005',
  map: process.env.MAP_SERVICE_URL || 'http://localhost:3006',
  report: process.env.REPORT_SERVICE_URL || 'http://localhost:3007',
  camera: process.env.CAMERA_SERVICE_URL || 'http://localhost:3008',
  admin: process.env.ADMIN_SERVICE_URL || 'http://localhost:3009'
};

// Logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log({
      timestamp: new Date().toISOString(),
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration: `${duration}ms`,
      ip: req.ip,
      userId: req.user?.userId
    });
  });
  next();
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    service: 'api-gateway',
    timestamp: new Date().toISOString(),
    services: Object.keys(SERVICES),
    environment: process.env.NODE_ENV,
    uptime: process.uptime()
  });
});

// ==========================================
// PUBLIC ROUTES - No authentication needed
// ==========================================

app.use('/api/auth', authLimiter, createProxyMiddleware({
  target: SERVICES.user,
  changeOrigin: true,
  pathRewrite: { '^/api/auth': '/auth' },
  onError: (err, req, res) => {
    console.error('Proxy error:', err);
    res.status(503).json({ 
      success: false,
      error: 'Service unavailable' 
    });
  }
}));

// ==========================================
// PROTECTED ROUTES - JWT required
// ==========================================

app.use('/api/users', authenticateToken, createProxyMiddleware({
  target: SERVICES.user,
  changeOrigin: true,
  pathRewrite: { '^/api/users': '/users' }
}));

app.use('/api/accidents', authenticateToken, createProxyMiddleware({
  target: SERVICES.accident,
  changeOrigin: true,
  pathRewrite: { '^/api/accidents': '/accidents' }
}));

app.use('/api/videos', authenticateToken, uploadLimiter, createProxyMiddleware({
  target: SERVICES.video,
  changeOrigin: true,
  pathRewrite: { '^/api/videos': '/videos' },
  timeout: 120000 // 2 minutes for video uploads
}));

app.use('/api/ai', authenticateToken, createProxyMiddleware({
  target: SERVICES.ai,
  changeOrigin: true,
  pathRewrite: { '^/api/ai': '/ai' },
  timeout: 60000 // 1 minute
}));

app.use('/api/notifications', authenticateToken, createProxyMiddleware({
  target: SERVICES.notification,
  changeOrigin: true,
  pathRewrite: { '^/api/notifications': '/notifications' }
}));

app.use('/api/maps', authenticateToken, createProxyMiddleware({
  target: SERVICES.map,
  changeOrigin: true,
  pathRewrite: { '^/api/maps': '/maps' }
}));

app.use('/api/reports', authenticateToken, createProxyMiddleware({
  target: SERVICES.report,
  changeOrigin: true,
  pathRewrite: { '^/api/reports': '/reports' }
}));

// ==========================================
// ADMIN ONLY ROUTES
// ==========================================

app.use('/api/cameras', authenticateToken, requireAdmin, createProxyMiddleware({
  target: SERVICES.camera,
  changeOrigin: true,
  pathRewrite: { '^/api/cameras': '/cameras' }
}));

// ==========================================
// ERROR HANDLING
// ==========================================

// CORS error handler
app.use((err, req, res, next) => {
  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({
      success: false,
      error: 'CORS policy violation',
      message: 'Your origin is not allowed to access this resource'
    });
  }
  next(err);
});

// General error handler
app.use((err, req, res, next) => {
  console.error('Gateway error:', err);
  res.status(err.status || 500).json({
    success: false,
    error: process.env.NODE_ENV === 'production' 
      ? 'Дотоод алдаа гарлаа' 
      : err.message,
    timestamp: new Date().toISOString()
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ 
    success: false,
    error: 'Endpoint олдсонгүй',
    path: req.path,
    method: req.method
  });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully...');
  process.exit(0);
});

app.listen(PORT, () => {
  console.log(`🚀 API Gateway запущен на порту ${PORT}`);
  console.log(`📡 Подключенные сервисы:`, Object.keys(SERVICES));
  console.log(`🔒 CORS allowed origins:`, allowedOrigins);
  console.log(`🌍 Environment:`, process.env.NODE_ENV);
  console.log(`⚡ Rate limiting: Enabled`);
});

module.exports = app;