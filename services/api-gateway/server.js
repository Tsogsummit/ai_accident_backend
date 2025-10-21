// services/api-gateway/server.js
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { createProxyMiddleware } = require('http-proxy-middleware');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(helmet());
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
  credentials: true
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Rate limiting - API хязгаарлалт
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 минут
  max: 100, // 100 хүсэлт/минут
  message: 'Хэт олон хүсэлт илгээлээ, түр хүлээнэ үү'
});

const uploadLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 1 өдөр
  max: 10, // 10 бичлэг/өдөр
  message: 'Өдөрт зөвшөөрөгдөх бичлэгийн тоо хэтэрлээ'
});

app.use('/api/', limiter);

// JWT Authentication middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Нэвтрэх шаардлагатай' });
  }

  jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key', (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Хүчингүй токен' });
    }
    req.user = user;
    next();
  });
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
  camera: process.env.CAMERA_SERVICE_URL || 'http://localhost:3008'
};

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    services: Object.keys(SERVICES)
  });
});

// Public routes - Нэвтрэх шаардлагагүй
app.use('/api/auth', createProxyMiddleware({
  target: SERVICES.user,
  changeOrigin: true,
  pathRewrite: { '^/api/auth': '/auth' }
}));

// Protected routes - JWT шаардлагатай
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
  timeout: 120000 // 2 минут timeout бичлэгт
}));

app.use('/api/ai', authenticateToken, createProxyMiddleware({
  target: SERVICES.ai,
  changeOrigin: true,
  pathRewrite: { '^/api/ai': '/ai' },
  timeout: 60000 // 1 минут timeout AI-д
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

// Admin only - Camera service
app.use('/api/cameras', authenticateToken, (req, res, next) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Админ эрх шаардлагатай' });
  }
  next();
}, createProxyMiddleware({
  target: SERVICES.camera,
  changeOrigin: true,
  pathRewrite: { '^/api/cameras': '/cameras' }
}));

// Error handling
app.use((err, req, res, next) => {
  console.error('Gateway error:', err);
  res.status(err.status || 500).json({
    error: err.message || 'Дотоод алдаа гарлаа',
    timestamp: new Date().toISOString()
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ 
    error: 'Endpoint олдсонгүй',
    path: req.path 
  });
});

app.listen(PORT, () => {
  console.log(`🚀 API Gateway запущен на порту ${PORT}`);
  console.log(`📡 Подключенные сервисы:`, Object.keys(SERVICES));
});

module.exports = app;