const express = require('express');
const router = express.Router();
const { getDatabase } = require('../utils/database');
const { getIPFSClient } = require('../utils/ipfs');
const logger = require('../utils/logger');
const config = require('../utils/config');
const { getThresholds, isPaused } = require('../utils/capacity');
const { requireAuth } = require('../utils/auth');

/**
 * Admin Dashboard Routes
 * 
 * Web UI for monitoring and manual intervention
 */

/**
 * Dashboard home
 */
router.get('/', async (req, res) => {
  try {
    const db = getDatabase();
    const ipfs = getIPFSClient();
    
    // Get system status
    const enabled = (await db.getConfig('enabled')) === 'true';
    
    // Get pin stats
    const pinStats = await db.getPinStats();
    
    // Get repo stats
    let repoStats = null;
    try {
      const stat = await ipfs.repoStat();
      repoStats = {
        size: stat.RepoSize,
        max: stat.StorageMax,
        usage_percent: Math.round((stat.RepoSize / stat.StorageMax) * 100),
        num_objects: stat.NumObjects
      };
    } catch (error) {
      logger.error('Failed to get repo stats:', error);
    }
    
    // Get recent events
    const recentEvents = await db.getRecentEvents(10);
    
    // Get recent pins
    const recentPins = await db.all(`
      SELECT * FROM pins
      ORDER BY added_at DESC
      LIMIT 10
    `);
    
    // Get last worker runs
    const lastGC = await db.getConfig('last_gc_run');
    const lastMigration = await db.getConfig('last_migration_run');
    const lastStats = await db.getConfig('last_stats_run');
    
    const thresholds = await getThresholds(db);
    const capacityPaused = await isPaused(db);
    
    res.render('dashboard', {
      target: await db.getMigrationTarget(),
      enabled,
      capacityPaused,
      thresholds,
      pinStats,
      repoStats,
      recentEvents,
      recentPins,
      lastRuns: {
        gc: lastGC,
        migration: lastMigration,
        stats: lastStats
      }
    });
  } catch (error) {
    logger.error('Dashboard error:', error);
    res.status(500).send('Dashboard error: ' + error.message);
  }
});

/**
 * Pin management page
 */
router.get('/pins', async (req, res) => {
  try {
    const { status, search, s3, page = 1 } = req.query;
    const db = getDatabase();
    const target = await db.getMigrationTarget();
    
    const limit = 50;
    const offset = (parseInt(page, 10) - 1) * limit;
    
    let sql = 'SELECT * FROM pins WHERE 1=1';
    const params = [];
    
    if (status) {
      sql += ' AND status = ?';
      params.push(status);
    }
    
    // One box finds a CID, a channel or a permlink.
    if (search) {
      sql += ' AND (cid LIKE ? OR owner LIKE ? OR permlink LIKE ?)';
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (s3) {
      sql += s3 === 'none' ? ' AND s3_state IS NULL' : ' AND s3_state = ?';
      if (s3 !== 'none') params.push(s3);
    }
    
    sql += ' ORDER BY added_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);
    
    const pins = await db.all(sql, params);
    
    // Get total count
    let countSql = 'SELECT COUNT(*) as count FROM pins WHERE 1=1';
    const countParams = [];
    if (status) {
      countSql += ' AND status = ?';
      countParams.push(status);
    }
    if (search) {
      countSql += ' AND (cid LIKE ? OR owner LIKE ? OR permlink LIKE ?)';
      countParams.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (s3) {
      countSql += s3 === 'none' ? ' AND s3_state IS NULL' : ' AND s3_state = ?';
      if (s3 !== 'none') countParams.push(s3);
    }
    
    const countResult = await db.get(countSql, countParams);
    const totalPins = countResult.count;
    const totalPages = Math.ceil(totalPins / limit);
    
    res.render('pins', {
      pins,
      target,
      migratorUrl: config.migrator.public_url || null,
      filters: { status, search, s3 },
      pagination: {
        page: parseInt(page, 10),
        totalPages,
        totalPins
      }
    });
  } catch (error) {
    logger.error('Pins page error:', error);
    res.status(500).send('Error loading pins: ' + error.message);
  }
});

/**
 * Settings page
 */
router.get('/settings', async (req, res) => {
  try {
    const db = getDatabase();
    
    // Get all configuration
    let configRows = [];
    let dbConfig = {};
    try {
      configRows = await db.getAllConfig();
      configRows.forEach(row => {
        dbConfig[row.key] = row.value;
      });
    } catch (error) {
      logger.error('Failed to load config:', error);
    }
    
    // Get GC logs
    let gcLogs = [];
    try {
      gcLogs = await db.getRecentGCLogs(10);
    } catch (error) {
      logger.error('Failed to load GC logs:', error);
    }
    
    const thresholds = await getThresholds(db);
    const capacityPaused = await isPaused(db);
    
    res.render('settings', {
      dbConfig,
      thresholds,
      capacityPaused,
      gcLogs,
      isAuthenticated: res.locals.isAuthenticated
    });
  } catch (error) {
    logger.error('Settings page error:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message, stack: error.stack });
  }
});

/**
 * Stats page
 */
router.get('/stats', async (req, res) => {
  try {
    const db = getDatabase();
    
    res.render('stats', {
      config: {
        hotnode: {
          name: process.env.HOTNODE_NAME || 'IPFS Hot Node'
        }
      },
      isAuthenticated: res.locals.isAuthenticated
    });
  } catch (error) {
    logger.error('Stats page error:', error);
    res.status(500).send('Error loading stats: ' + error.message);
  }
});

/**
 * Update migration rate settings
 */
router.post('/settings/migration-rate', requireAuth, async (req, res) => {
  try {
    const { mode, maxDaily } = req.body;
    const db = getDatabase();
    
    // Validate mode
    const validModes = ['mild', 'normal', 'aggressive'];
    if (!validModes.includes(mode)) {
      return res.status(400).json({ success: false, error: 'Invalid migration mode' });
    }
    
    // Save settings
    await db.setConfig('migration_rate_mode', mode);
    
    if (maxDaily && maxDaily > 0) {
      await db.setConfig('migration_max_daily', maxDaily.toString());
    } else {
      // Clear custom max daily if not provided
      await db.setConfig('migration_max_daily', '');
    }
    
    logger.info(`Migration rate settings updated: mode=${mode}, maxDaily=${maxDaily || 'default'}`);
    
    await db.logEvent({
      event_type: 'config_change',
      severity: 'info',
      message: `Migration rate settings updated: ${mode}`,
      metadata: JSON.stringify({ mode, maxDaily })
    });
    
    res.json({ success: true });
  } catch (error) {
    logger.error('Failed to update migration rate settings:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get migration rate settings
 */
router.get('/settings/migration-rate', async (req, res) => {
  try {
    const db = getDatabase();
    
    const mode = await db.getConfig('migration_rate_mode') || 'normal';
    const maxDaily = await db.getConfig('migration_max_daily');
    
    res.json({
      success: true,
      mode,
      maxDaily: maxDaily ? parseInt(maxDaily, 10) : null
    });
  } catch (error) {
    logger.error('Failed to get migration rate settings:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
