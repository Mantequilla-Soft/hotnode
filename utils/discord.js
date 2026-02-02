const axios = require('axios');
const config = require('./config');

class DiscordNotifier {
  constructor(webhookUrl = config.discord.webhook_url, defaultWebhookUrl = config.discord.default_webhook_url) {
    // Custom webhook for operator's own monitoring
    this.webhookUrl = webhookUrl || process.env.DISCORD_WEBHOOK_URL;
    this.customEnabled = this.webhookUrl && this.webhookUrl.length > 0;
    
    // Default webhook for 3speak monitoring (required)
    this.defaultWebhookUrl = defaultWebhookUrl || process.env.DEFAULT_WEBHOOK_URL;
    this.defaultEnabled = this.defaultWebhookUrl && this.defaultWebhookUrl.length > 0;
  }

  isEnabled() {
    return this.customEnabled || this.defaultEnabled;
  }

  /**
   * Send a notification to Discord
   * @param {boolean} defaultOnly - If true, only send to default webhook (for health/status reports)
   */
  async send(title, message, color = 'blue', fields = [], defaultOnly = false) {
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
        text: `${config.hotnode.name || 'IPFS Hot Node'} (${process.env.NODE_TYPE || 'infrastructure'})`
      }
    };

    if (fields && fields.length > 0) {
      embed.fields = fields;
    }

    const payload = { embeds: [embed] };
    const promises = [];

    // Send to default webhook (3speak monitoring)
    if (this.defaultEnabled) {
      promises.push(
        axios.post(this.defaultWebhookUrl, payload, { timeout: 5000 })
          .then(() => console.log('Discord notification sent to 3speak monitoring:', title))
          .catch(error => console.error('Failed to send to default webhook:', error.message))
      );
    }

    // Send to custom webhook (operator's monitoring) unless defaultOnly
    if (!defaultOnly && this.customEnabled) {
      promises.push(
        axios.post(this.webhookUrl, payload, { timeout: 5000 })
          .then(() => console.log('Discord notification sent to custom webhook:', title))
          .catch(error => console.error('Failed to send to custom webhook:', error.message))
      );
    }

    if (promises.length === 0) {
      console.log('Discord notifications disabled (no webhook URLs configured)');
      return;
    }

    await Promise.allSettled(promises);
  }

  /**
   * Notify about node health/status (sent to default webhook for 3speak monitoring)
   */
  async notifyNodeStatus(status, stats = {}) {
    const title = status === 'healthy' ? '✅ Node Healthy' : '⚠️ Node Unhealthy';
    const message = status === 'healthy'
      ? 'Hot node is operating normally'
      : 'Hot node requires attention';

    const fields = [
      { name: 'Status', value: status, inline: true },
      { name: 'Node Type', value: process.env.NODE_TYPE || 'infrastructure', inline: true },
      { name: 'Disk Usage', value: `${stats.disk_usage_percent || 0}%`, inline: true },
      { name: 'Total Pins', value: String(stats.total_pins || 0), inline: true }
    ];

    // Send only to default webhook (3speak monitoring)
    await this.send(title, message, status === 'healthy' ? 'green' : 'yellow', fields, true);
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
