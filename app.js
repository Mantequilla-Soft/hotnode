// Load environment variables first
require('dotenv').config();

const express = require('express');
const session = require('express-session');
const path = require('path');
const cron = require('node-cron');
const { getDatabase } = require('./utils/database');
const { getIPFSClient } = require('./utils/ipfs');
const logger = require('./utils/logger');

// Import workers
const logParser = require('./workers/logParser');
const mongoValidator = require('./workers/mongoValidator');
const migrationWorker = require('./workers/migrationWorker');
const cleanupWorker = require('./workers/cleanupWorker');
const statsAggregator = require('./workers/statsAggregator');

// Import routes
const healthRoutes = require('./routes/health');
const adminRoutes = require('./routes/admin');
const apiRoutes = require('./routes/api');

// Load configuration with environment variable overrides
let config;
try {
  const baseConfig = require('./config.json');
  
  // Override with environment variables
  config = {
    hotnode: {
      name: process.env.HOTNODE_NAME || baseConfig.hotnode.name,
      port: parseInt(process.env.HOTNODE_PORT) || baseConfig.hotnode.port,
      ipfs_api: process.env.IPFS_API_URL || baseConfig.hotnode.ipfs_api,
      ipfs_gateway: process.env.IPFS_GATEWAY_URL || baseConfig.hotnode.ipfs_gateway
    },
    supernode: {
      api: process.env.SUPERNODE_API || baseConfig.supernode.api,
      verify_endpoint: baseConfig.supernode.verify_endpoint,
      timeout_ms: parseInt(process.env.SUPERNODE_TIMEOUT_MS) || baseConfig.supernode.timeout_ms
    },
    mongodb: {
      uri: process.env.MONGODB_URI || baseConfig.mongodb.uri,
      database: process.env.MONGODB_DATABASE || baseConfig.mongodb.database,
      collection_legacy: process.env.MONGODB_COLLECTION_LEGACY || baseConfig.mongodb.collection_legacy,
      collection_new: process.env.MONGODB_COLLECTION_NEW || baseConfig.mongodb.collection_new,
      timeout_ms: parseInt(process.env.MONGODB_TIMEOUT_MS) || baseConfig.mongodb.timeout_ms
    },
    nginx: {
      log_path: process.env.NGINX_LOG_PATH || baseConfig.nginx.log_path
    },
    migration: {
      start_after_days: parseInt(process.env.MIGRATION_START_AFTER_DAYS) || baseConfig.migration.start_after_days,
      delete_after_days: parseInt(process.env.MIGRATION_DELETE_AFTER_DAYS) || baseConfig.migration.delete_after_days,
      batch_size: parseInt(process.env.MIGRATION_BATCH_SIZE) || baseConfig.migration.batch_size,
      check_interval_hours: parseInt(process.env.MIGRATION_CHECK_INTERVAL_HOURS) || baseConfig.migration.check_interval_hours,
      throttle_delay_ms: parseInt(process.env.MIGRATION_THROTTLE_DELAY_MS) || baseConfig.migration.throttle_delay_ms,
      max_retries: parseInt(process.env.MIGRATION_MAX_RETRIES) || baseConfig.migration.max_retries
    },
    cleanup: {
      invalid_retention_days: parseInt(process.env.CLEANUP_INVALID_RETENTION_DAYS) || baseConfig.cleanup.invalid_retention_days,
      gc_schedule: process.env.CLEANUP_GC_SCHEDULE || baseConfig.cleanup.gc_schedule,
      gc_timeout_minutes: parseInt(process.env.CLEANUP_GC_TIMEOUT_MINUTES) || baseConfig.cleanup.gc_timeout_minutes
    },
    stats: {
      retention_days: parseInt(process.env.STATS_RETENTION_DAYS) || baseConfig.stats.retention_days,
      aggregation_interval_minutes: parseInt(process.env.STATS_AGGREGATION_INTERVAL_MINUTES) || baseConfig.stats.aggregation_interval_minutes
    },
    discord: {
      webhook_url: process.env.DISCORD_WEBHOOK_URL || baseConfig.discord.webhook_url,
      notify_events: baseConfig.discord.notify_events
    },
    health: {
      disk_warning_percent: parseInt(process.env.HEALTH_DISK_WARNING_PERCENT) || baseConfig.health.disk_warning_percent,
      disk_critical_percent: parseInt(process.env.HEALTH_DISK_CRITICAL_PERCENT) || baseConfig.health.disk_critical_percent
    },
    logging: {
      level: process.env.LOG_LEVEL || baseConfig.logging.level,
      file: process.env.LOG_FILE || baseConfig.logging.file,
      max_size: process.env.LOG_MAX_SIZE || baseConfig.logging.max_size,
      max_files: parseInt(process.env.LOG_MAX_FILES) || baseConfig.logging.max_files
    }
  };
  
  logger.info('Configuration loaded successfully');
} catch (error) {
  logger.error('Failed to load config.json. Copy config.example.json to config.json and configure it.');
  process.exit(1);
}

// Initialize Express app
const app = express();
const PORT = config.hotnode.port || 3101;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Session configuration
app.use(session({
  secret: process.env.SESSION_SECRET || 'hotnode-secret-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

// Make auth status available to all views
app.use((req, res, next) => {
  res.locals.isAuthenticated = req.session.authenticated || false;
  next();
});

// View engine setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Make config available to views
app.locals.config = config;

// Routes
app.use('/health', healthRoutes);
app.use('/api', apiRoutes);
app.use('/', adminRoutes);

// Error handling middleware
app.use((err, req, res, next) => {
  logger.error('Express error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Database initialization
async function initializeDatabase() {
  try {
    const db = getDatabase();
    await db.connect();
    logger.info('Database connected successfully');
    return db;
  } catch (error) {
    logger.error('Database initialization failed:', error);
    throw error;
  }
}

// Schedule workers
function scheduleWorkers() {
  logger.info('Scheduling workers...');

  // Log Parser - Every 5 minutes
  cron.schedule('*/5 * * * *', async () => {
    logger.info('Running log parser worker...');
    try {
      await logParser.run();
    } catch (error) {
      logger.error('Log parser worker failed:', error);
    }
  });

  // MongoDB Validator - Every 30 minutes
  cron.schedule('*/30 * * * *', async () => {
    logger.info('Running MongoDB validator worker...');
    try {
      await mongoValidator.run();
    } catch (error) {
      logger.error('MongoDB validator worker failed:', error);
    }
  });

  // Migration Worker - Every 12 hours (at :00 and :12)
  cron.schedule('0 */12 * * *', async () => {
    logger.info('Running migration worker...');
    try {
      await migrationWorker.run();
    } catch (error) {
      logger.error('Migration worker failed:', error);
    }
  });

  // Cleanup Worker - Daily at 2 AM
  cron.schedule(config.cleanup.gc_schedule || '0 2 * * *', async () => {
    logger.info('Running cleanup worker...');
    try {
      await cleanupWorker.run();
    } catch (error) {
      logger.error('Cleanup worker failed:', error);
    }
  });

  // Stats Aggregator - Every hour
  cron.schedule('0 * * * *', async () => {
    logger.info('Running stats aggregator worker...');
    try {
      await statsAggregator.run();
    } catch (error) {
      logger.error('Stats aggregator worker failed:', error);
    }
  });

  logger.info('All workers scheduled successfully');
}

// Graceful shutdown
async function shutdown(signal) {
  logger.info(`Received ${signal}, shutting down gracefully...`);
  
  try {
    const db = getDatabase();
    await db.close();
    logger.info('Database connections closed');
    
    process.exit(0);
  } catch (error) {
    logger.error('Error during shutdown:', error);
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Start server
async function start() {
  try {
    // Initialize database
    await initializeDatabase();
    
    // Verify IPFS connection
    const ipfs = getIPFSClient();
    try {
      const ipfsInfo = await ipfs.id();
      logger.info(`Connected to IPFS node: ${ipfsInfo.ID}`);
    } catch (error) {
      logger.warn('Failed to connect to IPFS. Service will start but may not function properly.');
    }
    
    // Schedule workers
    scheduleWorkers();
    
    // Start HTTP server
    app.listen(PORT, () => {
      logger.info(`🚀 Hot Node Service started on port ${PORT}`);
      logger.info(`📊 Dashboard: http://localhost:${PORT}`);
      logger.info(`💓 Health check: http://localhost:${PORT}/health`);
      logger.info(`🏷️  Node name: ${config.hotnode.name}`);
    });
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Start the application
start();

module.exports = app;
