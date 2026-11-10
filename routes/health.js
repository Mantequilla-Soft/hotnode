const express = require('express');
const router = express.Router();
const { getDatabase } = require('../utils/database');
const { getIPFSClient } = require('../utils/ipfs');
const logger = require('../utils/logger');
const config = require('../utils/config');
const { getDiscordNotifier } = require('../utils/discord');
const { evaluateCapacity, repoUsagePercent } = require('../utils/capacity');

/**
 * Health Check API
 * 
 * Used by Traffic Director to determine if hot node is healthy
 * and ready to receive uploads
 */

router.get('/', async (req, res) => {
  try {
    const db = getDatabase();
    const ipfs = getIPFSClient();
    
    // Check if IPFS is running
    const ipfsRunning = await ipfs.isRunning();
    
    if (!ipfsRunning) {
      logger.error('IPFS daemon is not running');
      return res.status(503).json({
        enabled: false,
        error: 'IPFS daemon not running',
        timestamp: new Date().toISOString()
      });
    }
    
    // Manual Enable/Disable toggle
    const manuallyEnabled = (await db.getConfig('enabled')) === 'true';
    
    // Get pin stats
    const pinStats = await db.getPinStats();
    
    // Get repo stats for disk usage
    let repoPercent = null;
    try {
      repoPercent = repoUsagePercent(await ipfs.repoStat());
    } catch (error) {
      logger.error('Failed to get disk usage:', error);
    }
    const diskUsagePercent = repoPercent ?? 0;

    // Capacity cutoff. If usage can't be read the last known state holds.
    const capacity = await evaluateCapacity(db, repoPercent, ({ paused, repoPercent: pct, thresholds }) =>
      getDiscordNotifier().notifyCapacityChange(paused, pct, thresholds)
    );

    // The Traffic Director routes uploads on `enabled`, so the cutoff is
    // expressed through it (200 + enabled=false, same as a manual disable).
    const enabled = manuallyEnabled && !capacity.paused;
    let reason = null;
    if (!manuallyEnabled) reason = 'disabled';
    else if (capacity.paused) reason = 'capacity';
    
    // Get 24h bandwidth stats
    const last24h = await db.all(`
      SELECT SUM(bytes_in) as bytes_in, SUM(bytes_out) as bytes_out
      FROM traffic_stats
      WHERE timestamp >= datetime('now', '-24 hours')
    `);
    
    const bandwidth24h = {
      in_mb: last24h[0]?.bytes_in ? Math.round(last24h[0].bytes_in / (1024 * 1024)) : 0,
      out_mb: last24h[0]?.bytes_out ? Math.round(last24h[0].bytes_out / (1024 * 1024)) : 0
    };
    
    // Health response
    const health = {
      enabled,
      reason,
      timestamp: new Date().toISOString(),
      disk_usage_percent: diskUsagePercent,
      capacity: {
        paused: capacity.paused,
        stop_percent: capacity.thresholds.stop_percent,
        resume_percent: capacity.thresholds.resume_percent
      },
      bandwidth_24h: bandwidth24h,
      pins: {
        total: pinStats.total || 0,
        pending_migration: pinStats.pending_migration || 0,
        overdue: pinStats.overdue || 0
      }
    };
    
    // Log health check
    logger.debug('Health check requested:', health);
    
    res.json(health);
  } catch (error) {
    logger.error('Health check failed:', error);
    res.status(500).json({
      enabled: false,
      error: 'Health check failed',
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * Detailed status endpoint (optional)
 */
router.get('/status', async (req, res) => {
  try {
    const db = getDatabase();
    const ipfs = getIPFSClient();
    
    // Get IPFS info
    let ipfsInfo = null;
    try {
      ipfsInfo = await ipfs.id();
    } catch (error) {
      logger.error('Failed to get IPFS info:', error);
    }
    
    // Get repo stats
    let repoStats = null;
    try {
      repoStats = await ipfs.repoStat();
    } catch (error) {
      logger.error('Failed to get repo stats:', error);
    }
    
    // Get database stats
    const pinStats = await db.getPinStats();
    const recentEvents = await db.getRecentEvents(10);
    
    const status = {
      hotnode: {
        name: config.hotnode.name,
        enabled: (await db.getConfig('enabled')) === 'true',
        version: '1.0.0'
      },
      ipfs: ipfsInfo ? {
        id: ipfsInfo.ID,
        addresses: ipfsInfo.Addresses
      } : null,
      repo: repoStats ? {
        size: repoStats.RepoSize,
        max: repoStats.StorageMax,
        objects: repoStats.NumObjects
      } : null,
      pins: pinStats,
      recent_events: recentEvents,
      timestamp: new Date().toISOString()
    };
    
    res.json(status);
  } catch (error) {
    logger.error('Status check failed:', error);
    res.status(500).json({ error: 'Status check failed' });
  }
});

module.exports = router;
