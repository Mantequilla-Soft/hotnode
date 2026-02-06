# Schema Migration v2: Stats Enhancement

**Date:** February 6, 2026
**Schema Version:** 1 → 2

## Overview
Enhanced the statistics tracking system with comprehensive metrics for migrations, cleanup operations, and system health monitoring.

## New Tables Added

### 1. `migration_stats`
Daily summary of migration operations:
- `date` (DATE, UNIQUE): Date of the stats
- `success_count` (INTEGER): Successful migrations
- `failure_count` (INTEGER): Failed migrations
- `bytes_migrated` (INTEGER): Total bytes migrated
- `max_retries_reached` (INTEGER): Pins that hit max retry limit

### 2. `cleanup_stats`
Daily summary of cleanup operations:
- `date` (DATE, UNIQUE): Date of the stats
- `invalid_pins_removed` (INTEGER): Invalid pins cleaned up
- `migrated_pins_unpinned` (INTEGER): Migrated pins unpinned
- `bytes_freed_invalid` (INTEGER): Storage freed from invalid pins
- `bytes_freed_migrated` (INTEGER): Storage freed from migrated pins
- `gc_runs` (INTEGER): Number of GC runs
- `gc_duration_seconds` (INTEGER): Total GC duration
- `gc_bytes_freed` (INTEGER): Storage freed by GC

### 3. `system_metrics`
Periodic system health metrics:
- `timestamp` (DATETIME): When metrics were collected
- `cpu_usage_percent` (REAL): CPU usage percentage
- `memory_used_mb` (REAL): Memory used in MB
- `memory_total_mb` (REAL): Total memory in MB
- `memory_percent` (REAL): Memory usage percentage
- `disk_used_gb` (REAL): Disk used in GB
- `disk_total_gb` (REAL): Total disk in GB
- `disk_percent` (REAL): Disk usage percentage

## New Database Methods

### Migration Stats
- `updateMigrationStats(date, updates)` - Update daily migration stats
- `getMigrationStats(days)` - Get migration stats history
- `getMigrationStatsSummary(days)` - Get aggregated summary

### Cleanup Stats
- `updateCleanupStats(date, updates)` - Update daily cleanup stats
- `getCleanupStats(days)` - Get cleanup stats history
- `getCleanupStatsSummary(days)` - Get aggregated summary

### System Metrics
- `insertSystemMetrics(metrics)` - Store system metrics
- `getSystemMetrics(hours)` - Get metrics history
- `getSystemMetricsAverage(hours)` - Get average metrics
- `cleanOldSystemMetrics(days)` - Clean old metrics

## Worker Changes

### migrationWorker.js
- Added daily stats tracking to `migration_stats` table
- Added detailed event logging for success/failure
- Tracks bytes migrated and max retry counts

### cleanupWorker.js
- Added bytes freed tracking for both invalid and migrated pins
- Updated daily stats in `cleanup_stats` table
- Added detailed event logging for each cleanup operation

### healthReporter.js
- Added system metrics collection (CPU, memory, disk)
- Collects metrics every 6 hours
- Stores in `system_metrics` table
- Sends system metrics to Discord webhook

## New API Endpoints

- `GET /api/stats/summary/all` - Comprehensive stats summary (7/30/90 days)
- `GET /api/stats/system/:hours` - System metrics history
- `GET /api/stats/migration/:days` - Migration stats history
- `GET /api/stats/cleanup/:days` - Cleanup stats history

## Configuration Changes

- Added `schema_version` config key (set to 2)

## UI Changes

### Enhanced Stats Page
- Summary cards showing:
  - Total pins
  - Pins served (90-day count and bytes)
  - Migrations (90-day count and bytes)
  - Storage freed (90-day total)
- Period selector tabs (7/30/90 days)
- Migration statistics section
- Cleanup & GC statistics section
- System metrics section (CPU, memory, disk)
- Existing bandwidth chart (preserved)
- Detailed traffic stats table (preserved)

## Migration Steps

1. ✅ Run `node scripts/initDatabase.js` to create new tables
2. ✅ Deploy updated code (workers, API, UI)
3. ⏳ Wait for workers to collect data:
   - Migration worker runs every 12 hours
   - Cleanup worker runs daily at 2 AM
   - Health reporter runs every 6 hours
4. ⏳ Stats will populate over time

## Rollback Plan

If issues occur:
1. The new tables are separate - old functionality unchanged
2. Remove/comment out new API endpoints
3. Revert stats.ejs to previous version
4. Old stats page will work as before

## Notes

- New tables use `ON CONFLICT` for upsert operations
- All changes are backward compatible
- Existing stats and functionality preserved
- Schema version tracked in config table
