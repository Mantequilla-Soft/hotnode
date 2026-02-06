const { getDatabase } = require('../utils/database');
const { getIPFSClient } = require('../utils/ipfs');
const { getDiscordNotifier } = require('../utils/discord');
const logger = require('../utils/logger');
const os = require('os');
const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

/**
 * Health Reporter Worker
 * 
 * Periodically reports node health to 3speak monitoring
 * Sends status updates to default webhook
 * Collects system metrics (CPU, memory, disk)
 * 
 * Frequency: Every 6 hours
 */

class HealthReporter {
  constructor() {
    this.db = getDatabase();
    this.ipfs = getIPFSClient();
    this.discord = getDiscordNotifier();
    this.lastCpuUsage = null;
  }

  /**
   * Collect system metrics (CPU, memory, disk)
   */
  async collectSystemMetrics() {
    try {
      const metrics = {};

      // Memory metrics
      const totalMemory = os.totalmem();
      const freeMemory = os.freemem();
      const usedMemory = totalMemory - freeMemory;
      
      metrics.memory_total_mb = (totalMemory / (1024 * 1024)).toFixed(2);
      metrics.memory_used_mb = (usedMemory / (1024 * 1024)).toFixed(2);
      metrics.memory_percent = ((usedMemory / totalMemory) * 100).toFixed(2);

      // CPU usage (average over 1 second)
      const cpuUsage = await this.getCPUUsage();
      metrics.cpu_usage_percent = cpuUsage.toFixed(2);

      // Disk usage (for the database directory)
      try {
        const { stdout } = await execAsync("df -BG . | tail -1 | awk '{print $2, $3, $5}'");
        const [total, used, percent] = stdout.trim().split(' ');
        
        metrics.disk_total_gb = parseFloat(total);
        metrics.disk_used_gb = parseFloat(used);
        metrics.disk_percent = parseFloat(percent);
      } catch (error) {
        logger.warn('Failed to get disk metrics:', error.message);
        metrics.disk_total_gb = null;
        metrics.disk_used_gb = null;
        metrics.disk_percent = null;
      }

      return metrics;
    } catch (error) {
      logger.error('Failed to collect system metrics:', error);
      return null;
    }
  }

  /**
   * Calculate CPU usage percentage
   */
  async getCPUUsage() {
    const cpus = os.cpus();
    
    // Calculate total CPU times
    let totalIdle = 0;
    let totalTick = 0;
    
    cpus.forEach(cpu => {
      for (const type in cpu.times) {
        totalTick += cpu.times[type];
      }
      totalIdle += cpu.times.idle;
    });
    
    // Wait 100ms and measure again
    await new Promise(resolve => setTimeout(resolve, 100));
    
    const cpus2 = os.cpus();
    let totalIdle2 = 0;
    let totalTick2 = 0;
    
    cpus2.forEach(cpu => {
      for (const type in cpu.times) {
        totalTick2 += cpu.times[type];
      }
      totalIdle2 += cpu.times.idle;
    });
    
    const idleDiff = totalIdle2 - totalIdle;
    const totalDiff = totalTick2 - totalTick;
    const usage = 100 - (100 * idleDiff / totalDiff);
    
    return usage;
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

      // Collect and store system metrics
      const systemMetrics = await this.collectSystemMetrics();
      if (systemMetrics) {
        await this.db.insertSystemMetrics(systemMetrics);
        
        // Log system metrics event
        await this.db.logEvent({
          event_type: 'system_metrics',
          severity: 'info',
          message: `System: CPU ${systemMetrics.cpu_usage_percent}%, Memory ${systemMetrics.memory_percent}%, Disk ${systemMetrics.disk_percent}%`,
          metadata: systemMetrics
        });
      }

      // Send to 3speak monitoring via default webhook
      await this.discord.notifyNodeStatus(health.status, {
        disk_usage_percent: health.disk_usage_percent,
        total_pins: health.total_pins,
        pending_migration: health.pending_migration,
        overdue_pins: health.overdue_pins,
        repo_size_gb: health.repo_size_gb,
        system_cpu: systemMetrics?.cpu_usage_percent,
        system_memory: systemMetrics?.memory_percent
      });

      // Log event
      await this.db.logEvent({
        event_type: 'health_report',
        severity: health.status === 'healthy' ? 'info' : 'warning',
        message: `Health report: ${health.status} - ${health.reason || 'OK'}`,
        metadata: { ...health, system_metrics: systemMetrics }
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
