const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
require('./helpers');
const { Database } = require('../../utils/database');

// The real schema (scripts/initDatabase.js), so these tests can't drift from it.
const { schema } = require('../../scripts/initDatabase');

let db;

beforeEach(async () => {
  db = new Database();
  db.db = new sqlite3.Database(':memory:');
  await new Promise((resolve, reject) => db.db.exec(schema, (err) => (err ? reject(err) : resolve())));
});

afterEach(() => new Promise(resolve => db.db.close(resolve)));

function addPin(cid, { daysAgo, status = 'valid', migrated = 0 }) {
  return db.run(
    `INSERT INTO pins (cid, added_at, status, migrated) VALUES (?, datetime('now', ?), ?, ?)`,
    [cid, `-${daysAgo} days`, status, migrated]
  );
}

describe('getPinStats', () => {
  test('empty table', async () => {
    const stats = await db.getPinStats();
    assert.equal(stats.total, 0);
    assert.equal(stats.overdue, null);
  });

  test('overdue = older than 7 days and not migrated', async () => {
    await addPin('fresh', { daysAgo: 1 });
    await addPin('six-days', { daysAgo: 6 });
    await addPin('eight-days', { daysAgo: 8 });
    await addPin('thirty-days', { daysAgo: 30 });
    await addPin('old-but-migrated', { daysAgo: 30, migrated: 1 });

    const stats = await db.getPinStats();
    assert.equal(stats.total, 5);
    assert.equal(stats.overdue, 2);
    assert.equal(stats.migrated, 1);
    assert.equal(stats.pending_migration, 4);
  });

  test('counts statuses separately', async () => {
    await addPin('p', { daysAgo: 0, status: 'pending' });
    await addPin('v', { daysAgo: 0, status: 'valid' });
    await addPin('i', { daysAgo: 0, status: 'invalid' });

    const stats = await db.getPinStats();
    assert.equal(stats.pending, 1);
    assert.equal(stats.invalid, 1);
    assert.equal(stats.pending_migration, 1);
  });
});

describe('getOverduePins', () => {
  test('valid, unmigrated, older than 7 days, oldest first', async () => {
    await addPin('ten', { daysAgo: 10 });
    await addPin('twenty', { daysAgo: 20 });
    await addPin('three', { daysAgo: 3 });
    await addPin('migrated', { daysAgo: 20, migrated: 1 });

    const pins = await db.getOverduePins();
    assert.deepEqual(pins.map(p => p.cid), ['twenty', 'ten']);
  });
});
