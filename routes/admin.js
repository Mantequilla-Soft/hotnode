const express = require('express');
const router = express.Router();
const { getDatabase } = require('../utils/database');
const { getIPFSClient } = require('../utils/ipfs');
const logger = require('../utils/logger');
const config = require('../utils/config');

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
    
    res.render('dashboard', {
      enabled,
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
    const { status, search, page = 1 } = req.query;
    const db = getDatabase();
    
    const limit = 50;
    const offset = (parseInt(page, 10) - 1) * limit;
    
    let sql = 'SELECT * FROM pins WHERE 1=1';
    const params = [];
    
    if (status) {
      sql += ' AND status = ?';
      params.push(status);
    }
    
    if (search) {
      sql += ' AND cid LIKE ?';
      params.push(`%${search}%`);
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
      countSql += ' AND cid LIKE ?';
      countParams.push(`%${search}%`);
    }
    
    const countResult = await db.get(countSql, countParams);
    const totalPins = countResult.count;
    const totalPages = Math.ceil(totalPins / limit);
    
    res.render('pins', {
      pins,
      filters: { status, search },
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
    const configRows = await db.getAllConfig();
    const configMap = {};
    configRows.forEach(row => {
      configMap[row.key] = row.value;
    });
    
    // Get GC logs
    const gcLogs = await db.getRecentGCLogs(10);
    
    res.render('settings', {
      config: configMap,
      gcLogs,
      appConfig: config
    });
  } catch (error) {
    logger.error('Settings page error:', error);
    res.status(500).send('Error loading settings: ' + error.message);
  }
});

/**
 * Stats page
 */
router.get('/stats', async (req, res) => {
  try {
    const { period = 'daily' } = req.query;
    const db = getDatabase();
    
    // Get traffic stats
    const stats = await db.getTrafficStats(period, 30);
    
    res.render('stats', {
      period,
      stats
    });
  } catch (error) {
    logger.error('Stats page error:', error);
    res.status(500).send('Error loading stats: ' + error.message);
  }
});

module.exports = router;
