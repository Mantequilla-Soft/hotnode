/**
 * One-off repair for migration_stats / cleanup_stats rows corrupted by the
 * old daily upsert, which reset a day's counters to NULL on every run after
 * the first (see #7).
 *
 * Rebuilds what can be recovered from source data:
 *   migration_stats  success_count, bytes_migrated  <- pins.migrated_at / size_bytes
 *   cleanup_stats    gc_runs, gc_duration_seconds, gc_bytes_freed <- gc_logs
 *                    migrated_pins_unpinned, bytes_freed_migrated <- pins.unpinned_at
 * Counters with no surviving source (migration failures, max-retries,
 * invalid pins removed - those rows are deleted) become 0.
 *
 * Only rows with a NULL counter are touched, plus missing migration_stats
 * days that pins show had migrations - rows written correctly are left
 * alone, so it's safe to re-run.
 *
 * Run once, as the service user (it owns the database):
 *   sudo -u ipfs node scripts/repairDailyStats.js
 */
const sqlite3 = require('sqlite3').verbose();
const { DB_PATH } = require('./initDatabase');

function run(db, sql) {
  return new Promise((resolve, reject) => {
    db.run(sql, [], function (err) { return err ? reject(err) : resolve(this.changes); });
  });
}

const MIGRATION_NULL = `success_count IS NULL OR failure_count IS NULL
  OR bytes_migrated IS NULL OR max_retries_reached IS NULL`;
const CLEANUP_NULL = `invalid_pins_removed IS NULL OR migrated_pins_unpinned IS NULL
  OR bytes_freed_invalid IS NULL OR bytes_freed_migrated IS NULL
  OR gc_runs IS NULL OR gc_duration_seconds IS NULL OR gc_bytes_freed IS NULL`;

async function repair() {
  const db = new sqlite3.Database(DB_PATH);
  try {
    await run(db, 'BEGIN');

    const migrationFixed = await run(db, `
      UPDATE migration_stats SET
        success_count = (SELECT COUNT(*) FROM pins
                         WHERE migrated = 1 AND date(migrated_at) = migration_stats.date),
        bytes_migrated = (SELECT COALESCE(SUM(size_bytes), 0) FROM pins
                          WHERE migrated = 1 AND date(migrated_at) = migration_stats.date),
        failure_count = COALESCE(failure_count, 0),
        max_retries_reached = COALESCE(max_retries_reached, 0)
      WHERE ${MIGRATION_NULL}
    `);

    const migrationAdded = await run(db, `
      INSERT INTO migration_stats (date, success_count, bytes_migrated)
      SELECT date(migrated_at), COUNT(*), COALESCE(SUM(size_bytes), 0)
      FROM pins
      WHERE migrated = 1 AND migrated_at IS NOT NULL
        AND date(migrated_at) NOT IN (SELECT date FROM migration_stats)
      GROUP BY date(migrated_at)
    `);

    const cleanupFixed = await run(db, `
      UPDATE cleanup_stats SET
        gc_runs = (SELECT COUNT(*) FROM gc_logs
                   WHERE error IS NULL AND date(run_at) = cleanup_stats.date),
        gc_duration_seconds = (SELECT COALESCE(SUM(duration_seconds), 0) FROM gc_logs
                               WHERE error IS NULL AND date(run_at) = cleanup_stats.date),
        gc_bytes_freed = (SELECT COALESCE(SUM(freed_bytes), 0) FROM gc_logs
                          WHERE error IS NULL AND date(run_at) = cleanup_stats.date),
        migrated_pins_unpinned = (SELECT COUNT(*) FROM pins
                                  WHERE unpinned = 1 AND date(unpinned_at) = cleanup_stats.date),
        bytes_freed_migrated = (SELECT COALESCE(SUM(size_bytes), 0) FROM pins
                                WHERE unpinned = 1 AND date(unpinned_at) = cleanup_stats.date),
        invalid_pins_removed = COALESCE(invalid_pins_removed, 0),
        bytes_freed_invalid = COALESCE(bytes_freed_invalid, 0)
      WHERE ${CLEANUP_NULL}
    `);

    await run(db, 'COMMIT');
    console.log(`✅ migration_stats: ${migrationFixed} rows repaired, ${migrationAdded} missing days added`);
    console.log(`✅ cleanup_stats: ${cleanupFixed} rows repaired`);
  } catch (err) {
    await run(db, 'ROLLBACK').catch(() => {});
    throw err;
  } finally {
    db.close();
  }
}

if (require.main === module) {
  repair()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('❌ repair failed:', err);
      process.exit(1);
    });
}

module.exports = { repair };
