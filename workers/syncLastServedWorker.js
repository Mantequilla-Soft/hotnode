const { getDatabase } = require('../utils/database');
const { getMongoDBClient } = require('../utils/mongo');
const logger = require('../utils/logger');
const config = require('../utils/config');

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
 * Because that fallback makes "no data" mean "eligible for cleanup", a run
 * that completes with zero errors records LAST_SYNC_OK_KEY; the cleanup
 * worker skips dormancy unpinning unless that timestamp is recent.
 *
 * Frequency: every RETENTION_SYNC_INTERVAL_HOURS (default 4).
 */
const LAST_SYNC_OK_KEY = 'last_served_sync_ok_at';

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
        await this.db.setConfig(LAST_SYNC_OK_KEY, new Date().toISOString());
        return summary;
      }

      // Uses the shared lazily-connected client - never disconnect it here,
      // other workers may be mid-query on the same singleton.
      const heatmapCount = await this.mongo.countHeatmaps();
      if (heatmapCount === 0) {
        throw new Error(
          `Heatmaps collection '${config.mongodb.collection_heatmaps}' is empty or missing - ` +
          'check MONGODB_COLLECTION_HEATMAPS'
        );
      }

      logger.info(`Syncing last-served time for ${pins.length} pins...`);

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

      logger.info(`Last-served sync complete: ${summary.updated}/${summary.checked} updated`);

      if (summary.errors.length === 0) {
        await this.db.setConfig(LAST_SYNC_OK_KEY, new Date().toISOString());
      }

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
  getSyncLastServedWorker,
  LAST_SYNC_OK_KEY
};
