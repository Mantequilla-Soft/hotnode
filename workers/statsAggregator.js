const fs = require('fs');
const { getDatabase } = require('../utils/database');
const { getIPFSClient } = require('../utils/ipfs');
const { getDiscordNotifier } = require('../utils/discord');
const logger = require('../utils/logger');
const config = require('../utils/config');

/**
 * Stats Aggregator Worker
 * 
 * Collects bandwidth and repository statistics
 * Also monitors IPFS daemon health
 * Frequency: Every hour
 */

class StatsAggregator {
  constructor() {
    this.db = getDatabase();
    this.ipfs = getIPFSClient();
    this.discord = getDiscordNotifier();
    this.logPath = config.nginx.log_path;
    this.retentionDays = config.stats.retention_days;
  }

  /**
   * Parse nginx logs for bandwidth stats
   * Only tracks IPFS gateway requests (actual content delivery)
   * Excludes internal monitoring and attack attempts
   */
  async parseNginxStats() {
    try {
      if (!fs.existsSync(this.logPath)) {
        logger.warn(`Log file not found: ${this.logPath}`);
        return { bytes_in: 0, bytes_out: 0, requests: 0 };
      }

      // Track the last hour of logs
      const oneHourAgo = Date.now() - (60 * 60 * 1000);
      
      const content = fs.readFileSync(this.logPath, 'utf8');
      const lines = content.split('\n');
      
      let bytes_out = 0;
      let bytes_in = 0;
      let requests = 0;
      
      for (const line of lines) {
        if (!line.trim()) continue;
        
        // Skip internal monitoring requests (127.0.0.1)
        if (line.startsWith('127.0.0.1')) continue;
        
        // Only count IPFS gateway requests (/ipfs/ or /ipns/ paths)
        // Format: IP - [timestamp] "METHOD PATH PROTOCOL" STATUS SIZE "USER_AGENT" TIME "BODY"
        const gatewayMatch = line.match(/^\S+\s+-\s+\[([^\]]+)\]\s+"(GET|HEAD|POST)\s+\/(ipfs|ipns)\/\S+\s+HTTP\/[^"]+"\s+(\d+)\s+(\d+)/);
        
        if (gatewayMatch) {
          const status = parseInt(gatewayMatch[4], 10);
          const size = parseInt(gatewayMatch[5], 10);
          
          // Only count successful requests (2xx status codes)
          if (status >= 200 && status < 300) {
            bytes_out += size;
            requests++;
          }
        }
      }
      
      return { bytes_in, bytes_out, requests };
    } catch (error) {
      logger.error('Failed to parse nginx stats:', error);
      return { bytes_in: 0, bytes_out: 0, requests: 0 };
    }
  }

  /**
   * Get IPFS bandwidth stats
   */
  async getIPFSBandwidthStats() {
    try {
      const bwStats = await this.ipfs.statsBW();
      
      return {
        total_in: parseInt(bwStats.TotalIn || 0, 10),
        total_out: parseInt(bwStats.TotalOut || 0, 10),
        rate_in: parseFloat(bwStats.RateIn || 0),
        rate_out: parseFloat(bwStats.RateOut || 0)
      };
    } catch (error) {
      logger.error('Failed to get IPFS bandwidth stats:', error);
      return { total_in: 0, total_out: 0, rate_in: 0, rate_out: 0 };
    }
  }

  /**
   * Get IPFS repository stats
   */
  async getRepoStats() {
    try {
      const repoStat = await this.ipfs.repoStat();
      
      return {
        repo_size: parseInt(repoStat.RepoSize || 0, 10),
        storage_max: parseInt(repoStat.StorageMax || 0, 10),
        num_objects: parseInt(repoStat.NumObjects || 0, 10)
      };
    } catch (error) {
      logger.error('Failed to get IPFS repo stats:', error);
      return { repo_size: 0, storage_max: 0, num_objects: 0 };
    }
  }

  /**
   * Aggregate hourly stats
   * Only tracks actual content delivery via nginx gateway
   */
  async aggregateHourlyStats() {
    try {
      // Get nginx stats (ONLY gateway requests for actual content delivery)
      const nginxStats = await this.parseNginxStats();
      
      // Get IPFS repo stats (for storage info, not bandwidth)
      const repoStats = await this.getRepoStats();
      
      // Store hourly stats - only nginx gateway traffic (actual 3speak content delivery)
      await this.db.insertTrafficStats({
        period: 'hourly',
        bytes_in: nginxStats.bytes_in,
        bytes_out: nginxStats.bytes_out,
        requests_count: nginxStats.requests
      });
      
      logger.info('Hourly stats aggregated (gateway requests only):', {
        bytes_in: nginxStats.bytes_in,
        bytes_out: nginxStats.bytes_out,
        requests: nginxStats.requests,
        repo_size: repoStats.repo_size
      });
      
      return {
        nginx: nginxStats,
        repo: repoStats
      };
    } catch (error) {
      logger.error('Failed to aggregate hourly stats:', error);
      throw error;
    }
  }

  /**
   * Aggregate daily stats (sum of hourly)
   */
  async aggregateDailyStats() {
    try {
      const result = await this.db.get(`
        SELECT 
          SUM(bytes_in) as bytes_in,
          SUM(bytes_out) as bytes_out,
          SUM(requests_count) as requests_count
        FROM traffic_stats
        WHERE period = 'hourly'
        AND DATE(timestamp) = DATE('now')
      `);
      
      if (result && result.bytes_in !== null) {
        await this.db.insertTrafficStats({
          period: 'daily',
          bytes_in: result.bytes_in || 0,
          bytes_out: result.bytes_out || 0,
          requests_count: result.requests_count || 0
        });
        
        logger.info('Daily stats aggregated:', result);
      }
      
      return result;
    } catch (error) {
      logger.error('Failed to aggregate daily stats:', error);
      return null;
    }
  }

  /**
   * Clean old stats beyond retention period
   */
  async cleanOldStats() {
    try {
      const result = await this.db.cleanOldStats(this.retentionDays);
      logger.info(`Cleaned stats older than ${this.retentionDays} days`);
      return result;
    } catch (error) {
      logger.error('Failed to clean old stats:', error);
      return null;
    }
  }

  /**
   * Check IPFS daemon health
   */
  async checkIPFSHealth() {
    try {
      const isRunning = await this.ipfs.isRunning();
      const lastStatus = await this.db.getConfig('ipfs_running');
      const wasRunning = lastStatus === 'true';
      
      // Only notify on state change
      if (isRunning !== wasRunning) {
        await this.discord.notifyIPFSStatus(isRunning);
        await this.db.logEvent({
          event_type: 'ipfs_status_change',
          severity: isRunning ? 'info' : 'critical',
          message: `IPFS daemon ${isRunning ? 'came online' : 'went offline'}`
        });
      }
      
      // Update status
      await this.db.setConfig('ipfs_running', isRunning ? 'true' : 'false');
      
      return isRunning;
    } catch (error) {
      logger.error('IPFS health check failed:', error);
      return false;
    }
  }

  /**
   * Run the stats aggregator worker
   */
  async run() {
    try {
      // Check IPFS health first
      const ipfsRunning = await this.checkIPFSHealth();
      
      if (!ipfsRunning) {
        logger.error('IPFS daemon is not running - skipping stats aggregation');
        return { success: false, error: 'IPFS daemon offline' };
      }
      
      // Aggregate hourly stats
      const hourlyStats = await this.aggregateHourlyStats();
      
      // Clean old stats
      await this.cleanOldStats();
      
      // Update last run time
      await this.db.setConfig('last_stats_run', new Date().toISOString());
      
      // Log event
      await this.db.logEvent({
        event_type: 'stats_aggregation',
        severity: 'info',
        message: 'Stats aggregated successfully',
        metadata: hourlyStats
      });

      return hourlyStats;
    } catch (error) {
      await this.db.logEvent({
        event_type: 'stats_aggregation',
        severity: 'error',
        message: error.message
      });
      throw error;
    }
  }
}

// Singleton instance
let instance = null;

function getStatsAggregator() {
  if (!instance) {
    instance = new StatsAggregator();
  }
  return instance;
}

// Export for worker execution
module.exports = {
  run: async () => {
    const aggregator = getStatsAggregator();
    return await aggregator.run();
  },
  getStatsAggregator
};
