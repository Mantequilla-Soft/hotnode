const axios = require('axios');
const config = require('./config');
const logger = require('./logger');

/**
 * Validation Client
 * 
 * For community nodes to validate CIDs via remote API
 * instead of direct MongoDB access
 */

class ValidationClient {
  constructor() {
    this.serverUrl = process.env.VALIDATION_SERVER_URL || config.validation?.server_url || 'https://admin-hotipfs-1.3speak.tv';
    this.timeout = 30000;
  }

  /**
   * Validate a single CID via remote API
   */
  async validateCID(cid) {
    try {
      const response = await axios.post(
        `${this.serverUrl}/api/validate/cid/${cid}`,
        {},
        {
          timeout: this.timeout,
          headers: {
            'Content-Type': 'application/json'
          }
        }
      );

      return response.data.valid;
    } catch (error) {
      if (error.response) {
        logger.error(`Validation API error for ${cid}: ${error.response.status} ${error.response.statusText}`);
      } else if (error.request) {
        logger.error(`Validation API timeout for ${cid}: No response from server`);
      } else {
        logger.error(`Validation request error for ${cid}:`, error.message);
      }
      throw error;
    }
  }

  /**
   * Batch validate multiple CIDs via remote API
   */
  async validateCIDs(cids) {
    try {
      logger.info(`Validating ${cids.length} CIDs via remote API: ${this.serverUrl}`);

      const response = await axios.post(
        `${this.serverUrl}/api/validate/batch`,
        { cids },
        {
          timeout: this.timeout,
          headers: {
            'Content-Type': 'application/json'
          }
        }
      );

      logger.info(`Batch validation complete: ${response.data.summary.valid}/${response.data.summary.total} valid`);

      return response.data.results;
    } catch (error) {
      if (error.response) {
        logger.error(`Batch validation API error: ${error.response.status} ${error.response.statusText}`);
        logger.error('Response data:', error.response.data);
      } else if (error.request) {
        logger.error('Batch validation API timeout: No response from server');
      } else {
        logger.error('Batch validation request error:', error.message);
      }
      throw error;
    }
  }

  /**
   * Check if validation server is accessible
   */
  async healthCheck() {
    try {
      const response = await axios.get(
        `${this.serverUrl}/health`,
        { timeout: 5000 }
      );

      return response.status === 200;
    } catch (error) {
      logger.warn(`Validation server health check failed: ${this.serverUrl}`);
      return false;
    }
  }
}

// Singleton instance
let instance = null;

function getValidationClient() {
  if (!instance) {
    instance = new ValidationClient();
  }
  return instance;
}

module.exports = {
  ValidationClient,
  getValidationClient
};
