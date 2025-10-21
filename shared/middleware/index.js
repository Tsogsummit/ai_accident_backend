// shared/middleware/index.js
// Express middleware-ууд

const jwt = require('jsonwebtoken');
const config = require('../config');
const { errorResponse, logError } = require('../utils');

/**
 * JWT Authentication middleware
 * Authorization header-аас токен шалгах
 */
function authenticateToken(req, res, next) {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

    if (!token) {
      return res.status(401).json(
        errorResponse('Нэвтрэх шаардлагатай', 401)
      );
    }

    jwt.verify(token, config.jwt.secret, (err, user) => {
      if (err) {
        if (err.name === 'TokenExpiredError') {
          return res.status(401).json(
            errorResponse('Token хугацаа дууссан', 401)
          );
        }
        return res.status(403).json(
          errorResponse('Буруу токен', 403)
        );
      }

      req.user = user;
      next();
    });
  } catch (error) {
    logError(error, { middleware: 'authenticateToken' });
    res.status(500).json(errorResponse(error));
  }
}

/**
 * Admin role шалгах middleware
 */
function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json(
      errorResponse('Нэвтрэх шаардлагатай', 401)
    );
  }

  if (req.user.role !== 'admin') {
    return res.status(403).json(
      errorResponse('Админ эрх шаардлагатай', 403)
    );
  }

  next();
}

/**
 * Optional authentication - токен байвал шалгах, байхгүй бол next
 */
function optionalAuth(req, res, next) {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      return next();
    }

    jwt.verify(token, config.jwt.secret, (err, user) => {
      if (!err) {
        req.user = user;
      }
      next();
    });
  } catch (error) {
    next();
  }
}

/**
 * Request validation middleware
 */
function validateRequest(schema) {
  return (req, res, next) => {
    const { error, value } = schema.validate(req.body, { 
      abortEarly: false,
      stripUnknown: true 
    });

    if (error) {
      const errors = error.details.map(detail => ({
        field: detail.path.join('.'),
        message: detail.message,
      }));

      return res.status(400).json({
        success: false,
        error: 'Мэдээлэл буруу байна',
        details: errors,
      });
    }

    req.validatedBody = value;
    next();
  };
}

/**
 * Error handler middleware
 */
function errorHandler(err, req, res, next) {
  logError(err, {
    method: req.method,
    url: req.url,
    user: req.user?.userId,
  });

  // Duplicate key error (PostgreSQL)
  if (err.code === '23505') {
    return res.status(409).json(
      errorResponse('Давхардсан мэдээлэл', 409)
    );
  }

  // Foreign key violation
  if (err.code === '23503') {
    return res.status(400).json(
      errorResponse('Холбоотой мэдээлэл олдсонгүй', 400)
    );
  }

  // JWT errors
  if (err.name === 'JsonWebTokenError') {
    return res.status(401).json(
      errorResponse('Буруу токен', 401)
    );
  }

  if (err.name === 'TokenExpiredError') {
    return res.status(401).json(
      errorResponse('Token хугацаа дууссан', 401)
    );
  }

  // Validation errors
  if (err.name === 'ValidationError') {
    return res.status(400).json(
      errorResponse(err.message, 400)
    );
  }

  // Default error
  const statusCode = err.statusCode || 500;
  res.status(statusCode).json(
    errorResponse(
      config.env === 'production' 
        ? 'Серверийн алдаа гарлаа' 
        : err.message,
      statusCode
    )
  );
}

/**
 * Not found handler
 */
function notFoundHandler(req, res) {
  res.status(404).json(
    errorResponse(`Endpoint олдсонгүй: ${req.method} ${req.path}`, 404)
  );
}

/**
 * Request logger middleware
 */
function requestLogger(req, res, next) {
  const start = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log({
      timestamp: new Date().toISOString(),
      method: req.method,
      url: req.url,
      status: res.statusCode,
      duration: `${duration}ms`,
      user: req.user?.userId,
      ip: req.ip,
    });
  });

  next();
}

/**
 * CORS middleware
 */
function corsMiddleware(req, res, next) {
  const allowedOrigins = config.cors.origin === '*' 
    ? [req.headers.origin] 
    : config.cors.origin;

  const origin = req.headers.origin;
  
  if (config.cors.origin === '*' || allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  }

  res.setHeader('Access-Control-Allow-Methods', config.cors.methods.join(','));
  res.setHeader('Access-Control-Allow-Headers', config.cors.allowedHeaders.join(','));
  res.setHeader('Access-Control-Allow-Credentials', config.cors.credentials.toString());

  // Handle preflight
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  next();
}

/**
 * Rate limiting check middleware (Redis-тай ажиллах)
 */
function rateLimitCheck(redis, options = {}) {
  const windowMs = options.windowMs || config.rateLimit.windowMs;
  const max = options.max || config.rateLimit.max;
  const message = options.message || config.rateLimit.message;

  return async (req, res, next) => {
    try {
      const key = `rate_limit:${req.ip}:${req.path}`;
      
      const current = await redis.incr(key);
      
      if (current === 1) {
        await redis.pexpire(key, windowMs);
      }

      res.setHeader('X-RateLimit-Limit', max);
      res.setHeader('X-RateLimit-Remaining', Math.max(0, max - current));

      if (current > max) {
        return res.status(429).json(
          errorResponse(message, 429)
        );
      }

      next();
    } catch (error) {
      logError(error, { middleware: 'rateLimitCheck' });
      next(); // Алдаа гарвал rate limit-гүй үргэлжлүүлэх
    }
  };
}

/**
 * Cache middleware (Redis)
 */
function cacheMiddleware(redis, ttl = 300) {
  return async (req, res, next) => {
    // Зөвхөн GET хүсэлтийг кэшлэх
    if (req.method !== 'GET') {
      return next();
    }

    try {
      const key = `cache:${req.originalUrl || req.url}`;
      const cached = await redis.get(key);

      if (cached) {
        return res.json({
          ...JSON.parse(cached),
          cached: true,
          cachedAt: new Date().toISOString(),
        });
      }

      // Response-ыг capture хийх
      const originalJson = res.json.bind(res);
      res.json = (data) => {
        // Кэшлэх
        redis.setex(key, ttl, JSON.stringify(data)).catch(err => {
          logError(err, { middleware: 'cacheMiddleware' });
        });
        
        return originalJson(data);
      };

      next();
    } catch (error) {
      logError(error, { middleware: 'cacheMiddleware' });
      next();
    }
  };
}

/**
 * Sanitize request body (XSS protection)
 */
function sanitizeBody(req, res, next) {
  if (req.body) {
    Object.keys(req.body).forEach(key => {
      if (typeof req.body[key] === 'string') {
        // HTML tags устгах (энгийн шийдэл)
        req.body[key] = req.body[key]
          .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
          .replace(/<.*?>/g, '')
          .trim();
      }
    });
  }
  next();
}

/**
 * File upload validation middleware
 */
function validateFileUpload(options = {}) {
  const maxSize = options.maxSize || config.upload.maxFileSize;
  const allowedTypes = options.allowedTypes || config.upload.allowedVideoTypes;

  return (req, res, next) => {
    if (!req.file) {
      return res.status(400).json(
        errorResponse('Файл байхгүй байна', 400)
      );
    }

    // File size шалгах
    if (req.file.size > maxSize) {
      return res.status(400).json(
        errorResponse(
          `Файлын хэмжээ хэт том байна. Дээд хязгаар: ${maxSize / 1024 / 1024}MB`,
          400
        )
      );
    }

    // MIME type шалгах
    if (!allowedTypes.includes(req.file.mimetype)) {
      return res.status(400).json(
        errorResponse(
          `Зөвхөн ${allowedTypes.join(', ')} файл зөвшөөрөгдөнө`,
          400
        )
      );
    }

    next();
  };
}

/**
 * Pagination middleware
 */
function paginationMiddleware(req, res, next) {
  const page = parseInt(req.query.page) || 1;
  const limit = Math.min(
    parseInt(req.query.limit) || config.pagination.defaultLimit,
    config.pagination.maxLimit
  );
  const offset = (page - 1) * limit;

  req.pagination = {
    page,
    limit,
    offset,
  };

  next();
}

/**
 * Service health check middleware
 */
function healthCheck(serviceName, version = '1.0.0') {
  return (req, res) => {
    res.json({
      status: 'healthy',
      service: serviceName,
      version,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memory: process.memoryUsage(),
    });
  };
}

module.exports = {
  authenticateToken,
  requireAdmin,
  optionalAuth,
  validateRequest,
  errorHandler,
  notFoundHandler,
  requestLogger,
  corsMiddleware,
  rateLimitCheck,
  cacheMiddleware,
  sanitizeBody,
  validateFileUpload,
  paginationMiddleware,
  healthCheck,
};