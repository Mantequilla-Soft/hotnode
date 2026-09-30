const { getDatabase } = require('../utils/database');
const { getMongoDBClient } = require('../utils/mongo');
const logger = require('../utils/logger');

/**
 * Sync Last-Served Worker
 *
 * Pulls last_served_at for every tracked pin from Mongo's view-heatmaps
 * collection (owned by the player - see mongo.js's getLastServedAt for why
 * that's the right source) into the local pins table, where
 * getDormantPinsForCleanup() can use it without a live cross-DB join on
 * every cleanup run.
 *
 * A pin with no matching heatmap doc (never watched, or not synced yet) is
 * left alone - getDormantPinsForCleanup() falls back to added_at for NULL
 * last_served_at, so this is safe to skip rather than write a guess.
 *
 * Frequency: every RETENTION_SYNC_INTERVAL_HOURS (default 4).
 */
class SyncLastServedWorker {
  constructor() {
    this.db = getDatabase();
    this.mongo = getMongoDBClient();
  }

  async run() {
    const summary = { checked: 0, updated: 0, errors: [] };

    try {
      const pins = await this.db.getPinsForServedSync();

      if (pins.length === 0) {
        logger.info('No pins with a known video identity to sync');
        return summary;
      }

      logger.info(`Syncing last-served time for ${pins.length} pins...`);
      await this.mongo.connect();

      try {
        for (const pin of pins) {
          summary.checked++;
          try {
            const lastServedAt = await this.mongo.getLastServedAt(pin.owner, pin.permlink);
            if (lastServedAt) {
              await this.db.updatePinServedAt(pin.cid, new Date(lastServedAt).toISOString());
              summary.updated++;
            }
          } catch (error) {
            summary.errors.push(`${pin.cid}: ${error.message}`);
            logger.error(`Failed to sync last-served for ${pin.cid}:`, error.message);
          }
        }
      } finally {
        await this.mongo.disconnect();
      }

      logger.info(`Last-served sync complete: ${summary.updated}/${summary.checked} updated`);

      if (summary.errors.length > 0) {
        await this.db.logEvent({
          event_type: 'sync_last_served',
          severity: 'warning',
          message: `Synced ${summary.updated}/${summary.checked} pins, ${summary.errors.length} errors`,
          metadata: summary
        });
      }

      return summary;
    } catch (error) {
      logger.error('Sync last-served worker failed:', error);
      await this.db.logEvent({
        event_type: 'sync_last_served',
        severity: 'error',
        message: error.message
      });
      throw error;
    }
  }
}

let instance = null;
function getSyncLastServedWorker() {
  if (!instance) {
    instance = new SyncLastServedWorker();
  }
  return instance;
}

module.exports = {
  run: async () => getSyncLastServedWorker().run(),
  getSyncLastServedWorker
};
