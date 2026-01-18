const express = require('express');
const router = express.Router();
const { getDatabase } = require('../utils/database');
const { getIPFSClient } = require('../utils/ipfs');
const { getDiscordNotifier } = require('../utils/discord');
const logger = require('../utils/logger');

// Import workers for manual execution
const migrationWorker = require('../workers/migrationWorker');
const cleanupWorker = require('../workers/cleanupWorker');

/**
 * Admin API Endpoints
 * 
 * These endpoints provide control and data for the admin dashboard
 */

/**
 * Authentication middleware - require admin password
 */
function requireAuth(req, res, next) {
  if (req.session.authenticated) {
    return next();
  }
  res.status(401).json({ error: 'Authentication required' });
}

/**
 * Login endpoint
 */
router.post('/auth/login', async (req, res) => {
  try {
    const { password } = req.body;
    
    if (!password) {
      return res.status(400).json({ error: 'Password required' });
    }
    
    const adminPassword = process.env.ADMIN_PASSWORD;
    
    if (!adminPassword) {
      logger.error('ADMIN_PASSWORD not set in environment');
      return res.status(500).json({ error: 'Authentication not configured' });
    }
    
    if (password === adminPassword) {
      req.session.authenticated = true;
      logger.info('Admin authenticated successfully');
      return res.json({ success: true });
    } else {
      logger.warn('Failed authentication attempt');
      return res.status(401).json({ error: 'Invalid password' });
    }
  } catch (error) {
    logger.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

/**
 * Logout endpoint
 */
router.post('/auth/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      logger.error('Logout error:', err);
      return res.status(500).json({ error: 'Logout failed' });
    }
    res.json({ success: true });
  });
});

/**
 * Check authentication status
 */
router.get('/auth/status', (req, res) => {
  res.json({ authenticated: req.session.authenticated || false });
});

/**
 * Toggle hot node enabled/disabled
 */
router.post('/config/toggle', requireAuth, async (req, res) => {
  try {
    const db = getDatabase();
    const discord = getDiscordNotifier();
    
    // Get current status
    const currentStatus = (await db.getConfig('enabled')) === 'true';
    const newStatus = !currentStatus;
    
    // Update status
    await db.setConfig('enabled', newStatus ? 'true' : 'false');
    
    // Log event
    await db.logEvent({
      event_type: 'config_change',
      severity: 'warning',
      message: `Hot node ${newStatus ? 'enabled' : 'disabled'}`
    });
    
    // Get stats for notification
    const pinStats = await db.getPinStats();
    const ipfs = getIPFSClient();
    let diskUsage = 0;
    try {
      const repoStat = await ipfs.repoStat();
      diskUsage = Math.round((repoStat.RepoSize / repoStat.StorageMax) * 100);
    } catch (error) {
      // Ignore
    }
    
    // Send Discord notification
    await discord.notifyHealthChange(newStatus, {
      pending_migration: pinStats.pending_migration,
      disk_usage_percent: diskUsage,
      total_pins: pinStats.total
    });
    
    logger.info(`Hot node ${newStatus ? 'enabled' : 'disabled'}`);
    
    res.json({ success: true, enabled: newStatus });
  } catch (error) {
    logger.error('Failed to toggle status:', error);
    res.status(500).json({ error: 'Failed to toggle status' });
  }
});

/**
 * Update configuration value
 */
router.post('/config/update', requireAuth, async (req, res) => {
  try {
    const { key, value } = req.body;
    
    if (!key || value === undefined) {
      return res.status(400).json({ error: 'Key and value required' });
    }
    
    const db = getDatabase();
    await db.setConfig(key, value);
    
    logger.info(`Config updated: ${key} = ${value}`);
    
    res.json({ success: true });
  } catch (error) {
    logger.error('Failed to update config:', error);
    res.status(500).json({ error: 'Failed to update config' });
  }
});

/**
 * Get all configuration
 */
router.get('/config', async (req, res) => {
  try {
    const db = getDatabase();
    const config = await db.getAllConfig();
    
    res.json({ config });
  } catch (error) {
    logger.error('Failed to get config:', error);
    res.status(500).json({ error: 'Failed to get config' });
  }
});

/**
 * Get pin statistics
 */
router.get('/pins/stats', async (req, res) => {
  try {
    const db = getDatabase();
    const stats = await db.getPinStats();
    
    res.json(stats);
  } catch (error) {
    logger.error('Failed to get pin stats:', error);
    res.status(500).json({ error: 'Failed to get pin stats' });
  }
});

/**
 * Search/list pins
 */
router.get('/pins', async (req, res) => {
  try {
    const { status, limit = 50, offset = 0 } = req.query;
    const db = getDatabase();
    
    let sql = 'SELECT * FROM pins';
    const params = [];
    
    if (status) {
      sql += ' WHERE status = ?';
      params.push(status);
    }
    
    sql += ' ORDER BY added_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit, 10), parseInt(offset, 10));
    
    const pins = await db.all(sql, params);
    
    res.json({ pins });
  } catch (error) {
    logger.error('Failed to list pins:', error);
    res.status(500).json({ error: 'Failed to list pins' });
  }
});

/**
 * Get specific pin details
 */
router.get('/pins/:cid', async (req, res) => {
  try {
    const { cid } = req.params;
    const db = getDatabase();
    
    const pin = await db.getPin(cid);
    
    if (!pin) {
      return res.status(404).json({ error: 'Pin not found' });
    }
    
    res.json({ pin });
  } catch (error) {
    logger.error('Failed to get pin:', error);
    res.status(500).json({ error: 'Failed to get pin' });
  }
});

/**
 * Manual pin add
 */
router.post('/pins/add', requireAuth, async (req, res) => {
  try {
    const { cid } = req.body;
    
    if (!cid) {
      return res.status(400).json({ error: 'CID required' });
    }
    
    const db = getDatabase();
    const ipfs = getIPFSClient();
    
    // Pin to IPFS
    await ipfs.pinAdd(cid);
    
    // Get size
    const size = await ipfs.getCIDSize(cid);
    
    // Add to database
    await db.insertPin({
      cid,
      size_bytes: size,
      status: 'pending',
      notes: 'Manually added'
    });
    
    logger.info(`Manually pinned: ${cid}`);
    
    res.json({ success: true, cid, size });
  } catch (error) {
    logger.error('Failed to add pin:', error);
    res.status(500).json({ error: 'Failed to add pin', message: error.message });
  }
});

/**
 * Manual pin remove
 */
router.post('/pins/remove', requireAuth, async (req, res) => {
  try {
    const { cid } = req.body;
    
    if (!cid) {
      return res.status(400).json({ error: 'CID required' });
    }
    
    const db = getDatabase();
    const ipfs = getIPFSClient();
    
    // Unpin from IPFS
    await ipfs.pinRm(cid);
    
    // Update database
    await db.updatePin(cid, {
      unpinned: 1,
      unpinned_at: new Date().toISOString(),
      notes: 'Manually unpinned'
    });
    
    logger.info(`Manually unpinned: ${cid}`);
    
    res.json({ success: true, cid });
  } catch (error) {
    logger.error('Failed to remove pin:', error);
    res.status(500).json({ error: 'Failed to remove pin', message: error.message });
  }
});

/**
 * Check if pin exists on supernode
 */
router.post('/pins/check-supernode', requireAuth, async (req, res) => {
  try {
    const { cid } = req.body;
    
    if (!cid) {
      return res.status(400).json({ error: 'CID required' });
    }
    
    const axios = require('axios');
    const config = require('../config.json');
    
    // Check supernode
    const response = await axios.post(
      `${config.supernode.api}/api/v0/pin/ls?arg=${cid}`,
      null,
      {
        timeout: config.supernode.timeout_ms || 30000
      }
    );
    
    // Pin exists if Keys object contains the CID, or if no error message
    let exists = false;
    if (response.status === 200) {
      if (response.data && response.data.Keys && response.data.Keys[cid]) {
        exists = true;
      } else if (typeof response.data === 'string') {
        exists = !response.data.includes('not pinned');
      } else if (response.data && response.data.Message) {
        exists = !response.data.Message.includes('not pinned');
      }
    }
    
    logger.info(`Supernode check for ${cid}: ${exists ? 'exists' : 'not found'}`);
    
    res.json({ success: true, exists, cid });
  } catch (error) {
    logger.error('Failed to check supernode:', error.message);
    res.status(500).json({ error: 'Failed to check supernode', message: error.message });
  }
});

/**
 * Mark pin as migrated (when verified on supernode)
 */
router.post('/pins/mark-migrated', requireAuth, async (req, res) => {
  try {
    const { cid } = req.body;
    
    if (!cid) {
      return res.status(400).json({ error: 'CID required' });
    }
    
    const db = getDatabase();
    
    // Update database to mark as migrated
    await db.updatePin(cid, {
      migrated: 1,
      migrated_at: new Date().toISOString(),
      notes: 'Verified on supernode, marked as migrated'
    });
    
    logger.info(`Marked as migrated: ${cid}`);
    
    res.json({ success: true, cid });
  } catch (error) {
    logger.error('Failed to mark as migrated:', error);
    res.status(500).json({ error: 'Failed to mark as migrated', message: error.message });
  }
});

/**
 * Scan nginx logs for uploaded pins and add them to database
 * Actually scans IPFS for all current pins and syncs with database
 */
router.post('/pins/scan-logs', requireAuth, async (req, res) => {
  try {
    const db = getDatabase();
    const ipfs = getIPFSClient();
    
    logger.info('Scanning IPFS for pins...');
    
    // Get all pins from IPFS
    const pinsResult = await ipfs.pinLs();
    const ipfsPins = pinsResult.Keys || {};
    const ipfsCIDs = Object.keys(ipfsPins);
    
    logger.info(`Found ${ipfsCIDs.length} pins in IPFS`);
    
    let added = 0;
    let alreadyExists = 0;
    const errors = [];
    
    // Process each CID
    for (const cid of ipfsCIDs) {
      try {
        // Check if already in database
        const existing = await db.getPin(cid);
        
        if (existing) {
          alreadyExists++;
          continue;
        }
        
        // Get size
        const size = await ipfs.getCIDSize(cid);
        
        // Add to database
        await db.insertPin({
          cid,
          size_bytes: size,
          status: 'pending',
          notes: 'Discovered from IPFS pin scan'
        });
        
        added++;
        logger.info(`Added pin from IPFS scan: ${cid}`);
        
      } catch (error) {
        errors.push(`${cid}: ${error.message}`);
        logger.error(`Failed to process CID ${cid}:`, error);
      }
    }
    
    const summary = {
      success: true,
      scanned: ipfsCIDs.length,
      added,
      alreadyExists,
      errors: errors.slice(0, 5)
    };
    
    logger.info('IPFS pin scan complete:', summary);
    
    res.json(summary);
  } catch (error) {
    logger.error('Failed to scan IPFS pins:', error);
    res.status(500).json({ error: 'Failed to scan IPFS pins', message: error.message });
  }
});

/**
 * Trigger migration for specific pin
 */
router.post('/pins/migrate', requireAuth, async (req, res) => {
  try {
    const { cid } = req.body;
    
    if (!cid) {
      return res.status(400).json({ error: 'CID required' });
    }
    
    // This would need implementation in migration worker
    // For now, return not implemented
    res.status(501).json({ error: 'Not implemented yet' });
  } catch (error) {
    logger.error('Failed to migrate pin:', error);
    res.status(500).json({ error: 'Failed to migrate pin' });
  }
});

/**
 * Trigger immediate migration run
 */
router.post('/migration/run', requireAuth, async (req, res) => {
  try {
    logger.info('Manual migration triggered');
    
    // Run migration worker asynchronously
    migrationWorker.run()
      .then(result => {
        logger.info('Manual migration completed:', result);
      })
      .catch(error => {
        logger.error('Manual migration failed:', error);
      });
    
    res.json({ success: true, message: 'Migration started' });
  } catch (error) {
    logger.error('Failed to start migration:', error);
    res.status(500).json({ error: 'Failed to start migration' });
  }
});

/**
 * Trigger garbage collection
 */
router.post('/gc/run', requireAuth, async (req, res) => {
  try {
    logger.info('Manual GC triggered');
    
    // Run cleanup worker asynchronously
    cleanupWorker.run()
      .then(result => {
        logger.info('Manual GC completed:', result);
      })
      .catch(error => {
        logger.error('Manual GC failed:', error);
      });
    
    res.json({ success: true, message: 'Garbage collection started' });
  } catch (error) {
    logger.error('Failed to start GC:', error);
    res.status(500).json({ error: 'Failed to start GC' });
  }
});

/**
 * Get traffic stats
 */
router.get('/stats/:period', async (req, res) => {
  try {
    const { period } = req.params;
    const { limit = 24 } = req.query;
    
    if (!['hourly', 'daily', 'weekly', 'monthly'].includes(period)) {
      return res.status(400).json({ error: 'Invalid period' });
    }
    
    const db = getDatabase();
    const stats = await db.getTrafficStats(period, parseInt(limit, 10));
    
    res.json({ stats });
  } catch (error) {
    logger.error('Failed to get stats:', error);
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

/**
 * Get recent events
 */
router.get('/events', async (req, res) => {
  try {
    const { limit = 50, type } = req.query;
    const db = getDatabase();
    
    let events;
    if (type) {
      events = await db.getEventsByType(type, parseInt(limit, 10));
    } else {
      events = await db.getRecentEvents(parseInt(limit, 10));
    }
    
    res.json({ events });
  } catch (error) {
    logger.error('Failed to get events:', error);
    res.status(500).json({ error: 'Failed to get events' });
  }
});

/**
 * Get GC logs
 */
router.get('/gc/logs', async (req, res) => {
  try {
    const { limit = 10 } = req.query;
    const db = getDatabase();
    
    const logs = await db.getRecentGCLogs(parseInt(limit, 10));
    
    res.json({ logs });
  } catch (error) {
    logger.error('Failed to get GC logs:', error);
    res.status(500).json({ error: 'Failed to get GC logs' });
  }
});

/**
 * Test Discord webhook
 */
router.post('/discord/test', async (req, res) => {
  try {
    const discord = getDiscordNotifier();
    
    if (!discord.isEnabled()) {
      return res.status(400).json({ error: 'Discord webhook not configured' });
    }
    
    await discord.sendTest();
    
    res.json({ success: true, message: 'Test notification sent' });
  } catch (error) {
    logger.error('Failed to send test notification:', error);
    res.status(500).json({ error: 'Failed to send test notification' });
  }
});

module.exports = router;
