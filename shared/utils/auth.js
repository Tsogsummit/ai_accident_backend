const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const config = require('../config');

const BCRYPT_ROUNDS = 12;

async function hashPassword(password) {
  return await bcrypt.hash(password, BCRYPT_ROUNDS);
}

async function comparePassword(password, hash) {
  return await bcrypt.compare(password, hash);
}

function generateTokens(user) {
  const accessToken = jwt.sign(
    {
      userId: user.id,
      phone: user.phone,
      email: user.email,
      role: user.role
    },
    config.jwt.secret,
    { expiresIn: config.jwt.expiresIn }
  );

  const refreshToken = jwt.sign(
    { userId: user.id, type: 'refresh' },
    config.jwt.secret,
    { expiresIn: config.jwt.refreshExpiresIn }
  );

  return { accessToken, refreshToken };
}

function verifyToken(token) {
  try {
    return jwt.verify(token, config.jwt.secret);
  } catch (error) {
    throw error;
  }
}

function decodeToken(token) {
  return jwt.decode(token);
}

class LoginAttemptTracker {
  constructor(maxAttempts = 5, lockDuration = 15 * 60 * 1000) {
    this.attempts = new Map();
    this.maxAttempts = maxAttempts;
    this.lockDuration = lockDuration;
  }

  check(identifier) {
    const key = `login:${identifier}`;
    const data = this.attempts.get(key) || { count: 0, lockedUntil: 0 };

    if (data.lockedUntil > Date.now()) {
      const remainingSec = Math.ceil((data.lockedUntil - Date.now()) / 1000);
      return {
        allowed: false,
        message: `Хэт олон буруу оролдлого. ${remainingSec} секундын дараа дахин оролдоно уу`
      };
    }

    if (data.lockedUntil > 0 && data.lockedUntil <= Date.now()) {
      this.attempts.delete(key);
    }

    if (data.count >= this.maxAttempts) {
      data.lockedUntil = Date.now() + this.lockDuration;
      this.attempts.set(key, data);
      return {
        allowed: false,
        message: `Хэт олон буруу оролдлого. ${Math.ceil(this.lockDuration / 60000)} минутын дараа дахин оролдоно уу`
      };
    }

    return { allowed: true };
  }

  recordFailure(identifier) {
    const key = `login:${identifier}`;
    const data = this.attempts.get(key) || { count: 0, lockedUntil: 0 };
    data.count += 1;
    this.attempts.set(key, data);
  }

  reset(identifier) {
    this.attempts.delete(`login:${identifier}`);
  }

  cleanup() {
    const now = Date.now();
    for (const [key, data] of this.attempts.entries()) {
      if (data.lockedUntil > 0 && data.lockedUntil <= now) {
        this.attempts.delete(key);
      }
    }
  }
}

module.exports = {
  hashPassword,
  comparePassword,
  generateTokens,
  verifyToken,
  decodeToken,
  LoginAttemptTracker,
  BCRYPT_ROUNDS,
};
