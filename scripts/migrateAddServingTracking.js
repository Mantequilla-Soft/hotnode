/**
 * Migration: adds owner/permlink/last_served_at to the pins table.
 *
 * Needed for the new retention rule (age-floor AND dormancy, instead of
 * "migrated + old enough") - see cleanupWorker.js and database.js's
 * getDormantPinsForCleanup(). owner/permlink is the join key back to Mongo's
 * `view-heatmaps` collection, which the player already keeps a real
 * last-served signal in (view-heatmaps.updatedAt, bumped by watchStart/
 * watchBeat in snapievideoplayer's watchTracking.js).
 *
 * Idempotent: checks PRAGMA table_info before adding each column, so it's
 * safe to run against a database that already has some or all of them
 * (e.g. re-running after a partial failure, or on a fresh install where
 * initDatabase.js's CREATE TABLE already includes these).
 *
 * Run once: node scripts/migrateAddServingTracking.js
 */
const sqlite3 = require('sqlite3').verbose();
const { DB_PATH } = require('./initDatabase');

const NEW_COLUMNS = [
  { name: 'owner', ddl: 'ALTER TABLE pins ADD COLUMN owner TEXT' },
  { name: 'permlink', ddl: 'ALTER TABLE pins ADD COLUMN permlink TEXT' },
  { name: 'last_served_at', ddl: 'ALTER TABLE pins ADD COLUMN last_served_at DATETIME' },
];

const NEW_INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_pins_owner_permlink ON pins(owner, permlink)',
  'CREATE INDEX IF NOT EXISTS idx_pins_last_served_at ON pins(last_served_at)',
];

function all(db, sql) {
  return new Promise((resolve, reject) => {
    db.all(sql, [], (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

function run(db, sql) {
  return new Promise((resolve, reject) => {
    db.run(sql, [], (err) => (err ? reject(err) : resolve()));
  });
}

async function migrate() {
  const db = new sqlite3.Database(DB_PATH);
  try {
    const existing = new Set((await all(db, 'PRAGMA table_info(pins)')).map((c) => c.name));
    if (existing.size === 0) {
      // Fresh install: deploy.sh runs migrations before init-db, which will
      // create the current schema (these columns included) from scratch.
      console.log('- no pins table yet, nothing to migrate (init-db creates the current schema)');
      return;
    }

    for (const col of NEW_COLUMNS) {
      if (existing.has(col.name)) {
        console.log(`- column '${col.name}' already exists, skipping`);
        continue;
      }
      await run(db, col.ddl);
      console.log(`+ added column '${col.name}'`);
    }

    for (const ddl of NEW_INDEXES) {
      await run(db, ddl);
    }
    console.log('+ indexes ensured');

    await run(db, `
      INSERT OR REPLACE INTO config (key, value, updated_at)
      VALUES ('schema_version', '3', CURRENT_TIMESTAMP)
    `);
    console.log('✅ migration complete (schema_version -> 3)');
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

module.exports = { migrate };
