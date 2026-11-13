/**
 * snapie-migrator's service API, and checks on the events it sends back.
 *
 * The migrator runs on this VPS and does the actual copy to S3 (download the
 * CAR from our own IPFS, verify every block, upload, check, write Mongo). The
 * hotnode only asks, by CID, and keeps its own record of the answers
 * (workers/s3Worker.js). Its side: snapie-migrator SPEC §15.
 */
const crypto = require('crypto');
const config = require('./config');

const CID_RE = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,})$/;
const MAX_CIDS = 100;          // per POST /api/jobs, the migrator's limit
const SIGNATURE_MAX_SKEW_S = 300;

/** What's missing before the hotnode can use the migrator, or [] when ready. */
function missingSettings(cfg = config.migrator) {
  const missing = [];
  if (!cfg.url) missing.push('MIGRATOR_SERVICE_URL');
  if (!cfg.token) missing.push('MIGRATOR_SERVICE_TOKEN');
  if (!cfg.callback_secret) missing.push('HOTNODE_CALLBACK_SECRET');
  else if (cfg.callback_secret.length < 32) missing.push('HOTNODE_CALLBACK_SECRET (at least 32 characters)');
  if (cfg.url) {
    let u = null;
    try { u = new URL(cfg.url); } catch (_) { /* reported below */ }
    const local = u && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
    // The token must not travel over plain http to another machine.
    if (!u || !(u.protocol === 'https:' || (u.protocol === 'http:' && local))) missing.push('MIGRATOR_SERVICE_URL (https, or http on 127.0.0.1)');
  }
  return missing;
}

/** sha256=<hex HMAC(secret, `${timestamp}.${body}`)>, as the migrator signs. */
function sign(secret, timestamp, body) {
  return `sha256=${crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

/** Is this event really from our migrator, and recent? `body` is the raw request body. */
function verifySignature(secret, { timestamp, signature, body, now = Date.now() }) {
  if (!secret) return false;
  const ts = Number(timestamp);
  if (!Number.isInteger(ts) || Math.abs(now / 1000 - ts) > SIGNATURE_MAX_SKEW_S) return false;
  const want = Buffer.from(sign(secret, String(timestamp), body));
  const got = Buffer.from(String(signature || ''));
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

class MigratorError extends Error {
  constructor(message, { status = null, code = null } = {}) {
    super(message);
    this.name = 'MigratorError';
    this.status = status;
    this.code = code;
  }
}

class MigratorClient {
  constructor({ cfg = config.migrator, fetchImpl = fetch } = {}) {
    this.cfg = cfg;
    this.fetchImpl = fetchImpl;
  }

  get configured() { return missingSettings(this.cfg).length === 0; }

  async call(method, path, body) {
    const missing = missingSettings(this.cfg);
    if (missing.length) throw new MigratorError(`migrator not configured: ${missing.join(', ')}`);
    let res;
    try {
      res = await this.fetchImpl(`${this.cfg.url}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.cfg.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(this.cfg.timeout_ms || 30000),
      });
    } catch (e) {
      throw new MigratorError(`migrator unreachable: ${e.cause?.code || e.message}`);
    }
    let data = null;
    try { data = await res.json(); } catch (_) { /* not JSON */ }
    if (!res.ok) throw new MigratorError(data?.error || `migrator answered HTTP ${res.status}`, { status: res.status, code: data?.code || null });
    return data;
  }

  /** POST /api/jobs { cids, mode: 'hot' } → [{ cid, status, items?, reason?, detail? }] */
  // A later chunk failing keeps the answers already given (error.accepted).
  async requestCids(cids) {
    const out = [];
    for (let i = 0; i < cids.length; i += MAX_CIDS) {
      try {
        const r = await this.call('POST', '/api/jobs', { cids: cids.slice(i, i + MAX_CIDS), mode: 'hot' });
        out.push(...(r?.cids || []));
      } catch (e) {
        e.accepted = out;
        throw e;
      }
    }
    return out;
  }

  /** GET /api/cids/:cid → { state, reason?, documents, items, last_event } */
  cidState(cid) { return this.call('GET', `/api/cids/${encodeURIComponent(cid)}`); }

  /** POST /api/archive { cid }: we unpinned it; the player should go straight to S3. */
  archive(cid) { return this.call('POST', '/api/archive', { cid }); }

  /** Reachable, and does it take our token? → { ok, detail } */
  async ping() {
    try {
      await this.call('GET', '/api/jobs/0');
      return { ok: true, detail: 'reachable' };
    } catch (e) {
      if (e.status === 404) return { ok: true, detail: 'reachable, token accepted' };
      if (e.status === 401) return { ok: false, detail: 'the migrator refused MIGRATOR_SERVICE_TOKEN' };
      return { ok: false, detail: e.message };
    }
  }
}

let instance = null;
function getMigratorClient() {
  if (!instance) instance = new MigratorClient();
  return instance;
}

module.exports = { MigratorClient, MigratorError, getMigratorClient, missingSettings, sign, verifySignature, CID_RE, MAX_CIDS };
