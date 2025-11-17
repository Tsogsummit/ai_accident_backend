const Redis = require('ioredis');
const logger = require('../utils/logger');

const redis = new Redis({
  host: process.env.REDIS_HOST || 'redis',
  port: process.env.REDIS_PORT || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
  retryStrategy: (times) => {
    if (times > 10) {
      logger.error('Redis: Max retries reached');
      return null;
    }
    const delay = Math.min(times * 50, 2000);
    logger.info(`Redis: Retry attempt ${times}, waiting ${delay}ms`);
    return delay;
  },
  maxRetriesPerRequest: 3,
  enableOfflineQueue: false,
});

redis.on('error', (err) => logger.error('Redis error:', err.message));
redis.on('connect', () => logger.info('✅ Redis connected'));
redis.on('ready', () => logger.info('✅ Redis ready'));

module.exports = { redis };
