const axios = require('axios');
const { getDatabase } = require('../utils/database');
const { getIPFSClient } = require('../utils/ipfs');
const { getDiscordNotifier } = require('../utils/discord');
const logger = require('../utils/logger');
const config = require('../config.json');

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
   */
  async pinToSupernode(cid) {
    try {
      // Pin to supernode
      const response = await axios.post(
        `${this.supernodeAPI}/api/v0/pin/add`,
        null,
        {
          params: {
            arg: cid,
            recursive: true
          },
          timeout: config.supernode.timeout_ms || 30000
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
        `${this.supernodeAPI}/api/v0/pin/ls`,
        null,
        {
          params: {
            arg: cid,
            type: 'recursive'
          },
          timeout: config.supernode.timeout_ms || 30000
        }
      );

      // Check if CID exists in response
      return response.data.Keys && response.data.Keys[cid] !== undefined;
    } catch (error) {
      logger.error(`Supernode verification failed for ${cid}:`, error.message);
      return false;
    }
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

          // Pin to supernode
          await this.pinToSupernode(pin.cid);

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
      
      // Log event
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
