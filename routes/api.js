const express = require('express');
const router = express.Router();
const { getDatabase } = require('../utils/database');
const { getIPFSClient } = require('../utils/ipfs');
const { getDiscordNotifier } = require('../utils/discord');
const { getMongoDBClient } = require('../utils/mongo');
const logger = require('../utils/logger');
const config = require('../utils/config');

// Import workers for manual execution
const migrationWorker = require('../workers/migrationWorker');
const cleanupWorker = require('../workers/cleanupWorker');
const mongoValidator = require('../workers/mongoValidator');

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
 * PUBLIC VALIDATION API
 * Used by community nodes to validate CIDs without MongoDB access
 */

/**
 * Validate a single CID
 * POST /api/validate/cid/:cid
 * Public endpoint - no auth required
 */
router.post('/validate/cid/:cid', async (req, res) => {
  try {
    const { cid } = req.params;
    
    if (!cid) {
      return res.status(400).json({ error: 'CID required' });
    }

    // Check if this node has MongoDB access (infrastructure node)
    const nodeType = process.env.NODE_TYPE || 'infrastructure';
    
    if (nodeType !== 'infrastructure') {
      return res.status(503).json({ 
        error: 'This node is not configured as a validation server',
        message: 'Please use an infrastructure node for CID validation'
      });
    }

    const mongo = getMongoDBClient();
    await mongo.connect();
    
    try {
      // Use batch validation method for efficiency (even for single CID)
      const results = await mongo.validateCIDs([cid]);
      const valid = results[0]?.valid || false;
      
      logger.info(`CID validation request: ${cid} - ${valid ? 'VALID' : 'INVALID'}`);
      
      res.json({
        cid,
        valid,
        timestamp: new Date().toISOString()
      });
    } finally {
      await mongo.disconnect();
    }
  } catch (error) {
    logger.error('CID validation failed:', error);
    res.status(500).json({ 
      error: 'Validation failed',
      message: error.message
    });
  }
});

/**
 * Batch validate multiple CIDs
 * POST /api/validate/batch
 * Body: { cids: ["Qm...", "Qm..."] }
 * Public endpoint - no auth required
 */
router.post('/validate/batch', async (req, res) => {
  try {
    const { cids } = req.body;
    
    if (!cids || !Array.isArray(cids) || cids.length === 0) {
      return res.status(400).json({ error: 'Array of CIDs required' });
    }

    // Limit batch size
    if (cids.length > 100) {
      return res.status(400).json({ error: 'Maximum 100 CIDs per batch' });
    }

    // Check if this node has MongoDB access (infrastructure node)
    const nodeType = process.env.NODE_TYPE || 'infrastructure';
    
    if (nodeType !== 'infrastructure') {
      return res.status(503).json({ 
        error: 'This node is not configured as a validation server',
        message: 'Please use an infrastructure node for CID validation'
      });
    }

    const mongo = getMongoDBClient();
    await mongo.connect();
    
    try {
      const results = await mongo.validateCIDs(cids);
      
      const validCount = results.filter(r => r.valid).length;
      logger.info(`Batch CID validation: ${validCount}/${cids.length} valid`);
      
      res.json({
        results,
        summary: {
          total: cids.length,
          valid: validCount,
          invalid: cids.length - validCount
        },
        timestamp: new Date().toISOString()
      });
    } finally {
      await mongo.disconnect();
    }
  } catch (error) {
    logger.error('Batch CID validation failed:', error);
    res.status(500).json({ 
      error: 'Validation failed',
      message: error.message
    });
  }
});

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
    
    const requestUrl = `${config.supernode.api}/api/v0/pin/ls?arg=${cid}`;
    logger.info(`🔍 SUPERNODE CHECK - Starting verification for CID: ${cid}`);
    logger.info(`   Request URL: ${requestUrl}`);
    logger.info(`   Supernode API: ${config.supernode.api}`);
    logger.info(`   Timeout: ${config.supernode.timeout_ms || 30000}ms`);
    
    // Check supernode - validateStatus allows us to handle all HTTP responses
    const response = await axios.post(
      requestUrl,
      null,
      {
        timeout: config.supernode.timeout_ms || 30000,
        validateStatus: () => true  // Don't throw on any status code
      }
    );
    
    logger.info(`📊 SUPERNODE RESPONSE - Status: ${response.status}`);
    logger.info(`   Response data type: ${typeof response.data}`);
    logger.info(`   Response data: ${JSON.stringify(response.data)}`);
    logger.info(`   Has Keys: ${!!(response.data && response.data.Keys)}`);
    logger.info(`   Has Message: ${!!(response.data && response.data.Message)}`);
    if (response.data && response.data.Keys) {
      logger.info(`   CID in Keys: ${!!(response.data.Keys[cid])}`);
      logger.info(`   Keys object: ${JSON.stringify(response.data.Keys)}`);
    }
    if (response.data && response.data.Message) {
      logger.info(`   Message: ${response.data.Message}`);
    }
    
    // Pin exists ONLY if Keys object contains the CID
    // Any error (permission denied, not pinned, etc) = NOT FOUND
    let exists = false;
    let reason = 'unknown';
    
    // Check if the response has valid data with Keys containing the CID
    // This is the ONLY way we consider a pin as "exists"
    if (response.data && response.data.Keys && response.data.Keys[cid]) {
      exists = true;
      reason = 'CID found in Keys object';
      logger.info(`✅ LOGIC BRANCH: ${reason}`);
    } else if (response.status !== 200) {
      // Non-200 status (500 permission denied, etc) = NOT FOUND
      exists = false;
      const msg = response.data?.Message || 'Unknown error';
      reason = `HTTP ${response.status}: ${msg}`;
      logger.info(`❌ LOGIC BRANCH: ${reason}`);
    } else if (response.data && response.data.Message) {
      // 200 with error message means NOT FOUND (not pinned, etc)
      exists = false;
      reason = `Error message: ${response.data.Message}`;
      logger.info(`❌ LOGIC BRANCH: ${reason}`);
    } else if (typeof response.data === 'string') {
      exists = !response.data.includes('not pinned');
      reason = `String response check: ${exists ? 'no "not pinned" text' : 'contains "not pinned"'}`;
      logger.info(`📝 LOGIC BRANCH: ${reason}`);
    } else {
      exists = false;
      reason = 'No Keys, no Message, not string - treating as NOT FOUND';
      logger.info(`⚠️  LOGIC BRANCH: ${reason}`);
    }
    
    logger.info(`🎯 FINAL RESULT for ${cid}: ${exists ? 'EXISTS ✅' : 'NOT FOUND ❌'}`);
    logger.info(`   Reason: ${reason}`);
    logger.info(`─────────────────────────────────────────────────────────────`);
    
    res.json({ success: true, exists, cid, reason });
  } catch (error) {
    logger.error('❌ SUPERNODE CHECK ERROR:', error.message);
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
    
    const db = getDatabase();
    const worker = migrationWorker.getMigrationWorker();
    
    // Get pin from database
    const pin = await db.getPin(cid);
    if (!pin) {
      return res.status(404).json({ error: 'Pin not found' });
    }
    
    // Check if already migrated
    if (pin.migrated) {
      return res.status(400).json({ error: 'Pin already migrated', message: 'This pin is already marked as migrated' });
    }
    
    logger.info(`Manual migration triggered for ${cid}`);
    
    // Attempt migration
    try {
      // First, check if pin already exists on supernode
      const alreadyPinned = await worker.verifySupernodePin(cid);
      
      if (alreadyPinned) {
        // Pin already exists on supernode, just mark as migrated
        logger.info(`Pin already exists on supernode: ${cid}`);
        
        await db.updatePin(cid, {
          migrated: 1,
          migrated_at: new Date().toISOString(),
          notes: 'Already pinned on supernode (manual check)'
        });
        
        return res.json({ 
          success: true, 
          cid,
          message: 'Pin already existed on supernode and has been marked as migrated'
        });
      } else {
        // Pin doesn't exist, add it to supernode
        logger.info(`Manual migration: ${cid} (${(pin.size_bytes / (1024 * 1024)).toFixed(2)}MB)`);
        await worker.pinToSupernode(cid, pin.size_bytes);
        
        // Wait a moment for pin to propagate
        await worker.sleep(2000);
        
        // Verify pin exists on supernode
        const verified = await worker.verifySupernodePin(cid);
        
        if (verified) {
          // Update database
          await db.updatePin(cid, {
            migrated: 1,
            migrated_at: new Date().toISOString(),
            notes: 'Manually migrated'
          });
          
          logger.info(`✓ Successfully migrated manually: ${cid}`);
          
          return res.json({ 
            success: true, 
            cid,
            message: 'Pin successfully migrated to supernode'
          });
        } else {
          throw new Error('Supernode verification failed after pinning');
        }
      }
    } catch (migrationError) {
      // Update retry count
      const newRetryCount = (pin.retry_count || 0) + 1;
      await db.updatePin(cid, {
        retry_count: newRetryCount,
        last_retry_at: new Date().toISOString(),
        notes: `Manual migration failed: ${migrationError.message}`
      });
      
      logger.error(`✗ Manual migration failed for ${cid}:`, migrationError.message);
      
      return res.status(500).json({ 
        error: 'Migration failed', 
        message: migrationError.message,
        cid
      });
    }
  } catch (error) {
    logger.error('Failed to migrate pin:', error);
    res.status(500).json({ error: 'Failed to migrate pin', message: error.message });
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
 * Trigger MongoDB validation of pending pins
 */
router.post('/validators/mongo', requireAuth, async (req, res) => {
  try {
    logger.info('Manual MongoDB validation triggered');
    
    // Run validator worker asynchronously
    mongoValidator.run()
      .then(result => {
        logger.info('Manual MongoDB validation completed:', result);
      })
      .catch(error => {
        logger.error('Manual MongoDB validation failed:', error);
      });
    
    res.json({ success: true, message: 'MongoDB validation started' });
  } catch (error) {
    logger.error('Failed to start MongoDB validation:', error);
    res.status(500).json({ error: 'Failed to start validation' });
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
 * Get comprehensive stats summary
 * Returns aggregated stats for 7, 30, and 90 day periods
 */
router.get('/stats/summary/all', async (req, res) => {
  try {
    const db = getDatabase();
    
    // Get migration stats for different periods
    const migration7 = await db.getMigrationStatsSummary(7);
    const migration30 = await db.getMigrationStatsSummary(30);
    const migration90 = await db.getMigrationStatsSummary(90);
    
    // Get cleanup stats for different periods
    const cleanup7 = await db.getCleanupStatsSummary(7);
    const cleanup30 = await db.getCleanupStatsSummary(30);
    const cleanup90 = await db.getCleanupStatsSummary(90);
    
    // Get pin stats
    const pinStats = await db.getPinStats();
    
    // Get system metrics average (last hour)
    const systemMetrics = await db.getSystemMetricsAverage(1);
    
    // Get recent GC logs
    const gcLogs = await db.getRecentGCLogs(10);
    
    res.json({
      pins: {
        total: pinStats.total || 0,
        pending: pinStats.pending || 0,
        pending_migration: pinStats.pending_migration || 0,
        migrated: pinStats.migrated || 0,
        invalid: pinStats.invalid || 0,
        overdue: pinStats.overdue || 0
      },
      migration: {
        days_7: {
          success: migration7?.total_success || 0,
          failures: migration7?.total_failures || 0,
          bytes_migrated: migration7?.total_bytes_migrated || 0,
          max_retries: migration7?.total_max_retries || 0
        },
        days_30: {
          success: migration30?.total_success || 0,
          failures: migration30?.total_failures || 0,
          bytes_migrated: migration30?.total_bytes_migrated || 0,
          max_retries: migration30?.total_max_retries || 0
        },
        days_90: {
          success: migration90?.total_success || 0,
          failures: migration90?.total_failures || 0,
          bytes_migrated: migration90?.total_bytes_migrated || 0,
          max_retries: migration90?.total_max_retries || 0
        }
      },
      cleanup: {
        days_7: {
          invalid_removed: cleanup7?.total_invalid_removed || 0,
          migrated_unpinned: cleanup7?.total_migrated_unpinned || 0,
          bytes_freed_invalid: cleanup7?.total_bytes_freed_invalid || 0,
          bytes_freed_migrated: cleanup7?.total_bytes_freed_migrated || 0,
          gc_runs: cleanup7?.total_gc_runs || 0,
          gc_duration: cleanup7?.total_gc_duration || 0,
          gc_bytes_freed: cleanup7?.total_gc_bytes_freed || 0
        },
        days_30: {
          invalid_removed: cleanup30?.total_invalid_removed || 0,
          migrated_unpinned: cleanup30?.total_migrated_unpinned || 0,
          bytes_freed_invalid: cleanup30?.total_bytes_freed_invalid || 0,
          bytes_freed_migrated: cleanup30?.total_bytes_freed_migrated || 0,
          gc_runs: cleanup30?.total_gc_runs || 0,
          gc_duration: cleanup30?.total_gc_duration || 0,
          gc_bytes_freed: cleanup30?.total_gc_bytes_freed || 0
        },
        days_90: {
          invalid_removed: cleanup90?.total_invalid_removed || 0,
          migrated_unpinned: cleanup90?.total_migrated_unpinned || 0,
          bytes_freed_invalid: cleanup90?.total_bytes_freed_invalid || 0,
          bytes_freed_migrated: cleanup90?.total_bytes_freed_migrated || 0,
          gc_runs: cleanup90?.total_gc_runs || 0,
          gc_duration: cleanup90?.total_gc_duration || 0,
          gc_bytes_freed: cleanup90?.total_gc_bytes_freed || 0
        }
      },
      system: {
        cpu_avg: systemMetrics?.avg_cpu || 0,
        cpu_max: systemMetrics?.max_cpu || 0,
        memory_avg: systemMetrics?.avg_memory || 0,
        memory_max: systemMetrics?.max_memory_used || 0,
        disk_avg: systemMetrics?.avg_disk || 0
      },
      gc_history: gcLogs
    });
  } catch (error) {
    logger.error('Failed to get stats summary:', error);
    res.status(500).json({ error: 'Failed to get stats summary' });
  }
});

/**
 * Get system metrics history
 */
router.get('/stats/system/:hours', async (req, res) => {
  try {
    const { hours = 24 } = req.params;
    const db = getDatabase();
    
    const metrics = await db.getSystemMetrics(parseInt(hours, 10));
    
    res.json({ metrics });
  } catch (error) {
    logger.error('Failed to get system metrics:', error);
    res.status(500).json({ error: 'Failed to get system metrics' });
  }
});

/**
 * Get migration stats history
 */
router.get('/stats/migration/:days', async (req, res) => {
  try {
    const { days = 30 } = req.params;
    const db = getDatabase();
    
    const stats = await db.getMigrationStats(parseInt(days, 10));
    
    res.json({ stats });
  } catch (error) {
    logger.error('Failed to get migration stats:', error);
    res.status(500).json({ error: 'Failed to get migration stats' });
  }
});

/**
 * Get cleanup stats history
 */
router.get('/stats/cleanup/:days', async (req, res) => {
  try {
    const { days = 30 } = req.params;
    const db = getDatabase();
    
    const stats = await db.getCleanupStats(parseInt(days, 10));
    
    res.json({ stats });
  } catch (error) {
    logger.error('Failed to get cleanup stats:', error);
    res.status(500).json({ error: 'Failed to get cleanup stats' });
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
 * Get recent log lines from combined.log
 */
router.get('/logs/recent', async (req, res) => {
  try {
    const { lines = 50 } = req.query;
    const fs = require('fs');
    const path = require('path');
    
    const logPath = path.join(__dirname, '..', 'logs', 'combined.log');
    
    if (!fs.existsSync(logPath)) {
      return res.json({ logs: [], message: 'No log file found' });
    }
    
    // Read last N lines efficiently
    const content = fs.readFileSync(logPath, 'utf8');
    const allLines = content.trim().split('\n');
    const recentLines = allLines.slice(-parseInt(lines, 10));
    
    // Parse JSON log lines
    const parsedLogs = recentLines.map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return { level: 'info', message: line, timestamp: '' };
      }
    }).reverse(); // Most recent first
    
    res.json({ logs: parsedLogs });
  } catch (error) {
    logger.error('Failed to get recent logs:', error);
    res.status(500).json({ error: 'Failed to get logs' });
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
