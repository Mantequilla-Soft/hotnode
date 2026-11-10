const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { stubModule, loadFresh } = require('./helpers');

// The real module pulls in the Mongo client; checkOverduePins doesn't need it.
stubModule('workers/syncLastServedWorker', { LAST_SYNC_OK_KEY: 'last_sync_ok' });

const config = require('../../utils/config');
const { getCleanupWorker } = loadFresh('workers/cleanupWorker');

let worker;
let alerts;
let repo;

beforeEach(() => {
  worker = getCleanupWorker();
  alerts = [];
  repo = { RepoSize: '18', StorageMax: '100' };
  worker.db = {
    overdue: 213,
    async getPinStats() { return { total: 1788, overdue: this.overdue }; },
    config: {},
    async getConfig(key) { return this.config[key] ?? null; },
    async get() { return { age: 12.7 }; }
  };
  worker.ipfs = {
    async repoStat() {
      if (repo instanceof Error) throw repo;
      return repo;
    }
  };
  worker.discord = { notifyOverduePins: async (...args) => alerts.push(args) };
});

describe('checkOverduePins', () => {
  test('no overdue pins: no alert', async () => {
    worker.db.overdue = 0;
    repo = { RepoSize: '90', StorageMax: '100' };
    const result = await worker.checkOverduePins();
    assert.deepEqual(result, { overdue: 0, oldestAge: 0, alerted: false });
    assert.equal(alerts.length, 0);
  });

  test('overdue pins below the repo threshold: no alert', async () => {
    const result = await worker.checkOverduePins();
    assert.equal(result.alerted, false);
    assert.equal(result.overdue, 213);
    assert.equal(alerts.length, 0);
  });

  test('overdue pins at the threshold: alerts with count, oldest age and repo usage', async () => {
    repo = { RepoSize: '30', StorageMax: '100' };
    const result = await worker.checkOverduePins();
    assert.deepEqual(result, { overdue: 213, oldestAge: 12, alerted: true });
    assert.deepEqual(alerts, [[213, 12, 30]]);
  });

  test('alerts again on every run while the condition holds', async () => {
    repo = { RepoSize: '45', StorageMax: '100' };
    await worker.checkOverduePins();
    await worker.checkOverduePins();
    await worker.checkOverduePins();
    assert.equal(alerts.length, 3);
  });

  test('threshold comes from config', async () => {
    const original = config.health.overdue_alert_repo_percent;
    config.health.overdue_alert_repo_percent = 10;
    try {
      await worker.checkOverduePins();
      assert.deepEqual(alerts, [[213, 12, 18]]);
    } finally {
      config.health.overdue_alert_repo_percent = original;
    }
  });

  test('a Settings page override beats the .env default', async () => {
    worker.db.config.overdue_alert_repo_percent = '15';
    await worker.checkOverduePins();
    assert.deepEqual(alerts, [[213, 12, 18]]);
  });

  test('repo usage unreadable: alerts anyway, without a usage figure', async () => {
    repo = new Error('kubo unreachable');
    const result = await worker.checkOverduePins();
    assert.equal(result.alerted, true);
    assert.deepEqual(alerts, [[213, 12, null]]);
  });

  test('StorageMax of 0 counts as unreadable and alerts', async () => {
    repo = { RepoSize: '50', StorageMax: '0' };
    await worker.checkOverduePins();
    assert.deepEqual(alerts, [[213, 12, null]]);
  });

  test('a database error is swallowed and reported as nothing overdue', async () => {
    worker.db.getPinStats = async () => { throw new Error('locked'); };
    const result = await worker.checkOverduePins();
    assert.deepEqual(result, { overdue: 0, oldestAge: 0, alerted: false });
    assert.equal(alerts.length, 0);
  });
});

describe('getRepoUsagePercent', () => {
  test('rounds RepoSize / StorageMax to a whole percent', async () => {
    repo = { RepoSize: '92180407103', StorageMax: '500000000000' };
    assert.equal(await worker.getRepoUsagePercent(), 18);
  });

  test('null when repoStat throws', async () => {
    repo = new Error('down');
    assert.equal(await worker.getRepoUsagePercent(), null);
  });
});
