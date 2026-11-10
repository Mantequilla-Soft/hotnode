const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
require('./helpers');
const { getHealthReporter } = require('../../workers/healthReporter');

let reporter;
let state;

beforeEach(() => {
  state = { running: true, enabled: 'true', overdue: 0, repo: { RepoSize: '18', StorageMax: '100' }, config: {} };
  reporter = getHealthReporter();
  reporter.ipfs = {
    isRunning: async () => state.running,
    repoStat: async () => state.repo
  };
  reporter.db = {
    getConfig: async key => (key === 'enabled' ? state.enabled : state.config[key] ?? null),
    getPinStats: async () => ({ total: 100, pending_migration: 7, overdue: state.overdue })
  };
});

describe('collectHealthMetrics', () => {
  test('healthy node', async () => {
    const h = await reporter.collectHealthMetrics();
    assert.equal(h.status, 'healthy');
    assert.equal(h.reason, null);
    assert.equal(h.disk_usage_percent, 18);
    assert.equal(h.total_pins, 100);
    assert.equal(h.pending_migration, 7);
  });

  test('IPFS down is unhealthy', async () => {
    state.running = false;
    const h = await reporter.collectHealthMetrics();
    assert.equal(h.status, 'unhealthy');
    assert.equal(h.ipfs_running, false);
  });

  test('disabled wins over everything else', async () => {
    state.enabled = 'false';
    state.repo = { RepoSize: '95', StorageMax: '100' };
    state.overdue = 500;
    assert.equal((await reporter.collectHealthMetrics()).status, 'disabled');
  });

  test('disk above 90% is unhealthy, above 80% is a warning', async () => {
    state.repo = { RepoSize: '91', StorageMax: '100' };
    assert.equal((await reporter.collectHealthMetrics()).status, 'unhealthy');
    state.repo = { RepoSize: '81', StorageMax: '100' };
    assert.equal((await reporter.collectHealthMetrics()).status, 'warning');
  });

  test('warning/critical thresholds come from the Settings page', async () => {
    state.config = { disk_warning_percent: '60', disk_critical_percent: '70' };
    state.repo = { RepoSize: '65', StorageMax: '100' };
    assert.equal((await reporter.collectHealthMetrics()).status, 'warning');
    state.repo = { RepoSize: '71', StorageMax: '100' };
    assert.equal((await reporter.collectHealthMetrics()).status, 'unhealthy');
  });

  test('capacity cutoff active is unhealthy with a reason', async () => {
    state.config = { capacity_paused: 'true' };
    state.repo = { RepoSize: '78', StorageMax: '100' };
    const h = await reporter.collectHealthMetrics();
    assert.equal(h.status, 'unhealthy');
    assert.equal(h.capacity_paused, true);
    assert.match(h.reason, /capacity cutoff \(80%\)/);
  });

  test('more than 50 overdue pins is only a warning', async () => {
    state.overdue = 213;
    const h = await reporter.collectHealthMetrics();
    assert.equal(h.status, 'warning');
    assert.equal(h.reason, 'Many overdue pins');
    assert.equal(h.overdue_pins, 213);
  });
});
