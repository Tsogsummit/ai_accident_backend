// shared/config/index.js
// Нийтлэг тохиргоо - бүх сервисүүд ашиглана

require('dotenv').config();

module.exports = {
  // Server
  env: process.env.NODE_ENV || 'development',
  port: process.env.PORT || 3000,
  
  // Database
  database: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    name: process.env.DB_NAME || 'accident_db',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    maxConnections: parseInt(process.env.DB_MAX_CONNECTIONS || '20'),
    idleTimeout: parseInt(process.env.DB_IDLE_TIMEOUT || '30000'),
    connectionTimeout: parseInt(process.env.DB_CONNECTION_TIMEOUT || '2000'),
  },

  // Redis
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    password: process.env.REDIS_PASSWORD || undefined,
    db: parseInt(process.env.REDIS_DB || '0'),
    retryStrategy: (times) => {
      const delay = Math.min(times * 50, 2000);
      return delay;
    }
  },

  // JWT
  jwt: {
    secret: process.env.JWT_SECRET || 'your-secret-key-change-in-production',
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d',
  },

  // Google Cloud
  gcp: {
    projectId: process.env.GCP_PROJECT_ID,
    keyFilename: process.env.GCP_KEY_FILE || './gcp-key.json',
    bucket: process.env.GCS_BUCKET_NAME || 'accident-videos',
    pubsub: {
      videoProcessingTopic: 'video-processing',
      videoProcessingSub: 'video-processing-sub',
    }
  },

  // Firebase
  firebase: {
    serverKey: process.env.FCM_SERVER_KEY,
    databaseURL: process.env.FIREBASE_DATABASE_URL,
  },

  // API Rate Limiting
  rateLimit: {
    windowMs: 60 * 1000, // 1 минут
    max: 100, // 100 хүсэлт/минут
    message: 'Хэт олон хүсэлт илгээлээ, түр хүлээнэ үү',
    standardHeaders: true,
    legacyHeaders: false,
  },

  // Video upload limiting
  videoUploadLimit: {
    windowMs: 24 * 60 * 60 * 1000, // 1 өдөр
    max: 10, // 10 бичлэг/өдөр
    message: 'Өдөрт зөвшөөрөгдөх бичлэгийн тоо хэтэрлээ'
  },

  // File upload
  upload: {
    maxFileSize: 50 * 1024 * 1024, // 50MB
    allowedVideoTypes: ['video/mp4', 'video/quicktime', 'video/x-msvideo'],
    allowedImageTypes: ['image/jpeg', 'image/png', 'image/webp'],
  },

  // Camera settings
  camera: {
    streamInterval: 5 * 60 * 1000, // 5 минут
    streamDuration: 30, // 30 секунд
    healthCheckInterval: 60 * 1000, // 1 минут
  },

  // Notification settings
  notification: {
    defaultRadius: 5000, // 5км метрээр
    batchSize: 100, // Нэг удаад илгээх мэдэгдлийн тоо
  },

  // Service URLs (for inter-service communication)
  services: {
    user: process.env.USER_SERVICE_URL || 'http://localhost:3001',
    accident: process.env.ACCIDENT_SERVICE_URL || 'http://localhost:3002',
    video: process.env.VIDEO_SERVICE_URL || 'http://localhost:3003',
    ai: process.env.AI_SERVICE_URL || 'http://localhost:3004',
    notification: process.env.NOTIFICATION_SERVICE_URL || 'http://localhost:3005',
    map: process.env.MAP_SERVICE_URL || 'http://localhost:3006',
    report: process.env.REPORT_SERVICE_URL || 'http://localhost:3007',
    camera: process.env.CAMERA_SERVICE_URL || 'http://localhost:3008',
  },

  // AI Detection
  ai: {
    confidenceThreshold: parseFloat(process.env.AI_CONFIDENCE_THRESHOLD || '0.5'),
    minAccidentFrameRatio: parseFloat(process.env.AI_MIN_ACCIDENT_FRAME_RATIO || '0.3'),
    frameExtractionInterval: parseInt(process.env.AI_FRAME_INTERVAL || '2'), // секунд
  },

  // Logging
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    format: process.env.LOG_FORMAT || 'json',
  },

  // CORS
  cors: {
    origin: process.env.ALLOWED_ORIGINS 
      ? process.env.ALLOWED_ORIGINS.split(',') 
      : '*',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  },

  // Validation
  validation: {
    passwordMinLength: 6,
    phoneRegex: /^\+976\d{8}$/,
    emailRegex: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  },

  // Cache TTL
  cache: {
    accidentsList: 5 * 60, // 5 минут
    userProfile: 15 * 60, // 15 минут
    cameraList: 10 * 60, // 10 минут
    notificationSettings: 30 * 60, // 30 минут
  },

  // Pagination
  pagination: {
    defaultLimit: 50,
    maxLimit: 100,
  },

  // Status codes
  status: {
    accident: ['reported', 'confirmed', 'resolved', 'false_alarm'],
    severity: ['minor', 'moderate', 'severe'],
    videoStatus: ['uploading', 'uploaded', 'processing', 'completed', 'failed'],
    userStatus: ['active', 'inactive', 'suspended'],
    cameraStatus: ['active', 'inactive', 'maintenance'],
  },

  // Error messages (Монгол хэл)
  messages: {
    serverError: 'Серверийн алдаа гарлаа',
    notFound: 'Олдсонгүй',
    unauthorized: 'Нэвтрэх шаардлагатай',
    forbidden: 'Эрх хүрэхгүй байна',
    validationError: 'Мэдээлэл буруу байна',
    tokenExpired: 'Token хугацаа дууссан',
    tokenInvalid: 'Буруу токен',
  }
};