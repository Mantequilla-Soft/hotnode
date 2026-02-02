const { getDatabase } = require('../utils/database');
const { getMongoDBClient } = require('../utils/mongo');
const { getValidationClient } = require('../utils/validationClient');
const logger = require('../utils/logger');

/**
 * MongoDB Validator Worker
 * 
 * Validates pending CIDs against Traffic Director's MongoDB
 * to ensure they are legitimate encoder uploads
 * 
 * Infrastructure nodes: Direct MongoDB access
 * Community nodes: Remote validation API
 * 
 * Frequency: Every 30 minutes
 */

class MongoValidator {
  constructor() {
    this.db = getDatabase();
    this.nodeType = process.env.NODE_TYPE || 'infrastructure';
    
    // Use appropriate validation method based on node type
    if (this.nodeType === 'infrastructure') {
      this.mongo = getMongoDBClient();
      this.validationClient = null;
      logger.info('Validator initialized for INFRASTRUCTURE node (MongoDB access)');
    } else {
      this.mongo = null;
      this.validationClient = getValidationClient();
      logger.info('Validator initialized for COMMUNITY node (remote API)');
    }
  }

  /**
   * Validate all pending pins against MongoDB or remote API
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

      // Batch validate using appropriate method
      let validationResults;
      
      if (this.nodeType === 'infrastructure') {
        // Infrastructure node: Use MongoDB directly
        await this.mongo.connect();
        try {
          validationResults = await this.mongo.validateCIDs(cids);
        } finally {
          await this.mongo.disconnect();
        }
      } else {
        // Community node: Use remote validation API
        validationResults = await this.validationClient.validateCIDs(cids);
      }

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
        invalid: invalidCount,
        method: this.nodeType === 'infrastructure' ? 'mongodb' : 'api'
      };

      logger.info(`Validation complete: ${validCount} valid, ${invalidCount} invalid (via ${summary.method})`);
      
      return summary;
    } catch (error) {
      logger.error('CID validation failed:', error);
      throw error;
    }
  }

  /**
   * Run the MongoDB validator worker
   */
  async run() {
    try {
      const result = await this.validatePendingPins();
      
      // Log event
      await this.db.logEvent({
        event_type: 'cid_validation',
        severity: 'info',
        message: `Validated ${result.validated} pins: ${result.valid} valid, ${result.invalid} invalid (${result.method})`,
        metadata: result
      });

      return result;
    } catch (error) {
      await this.db.logEvent({
        event_type: 'cid_validation',
        severity: 'error',
        message: error.message
      });
      throw error;
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
