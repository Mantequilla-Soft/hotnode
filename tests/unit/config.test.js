const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { loadFresh } = require('./helpers');

describe('health.overdue_alert_repo_percent', () => {
  afterEach(() => delete process.env.HEALTH_OVERDUE_ALERT_REPO_PERCENT);

  test('defaults to 30', () => {
    delete process.env.HEALTH_OVERDUE_ALERT_REPO_PERCENT;
    assert.equal(loadFresh('utils/config').health.overdue_alert_repo_percent, 30);
  });

  test('reads HEALTH_OVERDUE_ALERT_REPO_PERCENT', () => {
    process.env.HEALTH_OVERDUE_ALERT_REPO_PERCENT = '55';
    assert.equal(loadFresh('utils/config').health.overdue_alert_repo_percent, 55);
  });
});

describe('calculateBatchSize', () => {
  const { calculateBatchSize } = loadFresh('utils/config');

  test('steps min/mid/max at 50 and 200 overdue (normal mode, per 12h cycle)', () => {
    assert.equal(calculateBatchSize(0), 10);
    assert.equal(calculateBatchSize(50), 10);
    assert.equal(calculateBatchSize(51), 20);
    assert.equal(calculateBatchSize(200), 20);
    assert.equal(calculateBatchSize(201), 30);
  });

  test('uses the selected mode', () => {
    assert.equal(calculateBatchSize(0, 'mild'), 5);
    assert.equal(calculateBatchSize(1000, 'mild'), 15);
    assert.equal(calculateBatchSize(0, 'aggressive'), 20);
    assert.equal(calculateBatchSize(1000, 'aggressive'), 60);
  });

  test('unknown mode falls back to normal', () => {
    assert.equal(calculateBatchSize(1000, 'warp'), 30);
  });

  test('a positive maxDaily overrides the mode, halved per cycle', () => {
    assert.equal(calculateBatchSize(0, 'mild', 60), 30);
    assert.equal(calculateBatchSize(1000, 'aggressive', 7), 3);
  });

  test('zero or null maxDaily is ignored', () => {
    assert.equal(calculateBatchSize(1000, 'normal', 0), 30);
    assert.equal(calculateBatchSize(1000, 'normal', null), 30);
  });
});

describe('getMigrationRateConfig', () => {
  const { getMigrationRateConfig } = loadFresh('utils/config');
  const fakeDb = (values) => ({ getConfig: async (key) => values[key] ?? null });

  test('reads mode and max daily from the db', async () => {
    const cfg = await getMigrationRateConfig(fakeDb({ migration_rate_mode: 'mild', migration_max_daily: '60' }), 500);
    assert.deepEqual(cfg, { mode: 'mild', maxDaily: 60, batchSize: 30 });
  });

  test('defaults to normal mode with no max daily', async () => {
    const cfg = await getMigrationRateConfig(fakeDb({}), 500);
    assert.deepEqual(cfg, { mode: 'normal', maxDaily: null, batchSize: 30 });
  });
});
