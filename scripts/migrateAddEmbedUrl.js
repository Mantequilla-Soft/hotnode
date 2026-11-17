/**
 * Migration: adds pins.embed_url, the video's public `@owner/hive-permlink`
 * address (issue #24). pins.permlink stays as it is: it's the internal video
 * ID, which view-heatmaps (and so retention) is keyed by.
 *
 * Only adds the column. Filling it needs Mongo:
 *   - pins still held here are filled by syncLastServedWorker on its next run;
 *   - for every pin, including unpinned ones, run
 *     node scripts/backfillEmbedUrl.js
 *
 * Idempotent, and a no-op on a fresh install (init-db creates the column).
 *
 * Run once: node scripts/migrateAddEmbedUrl.js (deploy.sh runs it).
 */
const sqlite3 = require('sqlite3').verbose();
const { DB_PATH } = require('./initDatabase');

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
    if (existing.has('embed_url')) {
      console.log("- column 'embed_url' already exists, skipping");
    } else {
      await run(db, 'ALTER TABLE pins ADD COLUMN embed_url TEXT');
      console.log("+ added column 'embed_url'");
    }
    await run(db, `INSERT OR REPLACE INTO config (key, value, updated_at) VALUES ('schema_version', '5', CURRENT_TIMESTAMP)`);
    console.log('✅ migration complete (schema_version -> 5)');
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
