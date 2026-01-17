const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '../database/hotnode.db');

// Ensure database directory exists
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

// Database schema
const schema = `
-- Pins table: tracks all pinned content
CREATE TABLE IF NOT EXISTS pins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cid TEXT UNIQUE NOT NULL,
    added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    size_bytes INTEGER,
    status TEXT DEFAULT 'pending',
    migrated BOOLEAN DEFAULT 0,
    migrated_at DATETIME,
    unpinned BOOLEAN DEFAULT 0,
    unpinned_at DATETIME,
    retry_count INTEGER DEFAULT 0,
    last_retry_at DATETIME,
    notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_pins_status ON pins(status);
CREATE INDEX IF NOT EXISTS idx_pins_migrated ON pins(migrated, added_at);
CREATE INDEX IF NOT EXISTS idx_pins_cid ON pins(cid);
CREATE INDEX IF NOT EXISTS idx_pins_added_at ON pins(added_at);

-- Traffic stats table: bandwidth and request tracking
CREATE TABLE IF NOT EXISTS traffic_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    period TEXT NOT NULL,
    bytes_in INTEGER DEFAULT 0,
    bytes_out INTEGER DEFAULT 0,
    requests_count INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_stats_period ON traffic_stats(period, timestamp);

-- Garbage collection logs
CREATE TABLE IF NOT EXISTS gc_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    duration_seconds INTEGER,
    freed_bytes INTEGER,
    error TEXT
);

-- Configuration table
CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- System events log
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    event_type TEXT NOT NULL,
    severity TEXT DEFAULT 'info',
    message TEXT,
    metadata TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type, timestamp);
CREATE INDEX IF NOT EXISTS idx_events_severity ON events(severity, timestamp);
`;

// Default configuration values
const defaultConfig = [
  ['enabled', 'true'],
  ['discord_webhook', ''],
  ['migration_batch_size', '10'],
  ['migration_start_days', '4'],
  ['log_parse_offset', '0'],
  ['last_gc_run', ''],
  ['last_migration_run', ''],
  ['last_stats_run', '']
];

function initializeDatabase() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(DB_PATH, (err) => {
      if (err) {
        reject(err);
        return;
      }
      
      console.log('Connected to SQLite database');
      
      // Execute schema
      db.exec(schema, (err) => {
        if (err) {
          reject(err);
          return;
        }
        
        console.log('Database schema created/verified');
        
        // Insert default configuration
        const stmt = db.prepare('INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)');
        
        defaultConfig.forEach(([key, value]) => {
          stmt.run(key, value);
        });
        
        stmt.finalize((err) => {
          if (err) {
            reject(err);
            return;
          }
          
          console.log('Default configuration inserted');
          
          db.close((err) => {
            if (err) {
              reject(err);
              return;
            }
            console.log('Database initialization complete');
            resolve();
          });
        });
      });
    });
  });
}

// Run if called directly
if (require.main === module) {
  console.log('Initializing database...');
  initializeDatabase()
    .then(() => {
      console.log('✅ Database initialized successfully');
      process.exit(0);
    })
    .catch((err) => {
      console.error('❌ Database initialization failed:', err);
      process.exit(1);
    });
}

module.exports = { initializeDatabase, DB_PATH };
