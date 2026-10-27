# Schema Migration v3: Dormancy-Based Retention

**Date:** September 30, 2026
**Schema Version:** 2 → 3

## Overview

Replaces the old "unpin once migrated + N days" retention rule with one
based on age and actual activity. Retention no longer depends on
`migrated` at all - it needs to keep working once migration to a
supernode isn't part of the architecture anymore.

## Why

The old rule (`migrated = 1 AND added_at >= deleteDays ago`) had no
awareness of whether a video was still being watched. A still-popular
video got unpinned from the hot node the same as a dead one, as long as
both were migrated and old enough.

## New Columns on `pins`

- `owner` (TEXT): video owner, resolved via `mongo.js:getVideoMetadata(cid)`.
  NULL for pins that don't resolve to a known video (e.g. an admin manually
  pinning an arbitrary CID) - retention still ages these out via `added_at`,
  it just can't check dormancy for them.
- `permlink` (TEXT): video permlink, same resolution path.
- `last_served_at` (DATETIME): last time this content was actually watched,
  synced from Mongo's `view-heatmaps.updatedAt` - see "Where the signal
  comes from" below.

## New Indexes

- `idx_pins_owner_permlink` - for the sync worker's per-pin lookups
- `idx_pins_last_served_at` - for the retention query

## Where the signal comes from

`view-heatmaps` (one doc per owner+permlink) already gets its `updatedAt`
bumped by snapievideoplayer's `watchTracking.js`:
- on every real `watchStart` (genuine watch beginning)
- on every `watchBeat` with real playback progress

Critically, `watchStart` explicitly skips this for placeholder plays
(deleted / encoding / failed video status), so a dead video's placeholder
view can never look like ongoing demand for the real content. This was
already correct behavior in the player - this migration is the first
thing on the hotnode side to actually use it.

## New Retention Rule

`getDormantPinsForCleanup(minAgeDays, dormantAfterDays)` in `database.js`,
replacing `getMigratedPinsForCleanup(deleteDays)`. Both conditions must
hold:

- **old enough**: `added_at` at least `RETENTION_MIN_AGE_DAYS` (default 30)
  in the past - a guaranteed minimum lifetime regardless of activity, so a
  brand new upload with a quiet first few days isn't evicted early.
- **dormant**: `COALESCE(last_served_at, added_at)` at least
  `RETENTION_DORMANT_AFTER_DAYS` (default 7) in the past - falls back to
  `added_at` when never synced or never watched, so untracked content ages
  out on the same clock as tracked content instead of being treated as
  permanently safe.

A video that keeps getting watched keeps resetting its own dormancy clock
(`last_served_at` moves forward), so popular old content is never evicted
just for being old.

## New Worker

`syncLastServedWorker.js` - every `RETENTION_SYNC_INTERVAL_HOURS` (default
4h), pulls `last_served_at` from Mongo into the local `pins` table for
every pin with a known `owner`/`permlink`, so the cleanup worker's
dormancy check doesn't need a live cross-DB lookup per pin on every run.

## New Scripts

- `scripts/migrateAddServingTracking.js` - the actual `ALTER TABLE`
  migration. Idempotent (checks `PRAGMA table_info` before adding each
  column) - safe to re-run, and safe against a fresh install that already
  has these columns via `initDatabase.js`.
- `scripts/backfillOwnerPermlink.js` - one-off backfill of owner/permlink
  for pins that existed before this shipped. Safe to re-run; only touches
  pins where both fields are still NULL.

## Configuration Changes

New `retention` block (`utils/config.js`):
- `RETENTION_MIN_AGE_DAYS` (default 30)
- `RETENTION_DORMANT_AFTER_DAYS` (default 7)
- `RETENTION_SYNC_INTERVAL_HOURS` (default 4)

New `MONGODB_COLLECTION_HEATMAPS` (default `view-heatmaps`) - must match
snapievideoplayer's `WATCH_HEATMAP_COLLECTION` or `getLastServedAt()`
silently finds nothing.

`MIGRATION_DELETE_AFTER_DAYS` / `migration.delete_after_days` is no longer
read by the cleanup worker. Left in place for backward compatibility (an
old `.env` setting it won't error), just unused now.

## Migration Steps

1. Deploy the updated code (workers, config)
2. Run `node scripts/migrateAddServingTracking.js` (or let `deploy.sh` do
   it - it's in the known-migrations list there)
3. Run `node scripts/backfillOwnerPermlink.js` once, to resolve
   owner/permlink for existing pins
4. Wait for `syncLastServedWorker` to populate `last_served_at` for the
   first time (runs every 4h by default, or trigger manually)
5. `cleanupWorker`'s next run uses the new rule automatically

## Not Done In This Migration

- **Dashboard** (`views/pins.ejs`, `views/dashboard.ejs`, `views/stats.ejs`)
  still displays and manages content by `migrated` status, including a
  manual "mark as migrated" admin action (`POST /api/pins/mark-migrated`)
  whose whole purpose was extending retention under the old rule. This
  needs its own pass - probably replacing "mark as migrated" with
  something like "pin override" / "exclude from dormancy cleanup" that
  matches what retention actually checks now.
- **Docs** (`README.md`, `DEPLOYMENT.md`, `PROJECT_SUMMARY.md`,
  `QUICKSTART.md`) describe the old "7-day migration window (strict)"
  retention model and need updating to match.
- `routes/api.js`'s manual pin and `scan-logs` routes don't resolve
  owner/permlink yet (only `pinDiscoveryWorker.js` does, for the
  automatic path).

## Rollback Plan

`getMigratedPinsForCleanup` is fully removed rather than kept side by
side, so rolling back means reverting the code (git revert) rather than
flipping a flag. The new columns are additive and unused by old code, so
no data loss either direction - a rollback just means the old
migration-gated rule runs again until this is re-applied.
