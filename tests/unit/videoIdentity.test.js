const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ejs = require('ejs');
const sqlite3 = require('sqlite3');
require('./helpers');
const { Database } = require('../../utils/database');
const { schema } = require('../../scripts/initDatabase');
const { migrate } = require('../../scripts/migrateAddEmbedUrl');
const { videoIdentity, embedUrlFor, fillMissingEmbedUrls } = require('../../utils/videoIdentity');

// Trimmed from the embed-video doc in issue #24.
const EMBED_DOC = {
  owner: 'sergiomendes',
  permlink: '7omyrbvf',
  manifest_cid: 'QmWUnLKrty6B9nXZj2yPBLzEBWkWcTRdmFuDEqgw7sw2q5',
  hive_author: 'sergiomendes',
  hive_permlink: 'skims-advent-calendar-drama-772',
  embed_url: '@sergiomendes/skims-advent-calendar-drama-772'
};
const LEGACY_DOC = { owner: 'adesojisouljay', permlink: 'zibqjctmdq', video_v2: 'ipfs://QmX/manifest.m3u8' };

describe('videoIdentity', () => {
  test('embed-video: permlink stays the internal ID, embed_url is the Hive address', () => {
    assert.deepEqual(videoIdentity(EMBED_DOC), {
      owner: 'sergiomendes',
      permlink: '7omyrbvf',
      embed_url: '@sergiomendes/skims-advent-calendar-drama-772'
    });
  });

  test('embed_url wins even without hive_* fields', () => {
    assert.equal(embedUrlFor({ owner: 'meno', permlink: 's09vr4q3', embed_url: '@meno/20260314t233226420z' }), '@meno/20260314t233226420z');
  });

  test('missing @ is added; junk is rejected', () => {
    assert.equal(embedUrlFor({ embed_url: 'meno/abc' }), '@meno/abc');
    assert.equal(embedUrlFor({ embed_url: 'https://3speak.tv/@meno/abc' }), null);
  });

  test('falls back to hive_author/hive_permlink', () => {
    assert.equal(embedUrlFor({ owner: 'a', permlink: 'id1', hive_author: 'b', hive_permlink: 'post' }), '@b/post');
  });

  test('legacy doc: its permlink is the Hive permlink', () => {
    assert.equal(embedUrlFor(LEGACY_DOC), '@adesojisouljay/zibqjctmdq');
  });

  test('not on Hive yet, or unknown CID: null', () => {
    assert.equal(embedUrlFor({ owner: 'a', permlink: 'id1' }), null);
    assert.deepEqual(videoIdentity(null), { owner: null, permlink: null, embed_url: null });
  });
});

describe('pins.embed_url', () => {
  let db;

  beforeEach(async () => {
    db = new Database();
    db.db = new sqlite3.Database(':memory:');
    await new Promise((resolve, reject) => db.db.exec(schema, (err) => (err ? reject(err) : resolve())));
  });

  afterEach(() => new Promise(resolve => db.db.close(resolve)));

  test('insertPin stores it next to the internal permlink', async () => {
    await db.insertPin({ cid: EMBED_DOC.manifest_cid, ...videoIdentity(EMBED_DOC) });
    const pin = await db.getPin(EMBED_DOC.manifest_cid);
    assert.equal(pin.permlink, '7omyrbvf');
    assert.equal(pin.embed_url, '@sergiomendes/skims-advent-calendar-drama-772');
  });

  test('fillMissingEmbedUrls fills what Mongo now knows, leaves the rest, skips unpinned when heldOnly', async () => {
    await db.insertPin({ cid: 'QmA', owner: 'sergiomendes', permlink: '7omyrbvf' });
    await db.insertPin({ cid: 'QmB', owner: 'x', permlink: 'notyet' });
    await db.insertPin({ cid: 'QmC', owner: 'adesojisouljay', permlink: 'zibqjctmdq' });
    await db.updatePin('QmC', { unpinned: 1 });
    await db.insertPin({ cid: 'QmD' }); // not a video
    const docs = { QmA: EMBED_DOC, QmB: { owner: 'x', permlink: 'notyet' }, QmC: LEGACY_DOC };
    const mongo = { getVideoMetadata: async (cid) => docs[cid] || null };

    assert.deepEqual(await fillMissingEmbedUrls(db, mongo, { heldOnly: true }), { checked: 2, filled: 1 });
    assert.equal((await db.getPin('QmA')).embed_url, EMBED_DOC.embed_url);
    assert.equal((await db.getPin('QmB')).embed_url, null);
    assert.equal((await db.getPin('QmC')).embed_url, null);

    assert.deepEqual(await fillMissingEmbedUrls(db, mongo, { heldOnly: false }), { checked: 2, filled: 1 });
    assert.equal((await db.getPin('QmC')).embed_url, '@adesojisouljay/zibqjctmdq');
  });

  test('a Mongo error aborts the fill', async () => {
    await db.insertPin({ cid: 'QmA', owner: 'a', permlink: 'b' });
    const mongo = { getVideoMetadata: async () => { throw new Error('down'); } };
    await assert.rejects(fillMissingEmbedUrls(db, mongo), /down/);
  });
});

describe('migrateAddEmbedUrl', () => {
  test('adds the column to a v4 pins table, and is idempotent', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hotnode-')), 'test.db');
    const raw = new sqlite3.Database(file);
    const exec = (sql) => new Promise((res, rej) => raw.exec(sql, (e) => (e ? rej(e) : res())));
    await exec(`CREATE TABLE pins (id INTEGER PRIMARY KEY, cid TEXT UNIQUE NOT NULL, owner TEXT, permlink TEXT);
                CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT, updated_at DATETIME);
                INSERT INTO pins (cid, owner, permlink) VALUES ('QmA', 'a', 'b');`);
    await new Promise(res => raw.close(res));

    await migrate(file);
    await migrate(file);

    const check = new sqlite3.Database(file);
    const cols = await new Promise((res, rej) => check.all('PRAGMA table_info(pins)', (e, r) => (e ? rej(e) : res(r))));
    const row = await new Promise((res, rej) => check.get('SELECT * FROM pins', (e, r) => (e ? rej(e) : res(r))));
    await new Promise(res => check.close(res));
    assert.ok(cols.some(c => c.name === 'embed_url'));
    assert.equal(row.permlink, 'b');
    assert.equal(row.embed_url, null);
  });
});

describe('video partial', () => {
  const tpl = path.join(__dirname, '../../views/partials/video.ejs');
  const render = (pin) => ejs.renderFile(tpl, { pin });

  test('links to the Hive post and shows its permlink', async () => {
    const html = await render({ owner: 'sergiomendes', permlink: '7omyrbvf', embed_url: '@sergiomendes/skims-advent-calendar-drama-772' });
    assert.match(html, /href="https:\/\/3speak\.tv\/@sergiomendes\/skims-advent-calendar-drama-772"/);
    assert.match(html, />skims-advent-calendar-drama-772</);
    assert.doesNotMatch(html, /7omyrbvf/);
  });

  test('without embed_url, opens the player by video ID', async () => {
    const html = await render({ owner: 'x', permlink: 'notyet', embed_url: null });
    assert.match(html, /play\.3speak\.tv\/embed\?v=x\/notyet/);
  });
});
