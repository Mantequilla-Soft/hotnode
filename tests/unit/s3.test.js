const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const { stubModule, loadFresh } = require('./helpers');

stubModule('workers/syncLastServedWorker', { LAST_SYNC_OK_KEY: 'last_sync_ok' });

const { Database } = require('../../utils/database');
const { schema } = require('../../scripts/initDatabase');
const { MigratorClient, missingSettings, sign, verifySignature } = require('../../utils/migrator');
const { S3Worker, MAX_ATTEMPTS } = require('../../workers/s3Worker');
const { createS3CallbackRouter } = require('../../routes/s3Callback');

const SECRET = 'h'.repeat(40);
const CID = 'QmUaWTmYmQ7NGi7Cq1YndpzjB1UNTmmgnhk1AxDTC8DS2g';
const CID2 = 'QmSUSaQCXdtaSWdafK6nrkwkv6MQeEbjNSBJ84G3NodKmY';
const CID3 = 'QmPZ9gcCEpqKTo6aq61g2nXGUhM4iCL3ewB6LDXZCtioEB';
const S3_URL = `https://buttercloud.b-cdn.net/admin-9eab69/${CID}/manifest.m3u8`;

let db, client, alerts, worker, clock;

async function addPin(cid, { daysAgo = 10, status = 'valid', ...fields } = {}) {
  await db.run(`INSERT INTO pins (cid, added_at, status, size_bytes, owner, permlink) VALUES (?, datetime('now', ?), ?, 1000, 'coolmole', ?)`,
    [cid, `-${daysAgo} days`, status, `p-${cid.slice(2, 6)}`]);
  if (Object.keys(fields).length) await db.updatePin(cid, fields);
}

beforeEach(async () => {
  db = new Database();
  db.db = new sqlite3.Database(':memory:');
  await new Promise((resolve, reject) => db.db.exec(schema, (err) => (err ? reject(err) : resolve())));
  await db.setConfig('migration_target', 's3');
  clock = Date.now();
  client = {
    requested: [], archived: [], states: {}, answers: null, archiveFails: false,
    async requestCids(cids) {
      this.requested.push(...cids);
      return this.answers ? this.answers(cids) : cids.map((cid) => ({ cid, status: 'queued', items: [1] }));
    },
    async archive(cid) {
      if (this.archiveFails) throw Object.assign(new Error('migrator unreachable'), { code: null });
      this.archived.push(cid);
      return { cid, archived: 1 };
    },
    async cidState(cid) { return this.states[cid] ?? { state: 'unknown' }; },
  };
  alerts = [];
  worker = new S3Worker({ db, client, discord: { send: async (...a) => alerts.push(a) }, now: () => clock });
});

afterEach(() => new Promise((resolve) => db.db.close(resolve)));

describe('migrator settings and signatures', () => {
  test('a signature is HMAC-SHA256 of timestamp.body, and must be fresh', () => {
    const body = '{"id":"evt_1"}';
    const now = Date.now();
    const ts = String(Math.floor(now / 1000));
    const sig = sign(SECRET, ts, body);
    // Spelled out independently: the migrator's recipe (its SPEC §15).
    assert.equal(sig, `sha256=${crypto.createHmac('sha256', SECRET).update(`${ts}.${body}`).digest('hex')}`);
    assert.equal(verifySignature(SECRET, { timestamp: ts, signature: sig, body, now }), true);
    assert.equal(verifySignature('w'.repeat(40), { timestamp: ts, signature: sig, body, now }), false);
    assert.equal(verifySignature(SECRET, { timestamp: ts, signature: sig, body: '{"id":"evt_2"}', now }), false);
    assert.equal(verifySignature(SECRET, { timestamp: ts, signature: sig, body, now: now + 301_000 }), false);
    assert.equal(verifySignature('', { timestamp: ts, signature: sign('', ts, body), body, now }), false);
  });

  test('the token never goes over plain http to another machine', () => {
    const base = { token: 't'.repeat(40), callback_secret: SECRET };
    assert.deepEqual(missingSettings({ ...base, url: 'http://127.0.0.1:3021' }), []);
    assert.deepEqual(missingSettings({ ...base, url: 'https://migrator.internal' }), []);
    assert.match(missingSettings({ ...base, url: 'http://10.0.0.2:3021' })[0], /https, or http on 127/);
    assert.deepEqual(missingSettings({ url: '', token: '', callback_secret: 'short' }),
      ['MIGRATOR_SERVICE_URL', 'MIGRATOR_SERVICE_TOKEN', 'HOTNODE_CALLBACK_SECRET (at least 32 characters)']);
  });

  test('the client sends the token, splits big batches, and reports codes', async () => {
    const calls = [];
    const fetchImpl = async (url, opts) => {
      calls.push({ url, opts, body: opts.body && JSON.parse(opts.body) });
      if (url.endsWith('/api/archive')) return new Response(JSON.stringify({ error: 'not copied', code: 'not_copied' }), { status: 409 });
      const { cids } = JSON.parse(opts.body);
      return new Response(JSON.stringify({ jobId: 1, cids: cids.map((cid) => ({ cid, status: 'queued' })) }), { status: 202 });
    };
    const c = new MigratorClient({ cfg: { url: 'http://127.0.0.1:3021', token: 't'.repeat(40), callback_secret: SECRET }, fetchImpl });
    const answers = await c.requestCids(Array.from({ length: 150 }, (_, i) => `c${i}`));
    assert.equal(answers.length, 150);
    assert.deepEqual(calls.map((x) => x.body.cids.length), [100, 50]);
    assert.equal(calls[0].opts.headers.Authorization, `Bearer ${'t'.repeat(40)}`);
    assert.equal(calls[0].body.mode, 'hot');
    await assert.rejects(c.archive(CID), { status: 409, code: 'not_copied' });
  });
});

describe('requesting copies', () => {
  test('asks for valid, held pins old enough, oldest first, and records the answers', async () => {
    await addPin(CID, { daysAgo: 9 });
    await addPin(CID2, { daysAgo: 20 });
    await addPin(CID3, { daysAgo: 1 });                                   // too young
    await addPin('QmInvalid', { daysAgo: 30, status: 'invalid' });
    await addPin('QmGone', { daysAgo: 30, unpinned: 1 });
    await addPin('QmAsked', { daysAgo: 30, s3_state: 'requested' });
    client.answers = (cids) => cids.map((cid) => (cid === CID2
      ? { cid, status: 'rejected', reason: 'not_ipfs', detail: 'legacy x: video_v2 is not ipfs://' }
      : { cid, status: 'queued', items: [7] }));
    const r = await worker.requestBatch(10);
    assert.deepEqual(client.requested, [CID2, CID]);
    assert.deepEqual({ requested: r.requested, rejected: r.rejected }, { requested: 1, rejected: 1 });
    assert.equal((await db.getPin(CID)).s3_state, 'requested');
    const rejected = await db.getPin(CID2);
    assert.deepEqual([rejected.s3_state, rejected.s3_error_code, rejected.s3_retryable], ['rejected', 'not_ipfs', 0]);
    // Asked already: not asked again.
    client.requested = [];
    await worker.requestBatch(10);
    assert.deepEqual(client.requested, []);
  });

  test('a retryable failure is asked again once its backoff has passed', async () => {
    await addPin(CID, { s3_state: 'failed', s3_retryable: 1, s3_next_attempt_at: new Date(Date.now() + 3600e3).toISOString() });
    await addPin(CID2, { s3_state: 'failed', s3_retryable: 1, s3_next_attempt_at: new Date(Date.now() - 1000).toISOString() });
    await addPin(CID3, { s3_state: 'failed', s3_retryable: 0 });
    await worker.requestBatch(10);
    assert.deepEqual(client.requested, [CID2]);
  });

  test('the Migrate button asks for one pin at any age, but not one already copied', async () => {
    await addPin(CID, { daysAgo: 0 });
    await addPin(CID2, { s3_state: 'copied' });
    assert.equal((await worker.requestOne(CID)).status, 'queued');
    assert.equal((await db.getPin(CID)).s3_state, 'requested');
    await assert.rejects(worker.requestOne(CID2), { status: 400 });
    await assert.rejects(worker.requestOne(CID3), { status: 404 });
  });
});

describe('events', () => {
  test('copied marks the pin copied and migrated, counts it once', async () => {
    await addPin(CID, { s3_state: 'requested' });
    const ev = { event: 'copied', cid: CID, s3_url: S3_URL, s3_car_url: 'https://s3.3speak.tv/x/car/c.car', bytes: 900, warnings: [] };
    await worker.handleEvent(ev);
    const pin = await db.getPin(CID);
    assert.deepEqual([pin.s3_state, pin.s3_url, pin.s3_bytes, pin.migrated], ['copied', S3_URL, 900, 1]);
    await worker.handleEvent(ev);   // already_copied later, for instance
    const [stats] = await db.getMigrationStats(1);
    assert.equal(stats.success_count, 1);
    assert.equal(client.archived.length, 0);
  });

  test('copied for a pin already unpinned here flips it to archived', async () => {
    await addPin(CID, { s3_state: 'requested', unpinned: 1 });
    await worker.handleEvent({ event: 'copied', cid: CID, s3_url: S3_URL });
    assert.deepEqual(client.archived, [CID]);
    assert.equal((await db.getPin(CID)).s3_state, 'archived');
  });

  test('failed backs off 1 h, doubling, then gives up with one alert', async () => {
    await addPin(CID, { s3_state: 'requested' });
    for (let i = 1; i <= MAX_ATTEMPTS; i++) {
      await worker.handleEvent({ event: 'failed', cid: CID, error: { code: 'download_failed', message: 'timed out' }, retryable: true });
      const pin = await db.getPin(CID);
      assert.equal(pin.s3_attempts, i);
      if (i < MAX_ATTEMPTS) {
        assert.equal(pin.s3_retryable, 1);
        assert.equal(Date.parse(pin.s3_next_attempt_at) - clock, 3600e3 * 2 ** (i - 1));
      }
    }
    const pin = await db.getPin(CID);
    assert.deepEqual([pin.s3_state, pin.s3_retryable, pin.s3_error_code], ['failed', 0, 'download_failed']);
    assert.equal(alerts.length, 1);
    assert.match(alerts[0][1], /coolmole\//);
  });

  test('a failure that asking again cannot fix alerts at once', async () => {
    await addPin(CID, { s3_state: 'requested' });
    await worker.handleEvent({ event: 'failed', cid: CID, error: { code: 'bad_car', message: 'block x does not match' }, retryable: false });
    assert.equal((await db.getPin(CID)).s3_retryable, 0);
    assert.equal(alerts.length, 1);
  });
});

describe('cleanup gate', () => {
  test('with S3 on, only confirmed copies are dormant candidates', async () => {
    await addPin(CID, { daysAgo: 60, s3_state: 'copied' });
    await addPin(CID2, { daysAgo: 60, s3_state: 'requested', migrated: 1 });   // on the supernode, not in S3
    await addPin(CID3, { daysAgo: 60 });
    const gated = await db.getDormantPinsForCleanup(30, 7, { requireS3: true });
    assert.deepEqual(gated.map((p) => p.cid), [CID]);
    const old = await db.getDormantPinsForCleanup(30, 7);
    assert.equal(old.length, 3);
  });

  test('cleanup unpins a copied pin, then asks for the flip to archived', async () => {
    const { getCleanupWorker } = loadFresh('workers/cleanupWorker');
    const cleanup = getCleanupWorker();
    const unpinned = [];
    cleanup.db = db;
    cleanup.ipfs = { async pinRm(cid) { unpinned.push(cid); } };
    await db.setConfig('last_sync_ok', new Date().toISOString());
    await addPin(CID, { daysAgo: 60, s3_state: 'copied' });
    await addPin(CID2, { daysAgo: 60 });
    // Its S3 worker is the singleton: point it at this test's fakes.
    const { getS3Worker } = require('../../workers/s3Worker');
    Object.assign(getS3Worker(), { db, client, discord: worker.discord });
    const r = await cleanup.unpinDormantContent();
    assert.equal(r.unpinned, 1);
    assert.deepEqual(unpinned, [CID]);
    assert.deepEqual(client.archived, [CID]);
    assert.equal((await db.getPin(CID)).s3_state, 'archived');
  });
});

describe('catch-up', () => {
  test('takes the migrator\'s state for requests that never got an event', async () => {
    const old = new Date(Date.now() - 7 * 3600e3).toISOString();
    await addPin(CID, { s3_state: 'requested', s3_requested_at: old });
    await addPin(CID2, { s3_state: 'requested', s3_requested_at: old });
    await addPin(CID3, { s3_state: 'requested', s3_requested_at: new Date().toISOString() });   // too recent
    client.states[CID] = { state: 'copied', documents: [{ s3_url: S3_URL }], last_event: { event: 'copied', bytes: 5 } };
    client.states[CID2] = { state: 'unknown' };   // the request was lost: ask again
    const gone = 'QmUnknownUnknownUnknownUnknownUnknownUnknown12';
    await addPin(gone, { s3_state: 'requested', s3_requested_at: old });
    client.states[gone] = { state: 'unknown', reason: 'not_in_mongo' };   // can never be copied
    const r = await worker.catchUp();
    assert.equal(r.checked, 3);
    assert.deepEqual([(await db.getPin(gone)).s3_state, (await db.getPin(gone)).s3_error_code], ['rejected', 'not_in_mongo']);
    assert.equal((await db.getPin(CID)).s3_state, 'copied');
    assert.equal((await db.getPin(CID2)).s3_state, null);
    assert.equal((await db.getPin(CID3)).s3_state, 'requested');
  });

  test('retries a flip to archived that failed after an unpin', async () => {
    await addPin(CID, { s3_state: 'copied', unpinned: 1 });
    client.archiveFails = true;
    assert.equal(await worker.archiveAfterUnpin(CID), false);
    assert.equal((await db.getPin(CID)).s3_state, 'copied');
    client.archiveFails = false;
    assert.equal((await worker.catchUp()).archived, 1);
    assert.equal((await db.getPin(CID)).s3_state, 'archived');
  });
});

describe('POST /api/s3/callback', () => {
  let server, base;
  beforeEach(async () => {
    const app = express();
    app.use('/api/s3/callback', createS3CallbackRouter({ db, worker, secret: SECRET }));
    app.use(express.json());   // as in app.js: after the callback
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}/api/s3/callback`;
  });
  afterEach(() => new Promise((r) => server.close(r)));

  const post = (ev, { secret = SECRET, ts = Math.floor(Date.now() / 1000), headers = {} } = {}) => {
    const body = JSON.stringify(ev);
    return fetch(base, {
      method: 'POST', body,
      headers: { 'Content-Type': 'application/json', 'X-Migrator-Timestamp': String(ts), 'X-Migrator-Signature': sign(secret, String(ts), body), ...headers },
    });
  };

  test('applies a signed event once, and refuses bad, stale or proxied ones', async () => {
    await addPin(CID, { s3_state: 'requested' });
    const ev = { id: 'evt_1', event: 'copied', cid: CID, s3_url: S3_URL };
    assert.equal((await post(ev, { secret: 'w'.repeat(40) })).status, 401);
    assert.equal((await post(ev, { ts: Math.floor(Date.now() / 1000) - 600 })).status, 401);
    assert.equal((await post(ev, { headers: { 'X-Forwarded-For': '203.0.113.9' } })).status, 403);
    assert.equal((await db.getPin(CID)).s3_state, 'requested');

    const ok = await post(ev);
    assert.equal(ok.status, 200);
    assert.equal((await db.getPin(CID)).s3_state, 'copied');
    const again = await (await post(ev)).json();
    assert.equal(again.duplicate, true);
  });

  test('a failure while recording answers 500 and forgets the id, so the retry works', async () => {
    await addPin(CID, { s3_state: 'requested' });
    const real = worker.handleEvent.bind(worker);
    worker.handleEvent = async () => { throw new Error('disk full'); };
    const ev = { id: 'evt_2', event: 'copied', cid: CID, s3_url: S3_URL };
    assert.equal((await post(ev)).status, 500);
    worker.handleEvent = real;
    assert.equal((await post(ev)).status, 200);
    assert.equal((await db.getPin(CID)).s3_state, 'copied');
  });
});
