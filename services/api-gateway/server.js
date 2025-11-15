// services/api-gateway/server.js - FIXED VERSION WITH DEBUGGING
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { createProxyMiddleware } = require('http-proxy-middleware');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;

// ✅ Environment validation
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';
if (!JWT_SECRET || JWT_SECRET === 'your-secret-key') {
  console.warn('⚠️ WARNING: Using default JWT_SECRET! Set JWT_SECRET in production!');
}

// ✅ Security headers
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

// ✅ CORS configuration
const allowedOrigins = process.env.ALLOWED_ORIGINS 
  ? process.env.ALLOWED_ORIGINS.split(',').map(origin => origin.trim())
  : ['http://localhost:3000', '*'];

console.log('📡 CORS allowed origins:', allowedOrigins);

const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, Postman, curl)
    if (!origin) {
      return callback(null, true);
    }
    
    // Check if origin is allowed
    if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
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
  maxAge: 86400
};

app.use(cors(corsOptions));

// Body parser
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ✅ Service endpoints
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

console.log('🔌 Service URLs:');
Object.entries(SERVICES).forEach(([name, url]) => {
  console.log(`  ${name}: ${url}`);
});

// ✅ Rate limiting with different tiers
const createRateLimiter = (windowMs, max, message) => {
  return rateLimit({
    windowMs,
    max,
    message: { error: message },
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => {
      return req.path === '/health' || req.path === '/';
    },
    keyGenerator: (req) => {
      return req.user?.userId?.toString() || req.ip;
    }
  });
};

// General API rate limit
const generalLimiter = createRateLimiter(
  60 * 1000, // 1 minute
  100,
  'Хэт олон хүсэлт илгээлээ, түр хүлээнэ үү'
);

// Upload rate limit
const uploadLimiter = createRateLimiter(
  24 * 60 * 60 * 1000, // 24 hours
  10,
  'Өдөрт зөвшөөрөгдөх бичлэгийн тоо хэтэрлээ'
);

// ✅ RELAXED Auth rate limit for debugging
const authLimiter = createRateLimiter(
  15 * 60 * 1000, // 15 minutes
  100, // ✅ INCREASED from 5 to 100 for testing
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

// ✅ Enhanced logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  const requestId = Math.random().toString(36).substring(7);
  
  console.log(`[${requestId}] 📥 ${req.method} ${req.path} from ${req.ip}`);
  
  res.on('finish', () => {
    const duration = Date.now() - start;
    const statusEmoji = res.statusCode < 400 ? '✅' : '❌';
    console.log(`[${requestId}] ${statusEmoji} ${req.method} ${req.path} - ${res.statusCode} (${duration}ms)`);
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
    environment: process.env.NODE_ENV || 'development',
    uptime: process.uptime()
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'API Gateway',
    version: '1.0.0',
    status: 'running',
    endpoints: {
      auth: '/api/auth/*',
      users: '/api/users/*',
      accidents: '/api/accidents/*',
      videos: '/api/videos/*',
      ai: '/api/ai/*',
      notifications: '/api/notifications/*',
      maps: '/api/maps/*',
      reports: '/api/reports/*',
      cameras: '/api/cameras/*'
    },
    services: SERVICES
  });
});

// ==========================================
// PUBLIC ROUTES - No authentication needed
// ==========================================

// ✅ Enhanced auth proxy with better error handling and timeout
app.use('/api/auth', authLimiter, createProxyMiddleware({
  target: SERVICES.user,
  changeOrigin: true,
  pathRewrite: { '^/api/auth': '/auth' },
  timeout: 30000, // ✅ 30 second timeout
  proxyTimeout: 30000,
  onProxyReq: (proxyReq, req, res) => {
    console.log(`🔄 Proxying ${req.method} ${req.path} -> ${SERVICES.user}/auth${req.path.replace('/api/auth', '')}`);
  },
  onProxyRes: (proxyRes, req, res) => {
    console.log(`✅ Proxy response: ${proxyRes.statusCode} from ${req.path}`);
  },
  onError: (err, req, res) => {
    console.error('❌ Proxy error:', err.message);
    console.error('   Target:', SERVICES.user);
    console.error('   Path:', req.path);
    
    if (err.code === 'ECONNREFUSED') {
      return res.status(503).json({ 
        success: false,
        error: 'User service холбогдохгүй байна. Та дараа дахин оролдоно уу.',
        details: `Cannot connect to ${SERVICES.user}`
      });
    }
    
    if (err.code === 'ETIMEDOUT' || err.message.includes('timeout')) {
      return res.status(504).json({
        success: false,
        error: 'Хүсэлт удаж байна. Дахин оролдоно уу.',
        details: 'Gateway timeout'
      });
    }
    
    res.status(503).json({ 
      success: false,
      error: 'Service unavailable',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
}));

// ==========================================
// PROTECTED ROUTES - JWT required
// ==========================================

app.use('/api/users', authenticateToken, createProxyMiddleware({
  target: SERVICES.user,
  changeOrigin: true,
  pathRewrite: { '^/api/users': '/users' },
  timeout: 30000,
  onError: (err, req, res) => {
    console.error('User service proxy error:', err.message);
    res.status(503).json({ success: false, error: 'Service unavailable' });
  }
}));

app.use('/api/accidents', authenticateToken, createProxyMiddleware({
  target: SERVICES.accident,
  changeOrigin: true,
  pathRewrite: { '^/api/accidents': '/accidents' },
  timeout: 30000,
  onError: (err, req, res) => {
    console.error('Accident service proxy error:', err.message);
    res.status(503).json({ success: false, error: 'Service unavailable' });
  }
}));

app.use('/api/videos', authenticateToken, uploadLimiter, createProxyMiddleware({
  target: SERVICES.video,
  changeOrigin: true,
  pathRewrite: { '^/api/videos': '/videos' },
  timeout: 120000, // 2 minutes for video uploads
  onError: (err, req, res) => {
    console.error('Video service proxy error:', err.message);
    res.status(503).json({ success: false, error: 'Service unavailable' });
  }
}));

// ✅ AI service proxy
app.use('/api/ai', authenticateToken, createProxyMiddleware({
  target: SERVICES.ai,
  changeOrigin: true,
  pathRewrite: { '^/api/ai': '' }, // ✅ No prefix removal, direct path
  timeout: 60000, // 1 minute
  onProxyReq: (proxyReq, req, res) => {
    console.log(`🤖 AI Proxy: ${req.method} ${req.path} -> ${SERVICES.ai}${req.path.replace('/api/ai', '')}`);
  },
  onError: (err, req, res) => {
    console.error('AI service proxy error:', err.message);
    res.status(503).json({ success: false, error: 'AI service unavailable' });
  }
}));

app.use('/api/notifications', authenticateToken, createProxyMiddleware({
  target: SERVICES.notification,
  changeOrigin: true,
  pathRewrite: { '^/api/notifications': '/notifications' },
  timeout: 30000,
  onError: (err, req, res) => {
    console.error('Notification service proxy error:', err.message);
    res.status(503).json({ success: false, error: 'Service unavailable' });
  }
}));

app.use('/api/maps', authenticateToken, createProxyMiddleware({
  target: SERVICES.map,
  changeOrigin: true,
  pathRewrite: { '^/api/maps': '/maps' },
  timeout: 30000,
  onError: (err, req, res) => {
    console.error('Map service proxy error:', err.message);
    res.status(503).json({ success: false, error: 'Service unavailable' });
  }
}));

app.use('/api/reports', authenticateToken, createProxyMiddleware({
  target: SERVICES.report,
  changeOrigin: true,
  pathRewrite: { '^/api/reports': '/reports' },
  timeout: 30000,
  onError: (err, req, res) => {
    console.error('Report service proxy error:', err.message);
    res.status(503).json({ success: false, error: 'Service unavailable' });
  }
}));

// ==========================================
// ADMIN ONLY ROUTES
// ==========================================

app.use('/api/cameras', authenticateToken, requireAdmin, createProxyMiddleware({
  target: SERVICES.camera,
  changeOrigin: true,
  pathRewrite: { '^/api/cameras': '/cameras' },
  timeout: 30000,
  onError: (err, req, res) => {
    console.error('Camera service proxy error:', err.message);
    res.status(503).json({ success: false, error: 'Service unavailable' });
  }
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
    method: req.method,
    availableEndpoints: [
      '/health',
      '/api/auth/*',
      '/api/users/*',
      '/api/accidents/*',
      '/api/videos/*',
      '/api/ai/*',
      '/api/notifications/*',
      '/api/maps/*',
      '/api/reports/*',
      '/api/cameras/*'
    ]
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
  console.log('═══════════════════════════════════════════════════');
  console.log(`🚀 API Gateway running on port ${PORT}`);
  console.log('═══════════════════════════════════════════════════');
  console.log(`📡 Connected services:`, Object.keys(SERVICES));
  console.log(`🔒 CORS allowed origins:`, allowedOrigins);
  console.log(`🌍 Environment:`, process.env.NODE_ENV || 'development');
  console.log(`⚡ Rate limiting: Enabled`);
  console.log(`   - General: 100 req/min`);
  console.log(`   - Auth: 100 req/15min (relaxed for testing)`);
  console.log(`   - Upload: 10 req/day`);
  console.log('═══════════════════════════════════════════════════');
});

module.exports = app;