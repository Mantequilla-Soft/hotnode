/**
 * Centralized Configuration Module
 * 
 * All configuration is loaded from environment variables.
 * No config.json dependency - use .env file for all settings.
 */

// Load environment variables (if not already loaded)
require('dotenv').config();

/**
 * Helper to get required env var or throw
 */
function required(key, defaultValue = null) {
  const value = process.env[key];
  if (!value && defaultValue === null) {
    console.error(`❌ Required environment variable ${key} is not set`);
    process.exit(1);
  }
  return value || defaultValue;
}

/**
 * Helper to get optional env var with default
 */
function optional(key, defaultValue) {
  return process.env[key] || defaultValue;
}

/**
 * Helper to get integer env var
 */
function optionalInt(key, defaultValue) {
  const value = process.env[key];
  return value ? parseInt(value, 10) : defaultValue;
}

/**
 * Configuration object - all values from environment variables
 */
const config = {
  hotnode: {
    name: optional('HOTNODE_NAME', 'HotNode-01'),
    port: optionalInt('HOTNODE_PORT', 3101),
    ipfs_api: optional('IPFS_API_URL', 'http://127.0.0.1:5001'),
    ipfs_gateway: optional('IPFS_GATEWAY_URL', 'http://127.0.0.1:8080')
  },
  
  supernode: {
    api: required('SUPERNODE_API'),
    verify_endpoint: '/api/v0/pin/ls',
    timeout_ms: optionalInt('SUPERNODE_TIMEOUT_MS', 30000)
  },
  
  mongodb: {
    uri: optional('MONGODB_URI', ''),
    database: optional('MONGODB_DATABASE', 'threespeak'),
    collection_legacy: optional('MONGODB_COLLECTION_LEGACY', 'videos'),
    collection_new: optional('MONGODB_COLLECTION_NEW', 'embed-video'),
    timeout_ms: optionalInt('MONGODB_TIMEOUT_MS', 5000)
  },
  
  nginx: {
    log_path: optional('NGINX_LOG_PATH', '/var/log/nginx/ipfs-gateway.log')
  },
  
  migration: {
    start_after_days: optionalInt('MIGRATION_START_AFTER_DAYS', 4),
    delete_after_days: optionalInt('MIGRATION_DELETE_AFTER_DAYS', 7),
    batch_size: optionalInt('MIGRATION_BATCH_SIZE', 10),
    check_interval_hours: optionalInt('MIGRATION_CHECK_INTERVAL_HOURS', 12),
    throttle_delay_ms: optionalInt('MIGRATION_THROTTLE_DELAY_MS', 2000),
    max_retries: optionalInt('MIGRATION_MAX_RETRIES', 10)
  },
  
  cleanup: {
    invalid_retention_days: optionalInt('CLEANUP_INVALID_RETENTION_DAYS', 2),
    gc_schedule: optional('CLEANUP_GC_SCHEDULE', '0 2 * * *'),
    gc_timeout_minutes: optionalInt('CLEANUP_GC_TIMEOUT_MINUTES', 60)
  },
  
  stats: {
    retention_days: optionalInt('STATS_RETENTION_DAYS', 90),
    aggregation_interval_minutes: optionalInt('STATS_AGGREGATION_INTERVAL_MINUTES', 60)
  },
  
  discord: {
    webhook_url: optional('DISCORD_WEBHOOK_URL', ''),
    notify_events: [
      'health_change',
      'gc_complete',
      'migration_errors',
      'disk_warning',
      'overdue_pins'
    ]
  },
  
  health: {
    disk_warning_percent: optionalInt('HEALTH_DISK_WARNING_PERCENT', 80),
    disk_critical_percent: optionalInt('HEALTH_DISK_CRITICAL_PERCENT', 90)
  },
  
  logging: {
    level: optional('LOG_LEVEL', 'info'),
    file: optional('LOG_FILE', 'logs/hotnode.log'),
    max_size: optional('LOG_MAX_SIZE', '10m'),
    max_files: optionalInt('LOG_MAX_FILES', 5)
  }
};

// Validate critical settings
if (!config.supernode.api) {
  console.error('❌ SUPERNODE_API environment variable is required');
  process.exit(1);
}

module.exports = config;
