const axios = require('axios');
const { getDatabase } = require('../utils/database');
const { getIPFSClient } = require('../utils/ipfs');
const { getDiscordNotifier } = require('../utils/discord');
const logger = require('../utils/logger');
const config = require('../utils/config');

/**
 * Migration Worker
 * 
 * Migrates old valid pins to supernode
 * Frequency: Every 12 hours
 * Strategy: Oldest first, throttled bandwidth
 */

class MigrationWorker {
  constructor() {
    this.db = getDatabase();
    this.ipfs = getIPFSClient();
    this.discord = getDiscordNotifier();
    this.supernodeAPI = config.supernode.api;
    this.startAfterDays = config.migration.start_after_days;
    this.batchSize = config.migration.batch_size;
    this.throttleDelay = config.migration.throttle_delay_ms;
    this.maxRetries = config.migration.max_retries || 10;
  }

  /**
   * Pin a CID to supernode
   * @param {string} cid - Content identifier to pin
   * @param {number} sizeBytes - File size in bytes (for timeout calculation)
   */
  async pinToSupernode(cid, sizeBytes = null) {
    try {
      // Calculate dynamic timeout based on file size
      const timeout = this.calculateTimeout(sizeBytes);
      
      // Pin to supernode
      const response = await axios.post(
        `${this.supernodeAPI}/api/v0/pin/add`,
        null,
        {
          params: {
            arg: cid,
            recursive: true
          },
          timeout
        }
      );

      logger.info(`Pinned to supernode: ${cid}`);
      return response.data;
    } catch (error) {
      throw new Error(`Supernode pin failed: ${error.message}`);
    }
  }

  /**
   * Verify CID is pinned on supernode
   */
  async verifySupernodePin(cid) {
    try {
      const response = await axios.post(
        `${this.supernodeAPI}/api/v0/pin/ls?arg=${cid}`,
        null,
        {
          timeout: config.supernode.timeout_ms || 30000
        }
      );

      // Pin exists ONLY if Keys object contains the CID
      // Any error or missing Keys = NOT FOUND
      if (response.status === 200 && response.data && response.data.Keys && response.data.Keys[cid]) {
        return true;
      }
      
      // Any other response = NOT FOUND (including errors, permission denied, etc)
      return false;
    } catch (error) {
      logger.error(`Supernode verification failed for ${cid}:`, error.message);
      return false;
    }
  }

  /**
   * Calculate dynamic timeout based on file size
   * Base timeout + additional time per MB
   * Adjusted for slower HDD/SDD storage on supernode
   * @param {number} sizeBytes - File size in bytes
   * @returns {number} - Timeout in milliseconds
   */
  calculateTimeout(sizeBytes) {
    const baseTimeout = 60000; // 60 seconds base (increased for slower storage)
    
    if (!sizeBytes || sizeBytes <= 0) {
      return baseTimeout;
    }
    
    const mbSize = sizeBytes / (1024 * 1024);
    
    // Add 30 seconds per 100MB (increased for HDD/SDD performance)
    const additionalTimeout = Math.ceil(mbSize / 100) * 30000;
    
    // Cap at 20 minutes for very large files
    const maxTimeout = 1200000;
    
    const calculatedTimeout = baseTimeout + additionalTimeout;
    const finalTimeout = Math.min(calculatedTimeout, maxTimeout);
    
    logger.info(`Calculated timeout for ${mbSize.toFixed(2)}MB: ${finalTimeout}ms`);
    
    return finalTimeout;
  }

  /**
   * Sleep for throttling
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Migrate eligible pins to supernode
   */
  async migratePins() {
    try {
      // Get pins eligible for migration
      const pins = await this.db.getValidPinsForMigration(
        this.startAfterDays,
        this.batchSize
      );

      if (pins.length === 0) {
        logger.info('No pins eligible for migration');
        return { processed: 0, succeeded: 0, failed: 0, errors: [] };
      }

      logger.info(`Found ${pins.length} pins eligible for migration`);

      let succeeded = 0;
      let failed = 0;
      const errors = [];

      for (const pin of pins) {
        try {
          logger.info(`Migrating: ${pin.cid} (age: ${Math.floor((Date.now() - new Date(pin.added_at)) / (1000 * 60 * 60 * 24))} days)`);

          // First, check if pin already exists on supernode
          const alreadyPinned = await this.verifySupernodePin(pin.cid);

          if (alreadyPinned) {
            // Pin already exists on supernode, just mark as migrated
            logger.info(`Pin already exists on supernode: ${pin.cid}`);
            
            await this.db.updatePin(pin.cid, {
              migrated: 1,
              migrated_at: new Date().toISOString(),
              notes: 'Already pinned on supernode'
            });

            succeeded++;
            logger.info(`✓ Marked as migrated (already existed): ${pin.cid}`);
          } else {
            // Pin doesn't exist, add it to supernode
            logger.info(`Migrating ${pin.cid}: ${(pin.size_bytes / (1024 * 1024)).toFixed(2)}MB`);
            await this.pinToSupernode(pin.cid, pin.size_bytes);

            // Wait a moment for pin to propagate
            await this.sleep(2000);

            // Verify pin exists on supernode
            const verified = await this.verifySupernodePin(pin.cid);

            if (verified) {
              // Update database
              await this.db.updatePin(pin.cid, {
                migrated: 1,
                migrated_at: new Date().toISOString()
              });

              succeeded++;
              logger.info(`✓ Successfully migrated: ${pin.cid}`);
            } else {
              throw new Error('Supernode verification failed');
            }
          }

          // Throttle to avoid overwhelming supernode
          await this.sleep(this.throttleDelay);

        } catch (error) {
          failed++;
          const errorMsg = `${pin.cid}: ${error.message}`;
          errors.push(errorMsg);
          logger.error(`✗ Migration failed for ${pin.cid}:`, error.message);

          // Update retry count
          const newRetryCount = (pin.retry_count || 0) + 1;
          await this.db.updatePin(pin.cid, {
            retry_count: newRetryCount,
            last_retry_at: new Date().toISOString(),
            notes: error.message
          });

          // Notify if max retries reached
          if (newRetryCount >= this.maxRetries) {
            logger.error(`Max retries reached for ${pin.cid}`);
          }
        }
      }

      // Send Discord notification if there were failures
      if (failed > 0 && errors.length > 0) {
        await this.discord.notifyMigrationErrors(errors.slice(0, 10));
      }

      const summary = {
        processed: pins.length,
        succeeded,
        failed,
        errors: errors.slice(0, 5) // Limit errors in return
      };

      logger.info(`Migration complete: ${succeeded} succeeded, ${failed} failed`);
      
      return summary;
    } catch (error) {
      logger.error('Migration worker failed:', error);
      throw error;
    }
  }

  /**
   * Run the migration worker
   */
  async run() {
    try {
      const result = await this.migratePins();
      
      // Update last run time
      await this.db.setConfig('last_migration_run', new Date().toISOString());
      
      // Calculate total bytes migrated for today
      const pins = await this.db.getValidPinsForMigration(this.startAfterDays, this.batchSize);
      let bytesMigrated = 0;
      let maxRetriesReached = 0;
      
      for (const pin of pins) {
        if (pin.migrated) {
          bytesMigrated += pin.size_bytes || 0;
        }
        if ((pin.retry_count || 0) >= this.maxRetries) {
          maxRetriesReached++;
        }
      }
      
      // Update migration stats for today
      const today = new Date().toISOString().split('T')[0];
      await this.db.updateMigrationStats(today, {
        success_count: result.succeeded,
        failure_count: result.failed,
        bytes_migrated: bytesMigrated,
        max_retries_reached: maxRetriesReached
      });
      
      // Log detailed events
      if (result.succeeded > 0) {
        await this.db.logEvent({
          event_type: 'migration_success',
          severity: 'info',
          message: `Successfully migrated ${result.succeeded} pins (${(bytesMigrated / (1024 * 1024 * 1024)).toFixed(2)} GB)`,
          metadata: { count: result.succeeded, bytes: bytesMigrated }
        });
      }
      
      if (result.failed > 0) {
        await this.db.logEvent({
          event_type: 'migration_failure',
          severity: 'warning',
          message: `Failed to migrate ${result.failed} pins`,
          metadata: { count: result.failed, errors: result.errors }
        });
      }
      
      // Log event (summary)
      await this.db.logEvent({
        event_type: 'migration',
        severity: result.failed > 0 ? 'warning' : 'info',
        message: `Migrated ${result.succeeded}/${result.processed} pins to supernode`,
        metadata: result
      });

      return result;
    } catch (error) {
      await this.db.logEvent({
        event_type: 'migration',
        severity: 'error',
        message: error.message
      });
      throw error;
    }
  }
}

// Singleton instance
let instance = null;

function getMigrationWorker() {
  if (!instance) {
    instance = new MigrationWorker();
  }
  return instance;
}

// Export for worker execution
module.exports = {
  run: async () => {
    const worker = getMigrationWorker();
    return await worker.run();
  },
  getMigrationWorker
};
