const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
require('./helpers');
const capacity = require('../../utils/capacity');

let db;
beforeEach(() => {
  db = {
    config: {},
    events: [],
    async getConfig(key) { return this.config[key] ?? null; },
    async setConfig(key, value) { this.config[key] = value; },
    async logEvent(e) { this.events.push(e); }
  };
});

const valid = {
  stop_percent: 80, resume_percent: 75, overdue_alert_percent: 30,
  disk_warning_percent: 80, disk_critical_percent: 90
};

describe('getThresholds', () => {
  test('defaults to the .env values', async () => {
    assert.deepEqual(await capacity.getThresholds(db), valid);
  });

  test('DB overrides win; junk values fall back to the default', async () => {
    db.config = { capacity_stop_percent: '92', capacity_resume_percent: 'abc', disk_critical_percent: '150' };
    const t = await capacity.getThresholds(db);
    assert.equal(t.stop_percent, 92);
    assert.equal(t.resume_percent, 75);
    assert.equal(t.disk_critical_percent, 90);
  });
});

describe('validateThresholds', () => {
  test('accepts sane values', () => {
    assert.equal(capacity.validateThresholds(valid), null);
  });

  test('resume must be below stop', () => {
    assert.match(capacity.validateThresholds({ ...valid, resume_percent: 80 }), /Resume/);
  });

  test('warning must be below critical', () => {
    assert.match(capacity.validateThresholds({ ...valid, disk_warning_percent: 95 }), /Warning/);
  });

  test('rejects out-of-range and non-integer values', () => {
    assert.ok(capacity.validateThresholds({ ...valid, stop_percent: 101 }));
    assert.ok(capacity.validateThresholds({ ...valid, stop_percent: 0 }));
    assert.ok(capacity.validateThresholds({ ...valid, overdue_alert_percent: 12.5 }));
    assert.ok(capacity.validateThresholds({ ...valid, overdue_alert_percent: undefined }));
  });
});

describe('evaluateCapacity', () => {
  test('reset ignores the hysteresis band (raising the cutoff applies at once)', async () => {
    db.config.capacity_paused = 'true';
    db.config.capacity_stop_percent = '90';
    db.config.capacity_resume_percent = '85';
    const r = await capacity.evaluateCapacity(db, 87, null, { reset: true });
    assert.equal(r.paused, false);
    assert.equal(r.changed, true);
  });

  test('concurrent evaluations record a transition once', async () => {
    let calls = 0;
    const results = await Promise.all(
      [1, 2, 3, 4].map(() => capacity.evaluateCapacity(db, 95, () => { calls++; }))
    );
    await new Promise(r => setImmediate(r));
    assert.equal(results.filter(r => r.changed).length, 1);
    assert.equal(calls, 1);
  });

  test('a failing notifier does not fail the evaluation', async () => {
    const r = await capacity.evaluateCapacity(db, 95, async () => { throw new Error('webhook down'); });
    assert.equal(r.paused, true);
    await new Promise(r => setImmediate(r));
  });
});

describe('repoUsagePercent', () => {
  test('rounds and treats StorageMax 0 as unknown', () => {
    assert.equal(capacity.repoUsagePercent({ RepoSize: '92180407103', StorageMax: '500000000000' }), 18);
    assert.equal(capacity.repoUsagePercent({ RepoSize: '5', StorageMax: '0' }), null);
  });
});
