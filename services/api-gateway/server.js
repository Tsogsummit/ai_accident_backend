const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { createProxyMiddleware } = require('http-proxy-middleware');
const jwt = require('jsonwebtoken');
const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';
if (JWT_SECRET === 'your-secret-key' && process.env.NODE_ENV === 'production') {
  console.error('❌ CRITICAL: JWT_SECRET not configured!');
  process.exit(1);
}
const SERVICES = {
  user: process.env.USER_SERVICE_URL || 'http://user-service:3001',
  accident: process.env.ACCIDENT_SERVICE_URL || 'http://accident-service:3002',
  video: process.env.VIDEO_SERVICE_URL || 'http://video-service:3003',
  ai: process.env.AI_SERVICE_URL || 'http://ai-service:3004',
  notification: process.env.NOTIFICATION_SERVICE_URL || 'http://notification-service:3005',
  map: process.env.MAP_SERVICE_URL || 'http://map-service:3006',
  report: process.env.REPORT_SERVICE_URL || 'http://report-service:3007',
  camera: process.env.CAMERA_SERVICE_URL || 'http://camera-service:3009',
  admin: process.env.ADMIN_SERVICE_URL || 'http://admin-service:3008'
};
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));
app.use(cors({
  origin: '*', 
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  exposedHeaders: ['X-RateLimit-Limit', 'X-RateLimit-Remaining']
}));
app.options('*', cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use((req, res, next) => {
  req.id = Math.random().toString(36).substring(7);
  next();
});
app.use((req, res, next) => {
  const start = Date.now();
  console.log(`[${req.id}] 📥 ${req.method} ${req.path} from ${req.ip}`);
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`[${req.id}] ✅ ${req.method} ${req.path} - ${res.statusCode} (${duration}ms)`);
  });
  next();
});
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  message: { success: false, error: 'Хэт олон хүсэлт илгээлээ' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === '/health'
});
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { success: false, error: 'Хэт олон нэвтрэх оролдлого' }
});
const uploadLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 20,
  message: { success: false, error: 'Өдөрт зөвшөөрөгдөх бичлэгийн тоо хэтэрлээ' }
});
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
const requireAdmin = (req, res, next) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ 
      success: false,
      error: 'Админ эрх шаардлагатай' 
    });
  }
  next();
};
const createProxy = (target, options = {}) => {
  return createProxyMiddleware({
    target,
    changeOrigin: true,
    timeout: 30000,
    proxyTimeout: 30000,
    ...options,
    onProxyReq: (proxyReq, req, res) => {
      console.log(`🔄 Proxying ${req.method} ${req.path} -> ${target}${options.pathRewrite ? options.pathRewrite[`^${req.baseUrl}`] : req.path}`);
      if (req.body && Object.keys(req.body).length > 0) {
        const bodyData = JSON.stringify(req.body);
        proxyReq.setHeader('Content-Type', 'application/json');
        proxyReq.setHeader('Content-Length', Buffer.byteLength(bodyData));
        proxyReq.write(bodyData);
      }
    },
    onProxyRes: (proxyRes, req, res) => {
      proxyRes.headers['Access-Control-Allow-Origin'] = '*';
      proxyRes.headers['Access-Control-Allow-Credentials'] = 'true';
    },
    onError: (err, req, res) => {
      console.error(`❌ Proxy error for ${req.method} ${req.path}:`, err.message);
      if (!res.headersSent) {
        res.status(503).json({ 
          success: false,
          error: 'Service временно недоступен',
          details: process.env.NODE_ENV === 'development' ? err.message : undefined
        });
      }
    }
  });
};
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
app.use('/api/auth', authLimiter, createProxy(SERVICES.user, {
  pathRewrite: { '^/api/auth': '/auth' }
}));
app.use('/api/users', generalLimiter, authenticateToken, createProxy(SERVICES.user, {
  pathRewrite: { '^/api/users': '/users' }
}));
app.use('/api/accidents', generalLimiter, authenticateToken, createProxy(SERVICES.accident, {
  pathRewrite: { '^/api/accidents': '/accidents' }
}));
app.get('/api/videos/:id/status', generalLimiter, createProxy(SERVICES.video, {
  pathRewrite: { '^/api/videos': '/videos' }
}));
app.post('/api/videos/:id/retry-ai', generalLimiter, createProxy(SERVICES.video, {
  pathRewrite: { '^/api/videos': '/videos' }
}));
app.post('/api/video/upload', uploadLimiter, authenticateToken, createProxy(SERVICES.video, {
  pathRewrite: { '^/api/video/upload': '/upload' }
}));
app.use('/api/videos', (req, res, next) => {
  const path = req.path || req.url;
  if (path.includes('/status') || path.includes('/retry-ai')) {
    return next(); 
  }
  return uploadLimiter(req, res, () => {
    return authenticateToken(req, res, () => {
      return createProxy(SERVICES.video, {
        pathRewrite: { '^/api/videos': '/videos' }
      })(req, res, next);
    });
  });
});
app.use('/api/ai', generalLimiter, authenticateToken, createProxy(SERVICES.ai, {
  pathRewrite: { '^/api/ai': '/ai' }
}));
app.use('/api/notifications', generalLimiter, authenticateToken, createProxy(SERVICES.notification, {
  pathRewrite: { '^/api/notifications': '/notifications' }
}));
app.use('/api/maps', generalLimiter, authenticateToken, createProxy(SERVICES.map, {
  pathRewrite: { '^/api/maps': '/maps' }
}));
app.use('/api/reports', generalLimiter, authenticateToken, createProxy(SERVICES.report, {
  pathRewrite: { '^/api/reports': '/reports' }
}));
app.use('/api/admin', generalLimiter, authenticateToken, requireAdmin, createProxy(SERVICES.admin, {
  pathRewrite: { '^/api/admin': '/admin' }
}));
app.use('/api/cameras', generalLimiter, authenticateToken, requireAdmin, createProxy(SERVICES.camera, {
  pathRewrite: { '^/api/cameras': '/cameras' }
}));
app.use((req, res) => {
  res.status(404).json({ 
    success: false,
    error: 'Endpoint олдсонгүй',
    path: req.path,
    method: req.method
  });
});
app.use((err, req, res, next) => {
  console.error('❌ Gateway error:', err);
  res.status(err.status || 500).json({
    success: false,
    error: process.env.NODE_ENV === 'production' 
      ? 'Серверийн алдаа гарлаа' 
      : err.message,
    timestamp: new Date().toISOString()
  });
});
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`🚀 API Gateway running on port ${PORT}`);
  console.log('═══════════════════════════════════════════════════════════');
  console.log('📡 Services:');
  Object.entries(SERVICES).forEach(([name, url]) => {
    console.log(`   ${name.padEnd(15)} → ${url}`);
  });
  console.log('═══════════════════════════════════════════════════════════');
  console.log('🌍 Environment:', process.env.NODE_ENV || 'development');
  console.log('🔒 CORS: Enabled for all origins (development mode)');
  console.log('⚡ Rate limiting: Enabled');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('\n📱 Android Emulator URLs:');
  console.log('   Development: http://10.0.2.2:3000');
  console.log('   Real device: http://<YOUR_LOCAL_IP>:3000');
  console.log('\n💡 Test endpoints:');
  console.log(`   Health: http://localhost:${PORT}/health`);
  console.log(`   Login:  POST http://localhost:${PORT}/auth/login`);
  console.log('═══════════════════════════════════════════════════════════\n');
});
const shutdown = async () => {
  console.log('\n🛑 Shutting down gracefully...');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
  setTimeout(() => {
    console.error('⚠️  Forced shutdown');
    process.exit(1);
  }, 10000);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
module.exports = app;