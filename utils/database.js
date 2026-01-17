const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { DB_PATH } = require('../scripts/initDatabase');

class Database {
  constructor() {
    this.db = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.db = new sqlite3.Database(DB_PATH, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  close() {
    return new Promise((resolve, reject) => {
      if (this.db) {
        this.db.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      } else {
        resolve();
      }
    });
  }

  // Generic query methods
  run(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.run(sql, params, function(err) {
        if (err) reject(err);
        else resolve({ id: this.lastID, changes: this.changes });
      });
    });
  }

  get(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.get(sql, params, (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  }

  all(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  }

  // Pin management methods
  async insertPin(pin) {
    const sql = `
      INSERT OR IGNORE INTO pins (cid, size_bytes, status, notes)
      VALUES (?, ?, ?, ?)
    `;
    return this.run(sql, [
      pin.cid,
      pin.size_bytes || null,
      pin.status || 'pending',
      pin.notes || null
    ]);
  }

  async getPin(cid) {
    const sql = 'SELECT * FROM pins WHERE cid = ?';
    return this.get(sql, [cid]);
  }

  async updatePin(cid, updates) {
    const fields = [];
    const values = [];
    
    for (const [key, value] of Object.entries(updates)) {
      fields.push(`${key} = ?`);
      values.push(value);
    }
    
    values.push(cid);
    
    const sql = `UPDATE pins SET ${fields.join(', ')} WHERE cid = ?`;
    return this.run(sql, values);
  }

  async getPendingPins() {
    const sql = 'SELECT * FROM pins WHERE status = ? ORDER BY added_at ASC';
    return this.all(sql, ['pending']);
  }

  async getValidPinsForMigration(startDays, limit) {
    const sql = `
      SELECT * FROM pins 
      WHERE status = 'valid' 
      AND migrated = 0 
      AND julianday('now') - julianday(added_at) >= ?
      ORDER BY added_at ASC 
      LIMIT ?
    `;
    return this.all(sql, [startDays, limit]);
  }

  async getMigratedPinsForCleanup(deleteDays) {
    const sql = `
      SELECT * FROM pins 
      WHERE status = 'valid' 
      AND migrated = 1 
      AND unpinned = 0
      AND julianday('now') - julianday(added_at) >= ?
      ORDER BY added_at ASC
    `;
    return this.all(sql, [deleteDays]);
  }

  async getInvalidPinsForCleanup(retentionDays) {
    const sql = `
      SELECT * FROM pins 
      WHERE status = 'invalid' 
      AND julianday('now') - julianday(added_at) >= ?
    `;
    return this.all(sql, [retentionDays]);
  }

  async deletePin(cid) {
    const sql = 'DELETE FROM pins WHERE cid = ?';
    return this.run(sql, [cid]);
  }

  async getPinStats() {
    const sql = `
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'valid' AND migrated = 0 THEN 1 ELSE 0 END) as pending_migration,
        SUM(CASE WHEN migrated = 1 THEN 1 ELSE 0 END) as migrated,
        SUM(CASE WHEN status = 'invalid' THEN 1 ELSE 0 END) as invalid,
        SUM(CASE WHEN julianday('now') - julianday(added_at) > 7 AND migrated = 0 THEN 1 ELSE 0 END) as overdue
      FROM pins
    `;
    return this.get(sql);
  }

  // Config methods
  async getConfig(key) {
    const sql = 'SELECT value FROM config WHERE key = ?';
    const row = await this.get(sql, [key]);
    return row ? row.value : null;
  }

  async setConfig(key, value) {
    const sql = `
      INSERT OR REPLACE INTO config (key, value, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
    `;
    return this.run(sql, [key, value]);
  }

  async getAllConfig() {
    const sql = 'SELECT key, value FROM config';
    return this.all(sql);
  }

  // Traffic stats methods
  async insertTrafficStats(stats) {
    const sql = `
      INSERT INTO traffic_stats (period, bytes_in, bytes_out, requests_count)
      VALUES (?, ?, ?, ?)
    `;
    return this.run(sql, [
      stats.period,
      stats.bytes_in || 0,
      stats.bytes_out || 0,
      stats.requests_count || 0
    ]);
  }

  async getTrafficStats(period, limit = 24) {
    const sql = `
      SELECT * FROM traffic_stats 
      WHERE period = ? 
      ORDER BY timestamp DESC 
      LIMIT ?
    `;
    return this.all(sql, [period, limit]);
  }

  async cleanOldStats(retentionDays) {
    const sql = `
      DELETE FROM traffic_stats 
      WHERE julianday('now') - julianday(timestamp) > ?
    `;
    return this.run(sql, [retentionDays]);
  }

  // GC logs methods
  async insertGCLog(log) {
    const sql = `
      INSERT INTO gc_logs (duration_seconds, freed_bytes, error)
      VALUES (?, ?, ?)
    `;
    return this.run(sql, [
      log.duration_seconds || null,
      log.freed_bytes || null,
      log.error || null
    ]);
  }

  async getRecentGCLogs(limit = 10) {
    const sql = 'SELECT * FROM gc_logs ORDER BY run_at DESC LIMIT ?';
    return this.all(sql, [limit]);
  }

  // Events methods
  async logEvent(event) {
    const sql = `
      INSERT INTO events (event_type, severity, message, metadata)
      VALUES (?, ?, ?, ?)
    `;
    return this.run(sql, [
      event.event_type,
      event.severity || 'info',
      event.message || null,
      event.metadata ? JSON.stringify(event.metadata) : null
    ]);
  }

  async getRecentEvents(limit = 50) {
    const sql = 'SELECT * FROM events ORDER BY timestamp DESC LIMIT ?';
    return this.all(sql, [limit]);
  }

  async getEventsByType(eventType, limit = 50) {
    const sql = `
      SELECT * FROM events 
      WHERE event_type = ? 
      ORDER BY timestamp DESC 
      LIMIT ?
    `;
    return this.all(sql, [eventType, limit]);
  }
}

// Singleton instance
let instance = null;

function getDatabase() {
  if (!instance) {
    instance = new Database();
  }
  return instance;
}

module.exports = { Database, getDatabase };
