const { getDatabase } = require('../utils/database');
const { getIPFSClient } = require('../utils/ipfs');
const logger = require('../utils/logger');
const { getDiscordNotifier } = require('../utils/discord');

/**
 * Healing Worker
 * 
 * Verifies overdue pins against supernode and updates database if already migrated
 * Frequency: Daily at 3am
 * Strategy: Serial checks with 10-second delays to avoid slamming supernode
 */

class HealingWorker {
  constructor() {
    this.db = getDatabase();
    this.ipfs = getIPFSClient();
    this.discord = getDiscordNotifier();
    this.checkDelay = 10000; // 10 seconds between checks
  }

  /**
   * Delay execution for specified milliseconds
   */
  async sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Main healing process
   * Checks overdue pins serially and updates database if found on supernode
   */
  async run() {
    logger.info('🩺 Starting healing worker...');
    const startTime = Date.now();
    
    try {
      // Get all overdue pins (migrated=0, age>7 days)
      const overduePins = await this.db.getOverduePins();
      
      if (overduePins.length === 0) {
        logger.info('✅ No overdue pins to heal');
        return {
          checked: 0,
          healed: 0,
          stillOverdue: 0,
          errors: 0
        };
      }

      logger.info(`Found ${overduePins.length} overdue pins to verify`);

      let healed = 0;
      let stillOverdue = 0;
      let errors = 0;

      // Process each pin serially with delay
      for (let i = 0; i < overduePins.length; i++) {
        const pin = overduePins[i];
        
        try {
          logger.info(`[${i + 1}/${overduePins.length}] Checking ${pin.cid}...`);
          
          // Check if pin exists on supernode
          const existsOnSupernode = await this.ipfs.verifySupernodePin(pin.cid);
          
          if (existsOnSupernode) {
            // Pin found on supernode - update database
            await this.db.updatePin(pin.cid, {
              migrated: 1,
              migrated_at: new Date().toISOString(),
              notes: 'Healed by healing worker - found on supernode'
            });
            
            healed++;
            logger.info(`✅ Healed: ${pin.cid} (found on supernode)`);
            
            // Log to activity log
            await this.db.logEvent({
              event_type: 'healing',
              severity: 'info',
              message: `Pin ${pin.cid} healed - found on supernode`,
              metadata: JSON.stringify({ cid: pin.cid, age_days: pin.age_days })
            });
          } else {
            stillOverdue++;
            logger.info(`⏳ Still overdue: ${pin.cid}`);
          }
        } catch (error) {
          errors++;
          logger.error(`❌ Error checking ${pin.cid}:`, error.message);
          
          await this.db.logEvent({
            event_type: 'healing_error',
            severity: 'error',
            message: `Healing check failed for ${pin.cid}`,
            metadata: JSON.stringify({ cid: pin.cid, error: error.message })
          });
        }
        
        // Delay before next check (except for last pin)
        if (i < overduePins.length - 1) {
          await this.sleep(this.checkDelay);
        }
      }

      const duration = Math.round((Date.now() - startTime) / 1000);
      const summary = {
        checked: overduePins.length,
        healed,
        stillOverdue,
        errors,
        duration_seconds: duration
      };

      logger.info(`🩺 Healing complete: ${healed} healed, ${stillOverdue} still overdue, ${errors} errors (${duration}s)`);

      // Send Discord notification if any pins were healed
      if (healed > 0) {
        await this.discord.sendNotification(
          '🩺 Healing Worker Report',
          [
            `**Healed Pins:** ${healed}`,
            `**Still Overdue:** ${stillOverdue}`,
            `**Errors:** ${errors}`,
            `**Duration:** ${duration}s`,
            '',
            `${healed} pins were found on supernode and marked as migrated.`
          ].join('\n'),
          healed > 10 ? 'warning' : 'info'
        );
      }

      // Log summary to activity log
      await this.db.logEvent({
        event_type: 'healing_complete',
        severity: 'info',
        message: `Healing worker completed: ${healed} healed, ${stillOverdue} still overdue`,
        metadata: JSON.stringify(summary)
      });

      return summary;

    } catch (error) {
      logger.error('❌ Healing worker error:', error);
      
      await this.db.logEvent({
        event_type: 'healing_error',
        severity: 'error',
        message: 'Healing worker failed',
        metadata: JSON.stringify({ error: error.message, stack: error.stack })
      });

      await this.discord.sendNotification(
        '❌ Healing Worker Error',
        `Healing worker failed: ${error.message}`,
        'error'
      );

      throw error;
    }
  }
}

// Create singleton instance
let instance = null;

function getHealingWorker() {
  if (!instance) {
    instance = new HealingWorker();
  }
  return instance;
}

module.exports = { HealingWorker, getHealingWorker };
