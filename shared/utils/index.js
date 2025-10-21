// shared/utils/index.js
// Нийтлэг утилити функцүүд

const crypto = require('crypto');

/**
 * Хоёр газарзүйн цэгийн хоорондох зай (метрээр)
 * Haversine формул ашиглан
 */
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371e3; // Дэлхийн радиус метрээр
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c; // метрээр
}

/**
 * Зайг хүний уншиж болох форматруу хөрвүүлэх
 */
function formatDistance(meters) {
  if (meters < 1000) {
    return `${Math.round(meters)}м`;
  }
  return `${(meters / 1000).toFixed(1)}км`;
}

/**
 * Огноог форматлах (Монгол)
 */
function formatDate(date) {
  const d = new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Цаг форматлах
 */
function formatTime(date) {
  const d = new Date(date);
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

/**
 * Хугацааны зөрүү хүний уншиж болох форматаар
 * (5 минутын өмнө, 2 цагийн өмнө гэх мэт)
 */
function timeAgo(date) {
  const now = new Date();
  const past = new Date(date);
  const diffMs = now - past;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'Яг одоо';
  if (diffMins < 60) return `${diffMins} минутын өмнө`;
  if (diffHours < 24) return `${diffHours} цагийн өмнө`;
  if (diffDays < 7) return `${diffDays} өдрийн өмнө`;
  
  return formatDate(date);
}

/**
 * Утасны дугаар шалгах (Монгол)
 */
function validatePhone(phone) {
  const phoneRegex = /^\+976\d{8}$/;
  return phoneRegex.test(phone);
}

/**
 * Email шалгах
 */
function validateEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

/**
 * Координат шалгах
 */
function validateCoordinates(latitude, longitude) {
  const lat = parseFloat(latitude);
  const lon = parseFloat(longitude);
  
  if (isNaN(lat) || isNaN(lon)) return false;
  if (lat < -90 || lat > 90) return false;
  if (lon < -180 || lon > 180) return false;
  
  return true;
}

/**
 * Санамсаргүй ID үүсгэх
 */
function generateId(length = 16) {
  return crypto.randomBytes(length).toString('hex');
}

/**
 * Random string үүсгэх
 */
function generateRandomString(length = 32) {
  return crypto.randomBytes(length).toString('base64url');
}

/**
 * Paginate helper
 */
function paginate(page = 1, limit = 50, maxLimit = 100) {
  const p = Math.max(1, parseInt(page));
  const l = Math.min(maxLimit, Math.max(1, parseInt(limit)));
  const offset = (p - 1) * l;
  
  return { limit: l, offset, page: p };
}

/**
 * Success response format
 */
function successResponse(data, message = 'Амжилттай') {
  return {
    success: true,
    message,
    data,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Error response format
 */
function errorResponse(error, statusCode = 500) {
  return {
    success: false,
    error: error.message || error,
    statusCode,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Sanitize user object (нууц үгийг устгах)
 */
function sanitizeUser(user) {
  const sanitized = { ...user };
  delete sanitized.password_hash;
  delete sanitized.password;
  return sanitized;
}

/**
 * File size-г хүний уншиж болох форматруу
 */
function formatFileSize(bytes) {
  if (bytes === 0) return '0 Bytes';
  
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

/**
 * Retry функц (promise-д)
 */
async function retry(fn, maxAttempts = 3, delay = 1000) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === maxAttempts - 1) throw error;
      await sleep(delay * Math.pow(2, i)); // Exponential backoff
    }
  }
}

/**
 * Sleep утилити
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Deep clone object
 */
function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/**
 * Remove null/undefined values from object
 */
function removeEmpty(obj) {
  return Object.entries(obj)
    .filter(([_, v]) => v != null)
    .reduce((acc, [k, v]) => ({ ...acc, [k]: v }), {});
}

/**
 * Chunk array
 */
function chunkArray(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

/**
 * Debounce функц
 */
function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

/**
 * Throttle функц
 */
function throttle(func, limit) {
  let inThrottle;
  return function(...args) {
    if (!inThrottle) {
      func.apply(this, args);
      inThrottle = true;
      setTimeout(() => inThrottle = false, limit);
    }
  };
}

/**
 * Cache key үүсгэх
 */
function createCacheKey(prefix, ...parts) {
  return `${prefix}:${parts.filter(Boolean).join(':')}`;
}

/**
 * Severity-г өнгөөр илэрхийлэх
 */
function getSeverityColor(severity) {
  const colors = {
    minor: '#FFA500',    // orange
    moderate: '#FF6B00', // dark orange
    severe: '#FF0000',   // red
  };
  return colors[severity] || '#808080';
}

/**
 * Status-г өнгөөр илэрхийлэх
 */
function getStatusColor(status) {
  const colors = {
    reported: '#FFA500',    // orange
    confirmed: '#FF0000',   // red
    resolved: '#00FF00',    // green
    false_alarm: '#808080', // gray
  };
  return colors[status] || '#808080';
}

/**
 * Error logger
 */
function logError(error, context = {}) {
  console.error({
    timestamp: new Date().toISOString(),
    error: {
      message: error.message,
      stack: error.stack,
      name: error.name,
    },
    context,
  });
}

/**
 * Info logger
 */
function logInfo(message, data = {}) {
  console.log({
    timestamp: new Date().toISOString(),
    level: 'info',
    message,
    data,
  });
}

module.exports = {
  // Distance & Location
  calculateDistance,
  formatDistance,
  validateCoordinates,
  
  // Date & Time
  formatDate,
  formatTime,
  timeAgo,
  
  // Validation
  validatePhone,
  validateEmail,
  
  // ID & Random
  generateId,
  generateRandomString,
  
  // Pagination
  paginate,
  
  // Response formatting
  successResponse,
  errorResponse,
  
  // User
  sanitizeUser,
  
  // File
  formatFileSize,
  
  // Async
  retry,
  sleep,
  
  // Object manipulation
  deepClone,
  removeEmpty,
  
  // Array
  chunkArray,
  
  // Function utilities
  debounce,
  throttle,
  
  // Cache
  createCacheKey,
  
  // UI
  getSeverityColor,
  getStatusColor,
  
  // Logging
  logError,
  logInfo,
};