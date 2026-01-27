// Load environment variables first
require('dotenv').config();

const express = require('express');
const session = require('express-session');
const path = require('path');
const cron = require('node-cron');
const { getDatabase } = require('./utils/database');
const { getIPFSClient } = require('./utils/ipfs');
const logger = require('./utils/logger');
const config = require('./utils/config');

// Import workers
const mongoValidator = require('./workers/mongoValidator');
const migrationWorker = require('./workers/migrationWorker');
const cleanupWorker = require('./workers/cleanupWorker');
const statsAggregator = require('./workers/statsAggregator');
const pinDiscoveryWorker = require('./workers/pinDiscoveryWorker');

// Import routes
const healthRoutes = require('./routes/health');
const adminRoutes = require('./routes/admin');
const apiRoutes = require('./routes/api');

logger.info('Configuration loaded successfully');

// Initialize Express app
const app = express();
const PORT = config.hotnode.port || 3101;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// trust proxy
app.set('trust proxy',1);

// Session configuration
app.use(session({
  secret: process.env.SESSION_SECRET || 'hotnode-secret-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false,
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

  // Pin Discovery Worker - Every hour at :05 (runs first to discover new pins)
  cron.schedule('5 * * * *', async () => {
    logger.info('Running pin discovery worker...');
    try {
      await pinDiscoveryWorker.run();
    } catch (error) {
      logger.error('Pin discovery worker failed:', error);
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
