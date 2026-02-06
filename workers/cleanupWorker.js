const { getDatabase } = require('../utils/database');
const { getIPFSClient } = require('../utils/ipfs');
const { getDiscordNotifier } = require('../utils/discord');
const logger = require('../utils/logger');
const config = require('../utils/config');

/**
 * Cleanup Worker
 * 
 * Unpins migrated and invalid content, runs garbage collection
 * Frequency: Daily at 2 AM (configurable)
 */

class CleanupWorker {
  constructor() {
    this.db = getDatabase();
    this.ipfs = getIPFSClient();
    this.discord = getDiscordNotifier();
    this.deleteDays = config.migration.delete_after_days;
    this.invalidRetentionDays = config.cleanup.invalid_retention_days;
  }

  /**
   * Unpin migrated content (older than 7 days)
   */
  async unpinMigratedContent() {
    try {
      const pins = await this.db.getMigratedPinsForCleanup(this.deleteDays);
      
      if (pins.length === 0) {
        logger.info('No migrated pins to unpin');
        return { unpinned: 0, bytesFreed: 0, errors: [] };
      }

      logger.info(`Found ${pins.length} migrated pins to unpin`);

      let unpinned = 0;
      let bytesFreed = 0;
      const errors = [];

      for (const pin of pins) {
        try {
          // Unpin from hot node
          await this.ipfs.pinRm(pin.cid);
          
          // Update database
          await this.db.updatePin(pin.cid, {
            unpinned: 1,
            unpinned_at: new Date().toISOString()
          });

          unpinned++;
          bytesFreed += pin.size_bytes || 0;
          logger.info(`Unpinned migrated: ${pin.cid}`);
        } catch (error) {
          errors.push(`${pin.cid}: ${error.message}`);
          logger.error(`Failed to unpin ${pin.cid}:`, error.message);
        }
      }

      logger.info(`Unpinned ${unpinned} migrated pins, freed ${bytesFreed} bytes`);
      return { unpinned, bytesFreed, errors };
    } catch (error) {
      logger.error('Failed to unpin migrated content:', error);
      throw error;
    }
  }

  /**
   * Unpin and delete invalid content
   */
  async cleanupInvalidContent() {
    try {
      const pins = await this.db.getInvalidPinsForCleanup(this.invalidRetentionDays);
      
      if (pins.length === 0) {
        logger.info('No invalid pins to cleanup');
        return { cleaned: 0, bytesFreed: 0, errors: [] };
      }

      logger.info(`Found ${pins.length} invalid pins to cleanup`);

      let cleaned = 0;
      let bytesFreed = 0;
      const errors = [];

      for (const pin of pins) {
        try {
          // Try to unpin (may not exist)
          try {
            await this.ipfs.pinRm(pin.cid);
          } catch (error) {
            // Pin might not exist, that's okay
            logger.debug(`Pin not found for removal: ${pin.cid}`);
          }
          
          // Delete from database
          await this.db.deletePin(pin.cid);

          cleaned++;
          bytesFreed += pin.size_bytes || 0;
          logger.info(`Cleaned invalid: ${pin.cid}`);
        } catch (error) {
          errors.push(`${pin.cid}: ${error.message}`);
          logger.error(`Failed to cleanup ${pin.cid}:`, error.message);
        }
      }

      logger.info(`Cleaned up ${cleaned} invalid pins, freed ${bytesFreed} bytes`);
      return { cleaned, bytesFreed, errors };
    } catch (error) {
      logger.error('Failed to cleanup invalid content:', error);
      throw error;
    }
  }

  /**
   * Run IPFS garbage collection
   */
  async runGarbageCollection() {
    try {
      logger.info('Starting IPFS garbage collection...');
      
      const startTime = Date.now();
      
      // Get repo size before GC
      const statBefore = await this.ipfs.repoStat();
      const sizeBefore = statBefore.RepoSize || 0;
      
      // Run GC
      await this.ipfs.repoGC();
      
      // Get repo size after GC
      const statAfter = await this.ipfs.repoStat();
      const sizeAfter = statAfter.RepoSize || 0;
      
      const duration = Math.floor((Date.now() - startTime) / 1000);
      const freed = Math.max(0, sizeBefore - sizeAfter);
      
      logger.info(`GC complete: freed ${freed} bytes in ${duration}s`);
      
      // Log to database
      await this.db.insertGCLog({
        duration_seconds: duration,
        freed_bytes: freed
      });

      // Send Discord notification
      await this.discord.notifyGCComplete(duration, freed);
      
      return { duration, freed, sizeBefore, sizeAfter };
    } catch (error) {
      logger.error('Garbage collection failed:', error);
      
      // Log error
      await this.db.insertGCLog({
        duration_seconds: 0,
        freed_bytes: 0,
        error: error.message
      });

      // Send Discord notification
      await this.discord.notifyGCComplete(0, 0, error.message);
      
      throw error;
    }
  }

  /**
   * Check for overdue pins and notify
   */
  async checkOverduePins() {
    try {
      const stats = await this.db.getPinStats();
      
      if (stats.overdue > 0) {
        logger.warn(`Found ${stats.overdue} overdue pins (>7 days, not migrated)`);
        
        // Get oldest overdue pin age
        const oldestPin = await this.db.get(`
          SELECT julianday('now') - julianday(added_at) as age
          FROM pins
          WHERE julianday('now') - julianday(added_at) > 7
          AND migrated = 0
          ORDER BY added_at ASC
          LIMIT 1
        `);
        
        const oldestAge = oldestPin ? Math.floor(oldestPin.age) : 0;
        
        // Send Discord notification
        await this.discord.notifyOverduePins(stats.overdue, oldestAge);
        
        return { overdue: stats.overdue, oldestAge };
      }
      
      return { overdue: 0, oldestAge: 0 };
    } catch (error) {
      logger.error('Failed to check overdue pins:', error);
      return { overdue: 0, oldestAge: 0 };
    }
  }

  /**
   * Run the cleanup worker
   */
  async run() {
    const summary = {
      migrated_unpinned: 0,
      invalid_cleaned: 0,
      bytes_freed_migrated: 0,
      bytes_freed_invalid: 0,
      gc_freed_bytes: 0,
      gc_duration: 0,
      overdue_pins: 0,
      errors: []
    };

    try {
      // Unpin migrated content
      const migratedResult = await this.unpinMigratedContent();
      summary.migrated_unpinned = migratedResult.unpinned;
      summary.bytes_freed_migrated = migratedResult.bytesFreed || 0;
      summary.errors.push(...migratedResult.errors);

      // Cleanup invalid content
      const invalidResult = await this.cleanupInvalidContent();
      summary.invalid_cleaned = invalidResult.cleaned;
      summary.bytes_freed_invalid = invalidResult.bytesFreed || 0;
      summary.errors.push(...invalidResult.errors);

      // Run garbage collection
      const gcResult = await this.runGarbageCollection();
      summary.gc_freed_bytes = gcResult.freed;
      summary.gc_duration = gcResult.duration;

      // Check for overdue pins
      const overdueResult = await this.checkOverduePins();
      summary.overdue_pins = overdueResult.overdue;

      // Update last run time
      await this.db.setConfig('last_gc_run', new Date().toISOString());
      
      // Update cleanup stats for today
      const today = new Date().toISOString().split('T')[0];
      await this.db.updateCleanupStats(today, {
        invalid_pins_removed: summary.invalid_cleaned,
        migrated_pins_unpinned: summary.migrated_unpinned,
        bytes_freed_invalid: summary.bytes_freed_invalid,
        bytes_freed_migrated: summary.bytes_freed_migrated,
        gc_runs: 1,
        gc_duration_seconds: summary.gc_duration,
        gc_bytes_freed: summary.gc_freed_bytes
      });
      
      // Log detailed events
      if (summary.migrated_unpinned > 0) {
        await this.db.logEvent({
          event_type: 'cleanup_migrated',
          severity: 'info',
          message: `Unpinned ${summary.migrated_unpinned} migrated pins (${(summary.bytes_freed_migrated / (1024 * 1024 * 1024)).toFixed(2)} GB)`,
          metadata: { count: summary.migrated_unpinned, bytes: summary.bytes_freed_migrated }
        });
      }
      
      if (summary.invalid_cleaned > 0) {
        await this.db.logEvent({
          event_type: 'cleanup_invalid',
          severity: 'info',
          message: `Cleaned ${summary.invalid_cleaned} invalid pins (${(summary.bytes_freed_invalid / (1024 * 1024 * 1024)).toFixed(2)} GB)`,
          metadata: { count: summary.invalid_cleaned, bytes: summary.bytes_freed_invalid }
        });
      }
      
      if (summary.gc_freed_bytes > 0) {
        await this.db.logEvent({
          event_type: 'gc_complete',
          severity: 'info',
          message: `GC freed ${(summary.gc_freed_bytes / (1024 * 1024 * 1024)).toFixed(2)} GB in ${summary.gc_duration}s`,
          metadata: { freed: summary.gc_freed_bytes, duration: summary.gc_duration }
        });
      }
      
      // Log event (summary)
      await this.db.logEvent({
        event_type: 'cleanup',
        severity: summary.errors.length > 0 ? 'warning' : 'info',
        message: `Cleanup complete: unpinned ${summary.migrated_unpinned}, cleaned ${summary.invalid_cleaned}, freed ${summary.gc_freed_bytes} bytes`,
        metadata: summary
      });

      logger.info('Cleanup worker complete:', summary);
      
      return summary;
    } catch (error) {
      await this.db.logEvent({
        event_type: 'cleanup',
        severity: 'error',
        message: error.message
      });
      throw error;
    }
  }
}

// Singleton instance
let instance = null;

function getCleanupWorker() {
  if (!instance) {
    instance = new CleanupWorker();
  }
  return instance;
}

// Export for worker execution
module.exports = {
  run: async () => {
    const worker = getCleanupWorker();
    return await worker.run();
  },
  getCleanupWorker
};
