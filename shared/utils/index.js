const crypto = require('crypto');
const auth = require('./auth');

function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371e3;
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}

function formatDistance(meters) {
  if (meters < 1000) {
    return `${Math.round(meters)}м`;
  }
  return `${(meters / 1000).toFixed(1)}км`;
}

function formatDate(date) {
  const d = new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatTime(date) {
  const d = new Date(date);
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

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

function validatePhone(phone) {
  const phoneRegex = /^\+976\d{8}$/;
  return phoneRegex.test(phone);
}

function validateEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

function validatePassword(password) {
  if (!password || password.length < 8) {
    return { valid: false, error: 'Нууц үг 8-аас дээш тэмдэгт байх ёстой' };
  }
  if (!/[A-Z]/.test(password)) {
    return { valid: false, error: 'Нууц үг том үсэг агуулсан байх ёстой' };
  }
  if (!/[a-z]/.test(password)) {
    return { valid: false, error: 'Нууц үг жижиг үсэг агуулсан байх ёстой' };
  }
  if (!/[0-9]/.test(password)) {
    return { valid: false, error: 'Нууц үг тоо агуулсан байх ёстой' };
  }
  return { valid: true };
}

function validateCoordinates(latitude, longitude) {
  const lat = parseFloat(latitude);
  const lon = parseFloat(longitude);
  
  if (isNaN(lat) || isNaN(lon)) return false;
  if (lat < -90 || lat > 90) return false;
  if (lon < -180 || lon > 180) return false;
  
  return true;
}

function generateId(length = 16) {
  return crypto.randomBytes(length).toString('hex');
}

function generateRandomString(length = 32) {
  return crypto.randomBytes(length).toString('base64url');
}

function paginate(page = 1, limit = 50, maxLimit = 100) {
  const p = Math.max(1, parseInt(page));
  const l = Math.min(maxLimit, Math.max(1, parseInt(limit)));
  const offset = (p - 1) * l;
  
  return { limit: l, offset, page: p };
}

function successResponse(data, message = 'Амжилттай') {
  return {
    success: true,
    message,
    data,
    timestamp: new Date().toISOString(),
  };
}

function errorResponse(error, statusCode = 500) {
  return {
    success: false,
    error: error.message || error,
    statusCode,
    timestamp: new Date().toISOString(),
  };
}

function sanitizeUser(user) {
  const sanitized = { ...user };
  delete sanitized.password_hash;
  delete sanitized.password;
  return sanitized;
}

function formatFileSize(bytes) {
  if (bytes === 0) return '0 Bytes';
  
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

async function retry(fn, maxAttempts = 3, delay = 1000) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === maxAttempts - 1) throw error;
      await sleep(delay * Math.pow(2, i)); 
    }
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function removeEmpty(obj) {
  return Object.entries(obj)
    .filter(([_, v]) => v != null)
    .reduce((acc, [k, v]) => ({ ...acc, [k]: v }), {});
}

function chunkArray(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

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

function createCacheKey(prefix, ...parts) {
  return `${prefix}:${parts.filter(Boolean).join(':')}`;
}

function getStatusColor(status) {
  const colors = {
    reported: '#FFA500',   
    confirmed: '#FF0000',  
    resolved: '#00FF00',   
    false_alarm: '#808080', 
  };
  return colors[status] || '#808080';
}

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

function logInfo(message, data = {}) {
  console.log({
    timestamp: new Date().toISOString(),
    level: 'info',
    message,
    data,
  });
}

module.exports = {
  calculateDistance,
  formatDistance,
  validateCoordinates,

  formatDate,
  formatTime,
  timeAgo,

  validatePhone,
  validateEmail,
  validatePassword,

  generateId,
  generateRandomString,

  paginate,

  successResponse,
  errorResponse,

  sanitizeUser,

  formatFileSize,

  retry,
  sleep,

  deepClone,
  removeEmpty,

  chunkArray,

  debounce,
  throttle,

  createCacheKey,

  getStatusColor,

  logError,
  logInfo,

  ...auth,
};