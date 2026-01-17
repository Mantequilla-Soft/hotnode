const { getDatabase } = require('../utils/database');
const { getMongoDBClient } = require('../utils/mongo');
const logger = require('../utils/logger');

/**
 * MongoDB Validator Worker
 * 
 * Validates pending CIDs against Traffic Director's MongoDB
 * to ensure they are legitimate encoder uploads
 * Frequency: Every 30 minutes
 */

class MongoValidator {
  constructor() {
    this.db = getDatabase();
    this.mongo = getMongoDBClient();
  }

  /**
   * Validate all pending pins against MongoDB
   */
  async validatePendingPins() {
    try {
      // Get all pending pins
      const pendingPins = await this.db.getPendingPins();
      
      if (pendingPins.length === 0) {
        logger.info('No pending pins to validate');
        return { validated: 0, valid: 0, invalid: 0 };
      }

      logger.info(`Validating ${pendingPins.length} pending pins...`);

      // Extract CIDs
      const cids = pendingPins.map(pin => pin.cid);

      // Batch validate against MongoDB
      const validationResults = await this.mongo.validateCIDs(cids);

      let validCount = 0;
      let invalidCount = 0;

      // Update pin statuses
      for (const result of validationResults) {
        const newStatus = result.valid ? 'valid' : 'invalid';
        
        await this.db.updatePin(result.cid, {
          status: newStatus
        });

        if (result.valid) {
          validCount++;
          logger.info(`✓ CID validated: ${result.cid}`);
        } else {
          invalidCount++;
          logger.warn(`✗ CID invalid (not in MongoDB): ${result.cid}`);
        }
      }

      const summary = {
        validated: pendingPins.length,
        valid: validCount,
        invalid: invalidCount
      };

      logger.info(`Validation complete: ${validCount} valid, ${invalidCount} invalid`);
      
      return summary;
    } catch (error) {
      logger.error('MongoDB validation failed:', error);
      throw error;
    }
  }

  /**
   * Run the MongoDB validator worker
   */
  async run() {
    try {
      // Ensure MongoDB connection
      await this.mongo.connect();

      const result = await this.validatePendingPins();
      
      // Log event
      await this.db.logEvent({
        event_type: 'mongodb_validation',
        severity: 'info',
        message: `Validated ${result.validated} pins: ${result.valid} valid, ${result.invalid} invalid`,
        metadata: result
      });

      return result;
    } catch (error) {
      await this.db.logEvent({
        event_type: 'mongodb_validation',
        severity: 'error',
        message: error.message
      });
      throw error;
    } finally {
      // Close MongoDB connection
      try {
        await this.mongo.disconnect();
      } catch (error) {
        logger.error('Failed to disconnect from MongoDB:', error);
      }
    }
  }
}

// Singleton instance
let instance = null;

function getMongoValidator() {
  if (!instance) {
    instance = new MongoValidator();
  }
  return instance;
}

// Export for worker execution
module.exports = {
  run: async () => {
    const validator = getMongoValidator();
    return await validator.run();
  },
  getMongoValidator
};
