const { getDatabase } = require('../utils/database');
const { getIPFSClient } = require('../utils/ipfs');
const { getDiscordNotifier } = require('../utils/discord');
const logger = require('../utils/logger');

/**
 * Pin Discovery Worker
 * 
 * Scans IPFS for all pins and adds any new ones to the database
 * This ensures all pins in IPFS are tracked and can be validated/migrated
 * Frequency: Every hour
 */

class PinDiscoveryWorker {
  constructor() {
    this.db = getDatabase();
    this.ipfs = getIPFSClient();
    this.discord = getDiscordNotifier();
  }

  /**
   * Discover new pins from IPFS and add to database
   */
  async discoverNewPins() {
    try {
      // Get all pins from IPFS
      const pinsResult = await this.ipfs.pinLs();
      const ipfsPins = pinsResult.Keys || {};
      const ipfsCIDs = Object.keys(ipfsPins);
      
      if (ipfsCIDs.length === 0) {
        logger.info('No pins found in IPFS');
        return { scanned: 0, added: 0, alreadyExists: 0, errors: [] };
      }

      logger.info(`Found ${ipfsCIDs.length} pins in IPFS`);
      
      let added = 0;
      let alreadyExists = 0;
      const errors = [];
      
      // Process each CID
      for (const cid of ipfsCIDs) {
        try {
          // Check if already in database
          const existing = await this.db.getPin(cid);
          
          if (existing) {
            alreadyExists++;
            continue;
          }
          
          // Get size
          const size = await this.ipfs.getCIDSize(cid);
          
          // Add to database with pending status
          await this.db.insertPin({
            cid,
            size_bytes: size,
            status: 'pending',
            notes: 'Discovered by pin discovery worker'
          });
          
          added++;
          logger.info(`New pin discovered: ${cid} (${size} bytes)`);
          
        } catch (error) {
          errors.push(`${cid}: ${error.message}`);
          logger.error(`Failed to process CID ${cid}:`, error.message);
        }
      }
      
      const summary = {
        scanned: ipfsCIDs.length,
        added,
        alreadyExists,
        errors: errors.slice(0, 5)
      };
      
      if (added > 0) {
        logger.info(`Pin discovery complete: ${added} new pins added (${alreadyExists} already tracked)`);
      } else {
        logger.info(`Pin discovery complete: no new pins found (${alreadyExists} already tracked)`);
      }
      
      return summary;
    } catch (error) {
      logger.error('Pin discovery failed:', error);
      throw error;
    }
  }

  /**
   * Run the pin discovery worker
   */
  async run() {
    try {
      const result = await this.discoverNewPins();
      
      // Log event only if new pins were found or there were errors
      if (result.added > 0 || result.errors.length > 0) {
        await this.db.logEvent({
          event_type: 'pin_discovery',
          severity: result.errors.length > 0 ? 'warning' : 'info',
          message: `Discovered ${result.added} new pins (${result.scanned} total in IPFS)`,
          metadata: result
        });
      }

      // Send Discord notification if new pins were discovered
      if (result.added > 0) {
        await this.discord.notify(
          'Pin Discovery',
          `🔍 Discovered ${result.added} new pin(s) in IPFS`,
          'info'
        );
      }

      return result;
    } catch (error) {
      await this.db.logEvent({
        event_type: 'pin_discovery',
        severity: 'error',
        message: error.message
      });
      throw error;
    }
  }
}

// Export singleton instance
module.exports = new PinDiscoveryWorker();
