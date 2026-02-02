const { getDatabase } = require('../utils/database');
const { getIPFSClient } = require('../utils/ipfs');
const { getDiscordNotifier } = require('../utils/discord');
const logger = require('../utils/logger');

/**
 * Health Reporter Worker
 * 
 * Periodically reports node health to 3speak monitoring
 * Sends status updates to default webhook
 * 
 * Frequency: Every 6 hours
 */

class HealthReporter {
  constructor() {
    this.db = getDatabase();
    this.ipfs = getIPFSClient();
    this.discord = getDiscordNotifier();
  }

  /**
   * Collect health metrics
   */
  async collectHealthMetrics() {
    try {
      // Check if IPFS is running
      const ipfsRunning = await this.ipfs.isRunning();
      
      if (!ipfsRunning) {
        return {
          status: 'unhealthy',
          reason: 'IPFS daemon not running',
          ipfs_running: false
        };
      }

      // Get enabled status
      const enabled = (await this.db.getConfig('enabled')) === 'true';

      // Get pin stats
      const pinStats = await this.db.getPinStats();

      // Get repo stats for disk usage
      let diskUsagePercent = 0;
      let repoSizeGB = 0;
      
      try {
        const repoStat = await this.ipfs.repoStat();
        const repoSize = parseInt(repoStat.RepoSize || 0, 10);
        const storageMax = parseInt(repoStat.StorageMax || 0, 10);
        
        repoSizeGB = (repoSize / (1024 * 1024 * 1024)).toFixed(2);
        
        if (storageMax > 0) {
          diskUsagePercent = Math.round((repoSize / storageMax) * 100);
        }
      } catch (error) {
        logger.error('Failed to get disk usage:', error);
      }

      // Determine health status
      let status = 'healthy';
      let reason = null;

      if (!enabled) {
        status = 'disabled';
        reason = 'Node manually disabled';
      } else if (diskUsagePercent > 90) {
        status = 'unhealthy';
        reason = 'Disk usage critical';
      } else if (diskUsagePercent > 80) {
        status = 'warning';
        reason = 'Disk usage high';
      } else if (pinStats.overdue > 50) {
        status = 'warning';
        reason = 'Many overdue pins';
      }

      return {
        status,
        reason,
        ipfs_running: true,
        enabled,
        disk_usage_percent: diskUsagePercent,
        repo_size_gb: repoSizeGB,
        total_pins: pinStats.total || 0,
        pending_migration: pinStats.pending_migration || 0,
        overdue_pins: pinStats.overdue || 0
      };
    } catch (error) {
      logger.error('Failed to collect health metrics:', error);
      return {
        status: 'error',
        reason: `Health check failed: ${error.message}`,
        ipfs_running: false
      };
    }
  }

  /**
   * Report health to 3speak monitoring
   */
  async reportHealth() {
    try {
      const health = await this.collectHealthMetrics();

      logger.info(`Health status: ${health.status} - ${health.reason || 'OK'}`);

      // Send to 3speak monitoring via default webhook
      await this.discord.notifyNodeStatus(health.status, {
        disk_usage_percent: health.disk_usage_percent,
        total_pins: health.total_pins,
        pending_migration: health.pending_migration,
        overdue_pins: health.overdue_pins,
        repo_size_gb: health.repo_size_gb
      });

      // Log event
      await this.db.logEvent({
        event_type: 'health_report',
        severity: health.status === 'healthy' ? 'info' : 'warning',
        message: `Health report: ${health.status} - ${health.reason || 'OK'}`,
        metadata: health
      });

      return health;
    } catch (error) {
      logger.error('Failed to report health:', error);
      
      await this.db.logEvent({
        event_type: 'health_report',
        severity: 'error',
        message: `Health report failed: ${error.message}`
      });

      throw error;
    }
  }

  /**
   * Run the health reporter worker
   */
  async run() {
    return await this.reportHealth();
  }
}

// Singleton instance
let instance = null;

function getHealthReporter() {
  if (!instance) {
    instance = new HealthReporter();
  }
  return instance;
}

// Export for worker execution
module.exports = {
  run: async () => {
    const reporter = getHealthReporter();
    return await reporter.run();
  },
  getHealthReporter
};
