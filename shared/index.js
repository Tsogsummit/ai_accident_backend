// shared/index.js
// Бүх shared модулиудыг экспортлох үндсэн файл

module.exports = {
    // Config
    config: require('./config'),
    
    // Utils
    utils: require('./utils'),
    
    // Middleware
    middleware: require('./middleware'),
    
    // Database
    database: require('./database'),
  };
  
  // ==============================================
  // ХЭРХЭН АШИГЛАХ ВЭ
  // ==============================================
  
  /*
  
  ХУВИЛБАР 1: Бүх модулиудыг нэгэн зэрэг import
  -----------------------------------------
  const shared = require('../../shared');
  
  const config = shared.config;
  const { calculateDistance } = shared.utils;
  const { authenticateToken } = shared.middleware;
  const { query } = shared.database;
  
  
  ХУВИЛБАР 2: Тус тусад нь import (САНАЛ БОЛГОЖ БАЙНА)
  -----------------------------------------
  const config = require('../../shared/config');
  const { calculateDistance } = require('../../shared/utils');
  const { authenticateToken } = require('../../shared/middleware');
  const { query } = require('../../shared/database');
  
  
  ХУВИЛБАР 3: Destructuring ашиглах
  -----------------------------------------
  const { 
    config, 
    utils: { calculateDistance, formatDate },
    middleware: { authenticateToken, errorHandler },
    database: { query, queries }
  } = require('../../shared');
  
  */