const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { stubModule, loadFresh, fakeRes, routeHandler } = require('./helpers');

// GET /health is the contract the Traffic Director routes uploads on
// (trafficdirector utils/healthCheck.js reads enabled, disk_usage_percent
// and pins.*), so its shape is pinned down here.

let state;

stubModule('utils/database', {
  getDatabase: () => ({
    getConfig: async () => state.enabled,
    getPinStats: async () => state.pinStats,
    all: async () => [state.traffic]
  })
});
stubModule('utils/ipfs', {
  getIPFSClient: () => ({
    isRunning: async () => state.running,
    repoStat: async () => {
      if (state.repo instanceof Error) throw state.repo;
      return state.repo;
    }
  })
});

const router = loadFresh('routes/health');
const health = routeHandler(router, 'get', '/');

beforeEach(() => {
  state = {
    running: true,
    enabled: 'true',
    pinStats: { total: 1788, pending_migration: 637, overdue: 213 },
    repo: { RepoSize: '92180407103', StorageMax: '500000000000' },
    traffic: { bytes_in: 5 * 1024 * 1024, bytes_out: 20 * 1024 * 1024 }
  };
});

async function get() {
  const res = fakeRes();
  await health({}, res);
  return res;
}

describe('GET /health', () => {
  test('returns the fields the Traffic Director reads', async () => {
    const res = await get();
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.enabled, true);
    assert.equal(res.body.disk_usage_percent, 18);
    assert.deepEqual(res.body.pins, { total: 1788, pending_migration: 637, overdue: 213 });
    assert.deepEqual(res.body.bandwidth_24h, { in_mb: 5, out_mb: 20 });
    assert.ok(!Number.isNaN(Date.parse(res.body.timestamp)));
  });

  test('overdue pins do not flip enabled', async () => {
    state.pinStats.overdue = 10000;
    const res = await get();
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.enabled, true);
  });

  test('enabled reflects the config flag', async () => {
    state.enabled = 'false';
    assert.equal((await get()).body.enabled, false);
  });

  test('503 when IPFS is not running', async () => {
    state.running = false;
    const res = await get();
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.enabled, false);
  });

  test('repoStat failure reports 0% disk instead of failing', async () => {
    state.repo = new Error('timeout');
    const res = await get();
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.disk_usage_percent, 0);
  });

  test('null pin stats are reported as zeros', async () => {
    state.pinStats = { total: 0, pending_migration: null, overdue: null };
    assert.deepEqual((await get()).body.pins, { total: 0, pending_migration: 0, overdue: 0 });
  });

  test('500 with enabled=false when the database throws', async () => {
    state.pinStats = null;
    state.enabled = 'true';
    const res = fakeRes();
    stubModule('utils/database', { getDatabase: () => { throw new Error('locked'); } });
    const failing = routeHandler(loadFresh('routes/health'), 'get', '/');
    await failing({}, res);
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.enabled, false);
  });
});
