const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { PrivateKey, cryptoUtils } = require('@hiveio/dhive');

// A fake Hive API node, so the real login route can be exercised end to end.
const keys = {
  meno: PrivateKey.fromSeed('meno-posting'),
  stranger: PrivateKey.fromSeed('stranger-posting'),
  multisig: PrivateKey.fromSeed('multisig-posting'),
};
const accounts = {
  meno: { key_auths: [[keys.meno.createPublic().toString(), 1]], weight_threshold: 1 },
  stranger: { key_auths: [[keys.stranger.createPublic().toString(), 1]], weight_threshold: 1 },
  // One key, but not enough weight to sign alone.
  multisig: { key_auths: [[keys.multisig.createPublic().toString(), 1]], weight_threshold: 2 },
};
let hive, hiveUrl;
function startHive() {
  hive = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const [[name]] = JSON.parse(body).params;
      const posting = accounts[name];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: posting ? [{ name, posting }] : [] }));
    });
  });
  return new Promise((r) => hive.listen(0, '127.0.0.1', () => { hiveUrl = `http://127.0.0.1:${hive.address().port}`; r(); }));
}

const signWith = (user, message) => keys[user].sign(cryptoUtils.sha256(message)).toString();

describe('createAuth', () => {
  let createAuth, auth, clock;
  before(async () => {
    await startHive();
    require('./helpers');
    ({ createAuth } = require('../../utils/auth'));
  });
  after(() => new Promise((r) => hive.close(r)));

  const fresh = () => {
    clock = 1_000_000;
    auth = createAuth({ allowedUsers: ['meno'], hiveApiNodes: ['http://127.0.0.1:9', hiveUrl], site: 'HotNode-Test', now: () => clock });
  };

  test('a posting-key signature of the challenge logs in; ALLOWED_USERS decides who may act', async () => {
    fresh();
    const c = auth.challenge('@Meno');
    assert.equal(c.user, 'meno');
    assert.match(c.message, /^hotnode:HotNode-Test:meno:/);
    // The first API node is down: the next one answers.
    assert.deepEqual(await auth.verify({ user: 'meno', message: c.message, signature: signWith('meno', c.message) }), { user: 'meno', authorized: true });
    const s = auth.challenge('stranger');
    assert.deepEqual(await auth.verify({ user: 'stranger', message: s.message, signature: signWith('stranger', s.message) }), { user: 'stranger', authorized: false });
    assert.equal(auth.isAllowed('meno'), true);
    assert.equal(auth.isAllowed('stranger'), false);
    assert.equal(auth.isAllowed(null), false);
  });

  test('refuses another key, a reused or expired challenge, an unknown account, a key too weak alone', async () => {
    fresh();
    let c = auth.challenge('meno');
    await assert.rejects(auth.verify({ user: 'meno', message: c.message, signature: signWith('stranger', c.message) }), /not from this account's posting key/);
    // Burnt even though it failed.
    await assert.rejects(auth.verify({ user: 'meno', message: c.message, signature: signWith('meno', c.message) }), /already used/);

    c = auth.challenge('meno');
    clock += 5 * 60 * 1000 + 1;
    await assert.rejects(auth.verify({ user: 'meno', message: c.message, signature: signWith('meno', c.message) }), /expired/);

    c = auth.challenge('meno');
    await assert.rejects(auth.verify({ user: 'stranger', message: c.message, signature: signWith('stranger', c.message) }), /already used/);

    c = auth.challenge('nobody');
    await assert.rejects(auth.verify({ user: 'nobody', message: c.message, signature: signWith('meno', c.message) }), /no such Hive account/);

    c = auth.challenge('multisig');
    await assert.rejects(auth.verify({ user: 'multisig', message: c.message, signature: signWith('multisig', c.message) }), /posting key/);

    c = auth.challenge('meno');
    await assert.rejects(auth.verify({ user: 'meno', message: c.message, signature: 'garbage' }), /not a valid signature/);
    assert.throws(() => auth.challenge('Not An Account!'), { status: 400 });
  });
});

describe('login routes', () => {
  let server, base;
  before(async () => {
    if (!hive || !hive.listening) await startHive();
    process.env.ALLOWED_USERS = 'meno';
    process.env.HIVE_API_NODES = hiveUrl;
    process.env.SESSION_SECRET = 's'.repeat(40);
    const { loadFresh } = require('./helpers');
    loadFresh('utils/config');
    loadFresh('utils/auth');
    const express = require('express');
    const session = require('express-session');
    const api = loadFresh('routes/api');
    const { requireAuth } = require('../../utils/auth');
    const app = express();
    app.use(express.json());
    app.use(session({ secret: process.env.SESSION_SECRET, resave: false, saveUninitialized: false, cookie: { sameSite: 'strict' } }));
    app.use('/api', api);
    app.post('/protected', requireAuth, (req, res) => res.json({ ok: true, user: req.session.user }));
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    await new Promise((r) => server.close(r));
    await new Promise((r) => (hive.listening ? hive.close(r) : r()));
  });

  async function loginAs(user, signer = user) {
    const c = await (await fetch(`${base}/api/auth/challenge?user=${user}`)).json();
    const res = await fetch(`${base}/api/auth/verify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user, message: c.message, signature: signWith(signer, c.message) }),
    });
    return { res, body: await res.json(), cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
  }

  test('an allowed account can act; another account is logged in but refused; a bad signature gets no session', async () => {
    assert.equal((await fetch(`${base}/protected`, { method: 'POST' })).status, 401);

    const meno = await loginAs('meno');
    assert.deepEqual(meno.body, { success: true, user: 'meno', authorized: true });
    const status = await (await fetch(`${base}/api/auth/status`, { headers: { cookie: meno.cookie } })).json();
    assert.deepEqual(status, { authenticated: true, user: 'meno', authorized: true });
    const ok = await fetch(`${base}/protected`, { method: 'POST', headers: { cookie: meno.cookie } });
    assert.equal(ok.status, 200);

    const stranger = await loginAs('stranger');
    assert.equal(stranger.body.authorized, false);
    const strangerStatus = await (await fetch(`${base}/api/auth/status`, { headers: { cookie: stranger.cookie } })).json();
    assert.deepEqual(strangerStatus, { authenticated: false, user: 'stranger', authorized: false });
    const refused = await fetch(`${base}/protected`, { method: 'POST', headers: { cookie: stranger.cookie } });
    assert.equal(refused.status, 403);
    assert.match((await refused.json()).error, /@stranger is not in ALLOWED_USERS/);

    const forged = await loginAs('meno', 'stranger');
    assert.equal(forged.res.status, 401);
    assert.equal(forged.cookie, '');

    // The old password route is gone.
    assert.equal((await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"password":"x"}' })).status, 404);

    // Logout ends it.
    await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { cookie: meno.cookie } });
    assert.equal((await fetch(`${base}/protected`, { method: 'POST', headers: { cookie: meno.cookie } })).status, 401);
  });
});
