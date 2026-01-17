const fs = require('fs');
const { Tail } = require('tail');
const { getDatabase } = require('../utils/database');
const { getIPFSClient } = require('../utils/ipfs');
const logger = require('../utils/logger');
const config = require('../config.json');

/**
 * Log Parser Worker
 * 
 * Parses nginx access logs to identify new IPFS uploads
 * Frequency: Every 5 minutes
 */

class LogParser {
  constructor() {
    this.logPath = config.nginx.log_path;
    this.db = getDatabase();
    this.ipfs = getIPFSClient();
    this.lastOffset = 0;
  }

  /**
   * Extract CID from nginx log entry
   * Looks for /api/v0/add requests and extracts the response CID
   */
  extractCIDFromLog(logLine) {
    try {
      // Check if this is an add request
      if (!logLine.includes('/api/v0/add')) {
        return null;
      }

      // Check if request was successful (2xx status)
      const statusMatch = logLine.match(/\s(\d{3})\s/);
      if (!statusMatch || !statusMatch[1].startsWith('2')) {
        return null;
      }

      // Try to extract CID from response body
      // IPFS add responses contain: {"Name":"","Hash":"Qm..."}
      const cidMatch = logLine.match(/"Hash":"([A-Za-z0-9]+)"/);
      if (cidMatch && cidMatch[1]) {
        return cidMatch[1];
      }

      return null;
    } catch (error) {
      logger.error('Failed to extract CID from log:', error);
      return null;
    }
  }

  /**
   * Parse new log entries since last run
   */
  async parseNewLogs() {
    try {
      // Get last offset from database
      const lastOffsetStr = await this.db.getConfig('log_parse_offset');
      this.lastOffset = parseInt(lastOffsetStr || '0', 10);

      // Check if log file exists
      if (!fs.existsSync(this.logPath)) {
        logger.warn(`Log file not found: ${this.logPath}`);
        return { processed: 0, added: 0 };
      }

      // Get file stats
      const stats = fs.statSync(this.logPath);
      const fileSize = stats.size;

      // If offset is beyond file size, reset (log rotation)
      if (this.lastOffset > fileSize) {
        logger.info('Log file rotated, resetting offset');
        this.lastOffset = 0;
      }

      // Read new content
      const stream = fs.createReadStream(this.logPath, {
        start: this.lastOffset,
        encoding: 'utf8'
      });

      let buffer = '';
      let processedLines = 0;
      let addedPins = 0;
      const foundCIDs = new Set();

      return new Promise((resolve, reject) => {
        stream.on('data', (chunk) => {
          buffer += chunk;
          const lines = buffer.split('\n');
          buffer = lines.pop(); // Keep incomplete line in buffer

          for (const line of lines) {
            if (line.trim()) {
              processedLines++;
              const cid = this.extractCIDFromLog(line);
              if (cid && !foundCIDs.has(cid)) {
                foundCIDs.add(cid);
              }
            }
          }
        });

        stream.on('end', async () => {
          // Process last line if any
          if (buffer.trim()) {
            const cid = this.extractCIDFromLog(buffer);
            if (cid && !foundCIDs.has(cid)) {
              foundCIDs.add(cid);
            }
          }

          // Add discovered CIDs to database
          for (const cid of foundCIDs) {
            try {
              // Get CID size from IPFS
              const size = await this.ipfs.getCIDSize(cid);
              
              await this.db.insertPin({
                cid,
                size_bytes: size,
                status: 'pending'
              });

              addedPins++;
              logger.info(`Added new pin: ${cid} (${size} bytes)`);
            } catch (error) {
              logger.error(`Failed to add pin ${cid}:`, error.message);
            }
          }

          // Update offset
          const newOffset = this.lastOffset + stream.bytesRead;
          await this.db.setConfig('log_parse_offset', newOffset.toString());

          logger.info(`Log parser: processed ${processedLines} lines, added ${addedPins} new pins`);
          resolve({ processed: processedLines, added: addedPins });
        });

        stream.on('error', (error) => {
          logger.error('Log parsing error:', error);
          reject(error);
        });
      });
    } catch (error) {
      logger.error('Log parser failed:', error);
      throw error;
    }
  }

  /**
   * Run the log parser worker
   */
  async run() {
    try {
      const result = await this.parseNewLogs();
      
      // Log event
      await this.db.logEvent({
        event_type: 'log_parse',
        severity: 'info',
        message: `Processed ${result.processed} log lines, added ${result.added} pins`,
        metadata: result
      });

      return result;
    } catch (error) {
      await this.db.logEvent({
        event_type: 'log_parse',
        severity: 'error',
        message: error.message
      });
      throw error;
    }
  }
}

// Singleton instance
let instance = null;

function getLogParser() {
  if (!instance) {
    instance = new LogParser();
  }
  return instance;
}

// Export for worker execution
module.exports = {
  run: async () => {
    const parser = getLogParser();
    return await parser.run();
  },
  getLogParser
};
