const axios = require('axios');
const config = require('./config');

class DiscordNotifier {
  constructor(webhookUrl = config.discord.webhook_url) {
    this.webhookUrl = webhookUrl;
    this.enabled = webhookUrl && webhookUrl.length > 0;
  }

  isEnabled() {
    return this.enabled && this.webhookUrl && this.webhookUrl.length > 0;
  }

  /**
   * Send a notification to Discord
   */
  async send(title, message, color = 'blue', fields = []) {
    if (!this.isEnabled()) {
      console.log('Discord notifications disabled (no webhook URL)');
      return;
    }

    const colorMap = {
      blue: 3447003,
      green: 3066993,
      yellow: 16776960,
      orange: 15105570,
      red: 15158332,
      gray: 9807270
    };

    const embed = {
      title,
      description: message,
      color: colorMap[color] || colorMap.blue,
      timestamp: new Date().toISOString(),
      footer: {
        text: config.hotnode.name || 'IPFS Hot Node'
      }
    };

    if (fields && fields.length > 0) {
      embed.fields = fields;
    }

    try {
      await axios.post(this.webhookUrl, {
        embeds: [embed]
      }, {
        timeout: 5000
      });
      console.log('Discord notification sent:', title);
    } catch (error) {
      console.error('Failed to send Discord notification:', error.message);
    }
  }

  /**
   * Notify about health status change
   */
  async notifyHealthChange(enabled, stats = {}) {
    const title = enabled ? '✅ Hot Node Enabled' : '⚠️ Hot Node Disabled';
    const message = enabled 
      ? 'Hot node has been enabled and is accepting uploads'
      : 'Hot node has been disabled and is not accepting uploads';
    
    const fields = [
      { name: 'Pending Migrations', value: String(stats.pending_migration || 0), inline: true },
      { name: 'Disk Usage', value: `${stats.disk_usage_percent || 0}%`, inline: true },
      { name: 'Total Pins', value: String(stats.total_pins || 0), inline: true }
    ];

    await this.send(title, message, enabled ? 'green' : 'yellow', fields);
  }

  /**
   * Notify about garbage collection completion
   */
  async notifyGCComplete(duration, freedBytes, error = null) {
    if (error) {
      await this.send(
        '❌ Garbage Collection Failed',
        `GC failed after ${duration}s: ${error}`,
        'red'
      );
    } else {
      const freedMB = (freedBytes / (1024 * 1024)).toFixed(2);
      const freedGB = (freedBytes / (1024 * 1024 * 1024)).toFixed(2);
      
      const fields = [
        { name: 'Duration', value: `${duration}s`, inline: true },
        { name: 'Space Freed', value: freedGB > 1 ? `${freedGB} GB` : `${freedMB} MB`, inline: true }
      ];

      await this.send(
        '🗑️ Garbage Collection Complete',
        'IPFS garbage collection has completed successfully',
        'green',
        fields
      );
    }
  }

  /**
   * Notify about migration errors
   */
  async notifyMigrationErrors(failedCIDs) {
    if (!failedCIDs || failedCIDs.length === 0) {
      return;
    }

    const cidList = failedCIDs.slice(0, 5).join('\n');
    const more = failedCIDs.length > 5 ? `\n...and ${failedCIDs.length - 5} more` : '';
    
    await this.send(
      '⚠️ Migration Errors',
      `${failedCIDs.length} pins failed to migrate to supernode:\n\`\`\`${cidList}${more}\`\`\``,
      'orange',
      [{ name: 'Total Failed', value: String(failedCIDs.length), inline: true }]
    );
  }

  /**
   * Notify about overdue pins
   */
  async notifyOverduePins(count, oldestAge) {
    await this.send(
      '🚨 Overdue Pins Detected',
      `${count} pins are older than 7 days and have not been migrated`,
      'red',
      [
        { name: 'Overdue Count', value: String(count), inline: true },
        { name: 'Oldest Pin Age', value: `${oldestAge} days`, inline: true }
      ]
    );
  }

  /**
   * Notify about IPFS daemon status
   */
  async notifyIPFSStatus(isRunning, errorMessage = null) {
    if (isRunning) {
      await this.send(
        '✅ IPFS Daemon Online',
        'IPFS daemon is now running and accessible',
        'green'
      );
    } else {
      await this.send(
        '🚨 IPFS Daemon Down',
        `IPFS daemon is not responding!${errorMessage ? `\n\nError: ${errorMessage}` : ''}\n\nImmediate attention required.`,
        'red',
        [
          { name: 'Status', value: 'Offline', inline: true },
          { name: 'Action Required', value: 'Check IPFS service', inline: true }
        ]
      );
    }
  }

  /**
   * Notify about disk space warnings
   */
  async notifyDiskWarning(usagePercent, totalGB, usedGB) {
    const severity = usagePercent >= 90 ? 'critical' : 'warning';
    const color = usagePercent >= 90 ? 'red' : 'orange';
    const emoji = usagePercent >= 90 ? '🚨' : '⚠️';
    
    await this.send(
      `${emoji} Disk Space ${severity === 'critical' ? 'Critical' : 'Warning'}`,
      `Disk usage is at ${usagePercent}% - immediate action may be required`,
      color,
      [
        { name: 'Used', value: `${usedGB.toFixed(2)} GB`, inline: true },
        { name: 'Total', value: `${totalGB.toFixed(2)} GB`, inline: true },
        { name: 'Usage', value: `${usagePercent}%`, inline: true }
      ]
    );
  }

  /**
   * Send test notification
   */
  async sendTest() {
    await this.send(
      '🧪 Test Notification',
      'This is a test notification from the Hot Node Service',
      'blue',
      [{ name: 'Status', value: 'OK', inline: true }]
    );
  }
}

// Singleton instance
let instance = null;

function getDiscordNotifier() {
  if (!instance) {
    instance = new DiscordNotifier();
  }
  return instance;
}

module.exports = { DiscordNotifier, getDiscordNotifier };
