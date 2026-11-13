/**
 * Migration: adds the S3-copy columns to pins, and the s3_events table.
 *
 * The hotnode copies videos to S3 by asking snapie-migrator (see
 * workers/s3Worker.js); these columns hold where each pin's copy stands.
 *
 * Idempotent, like migrateAddServingTracking.js: each column is added only if
 * missing, and a fresh install (no pins table yet) is left to init-db.
 *
 * Run once: node scripts/migrateAddS3Tracking.js (deploy.sh runs it).
 */
const sqlite3 = require('sqlite3').verbose();
const { DB_PATH } = require('./initDatabase');

const NEW_COLUMNS = [
  ['s3_state', 'TEXT'],
  ['s3_url', 'TEXT'],
  ['s3_car_url', 'TEXT'],
  ['s3_bytes', 'INTEGER'],
  ['s3_requested_at', 'DATETIME'],
  ['s3_copied_at', 'DATETIME'],
  ['s3_archived_at', 'DATETIME'],
  ['s3_attempts', 'INTEGER DEFAULT 0'],
  ['s3_error_code', 'TEXT'],
  ['s3_error', 'TEXT'],
  ['s3_retryable', 'INTEGER'],
  ['s3_next_attempt_at', 'DATETIME'],
];

function all(db, sql) {
  return new Promise((resolve, reject) => db.all(sql, [], (err, rows) => (err ? reject(err) : resolve(rows))));
}

function run(db, sql) {
  return new Promise((resolve, reject) => db.run(sql, [], (err) => (err ? reject(err) : resolve())));
}

async function migrate(dbPath = DB_PATH) {
  const db = new sqlite3.Database(dbPath);
  try {
    const existing = new Set((await all(db, 'PRAGMA table_info(pins)')).map((c) => c.name));
    if (existing.size === 0) {
      console.log('- no pins table yet, nothing to migrate (init-db creates the current schema)');
      return;
    }
    for (const [name, type] of NEW_COLUMNS) {
      if (existing.has(name)) continue;
      await run(db, `ALTER TABLE pins ADD COLUMN ${name} ${type}`);
      console.log(`+ added column '${name}'`);
    }
    await run(db, 'CREATE INDEX IF NOT EXISTS idx_pins_s3_state ON pins(s3_state)');
    await run(db, `CREATE TABLE IF NOT EXISTS s3_events (
      event_id TEXT PRIMARY KEY, event TEXT NOT NULL, cid TEXT NOT NULL, received_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    await run(db, `INSERT OR REPLACE INTO config (key, value, updated_at) VALUES ('schema_version', '4', CURRENT_TIMESTAMP)`);
    console.log('✅ migration complete (schema_version -> 4)');
  } finally {
    db.close();
  }
}

if (require.main === module) {
  migrate()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('❌ migration failed:', err);
      process.exit(1);
    });
}

module.exports = { migrate, NEW_COLUMNS };
