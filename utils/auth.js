/**
 * Admin login with Hive Keychain (replaces the shared ADMIN_PASSWORD).
 *
 *  1. GET /api/auth/challenge?user=: a one-time string naming this node, the
 *     account and a nonce, valid for 5 minutes.
 *  2. Keychain signs it with the account's POSTING key (requestSignBuffer
 *     signs the SHA-256 of the string).
 *  3. POST /api/auth/verify: we recover the public key from the signature and
 *     require it to be one of the account's posting keys on chain, with
 *     enough weight to sign alone.
 *  4. The session records the account. It may act only while the account is
 *     in ALLOWED_USERS (.env), checked on every request.
 *
 * Same scheme as snapie-migrator's src/auth.js.
 */
const crypto = require('crypto');
const { Signature, cryptoUtils } = require('@hiveio/dhive');
const config = require('./config');

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MAX_PENDING = 1000;
// Hive account names: 3–16 chars, dot-separated segments, each starting with a letter.
const HIVE_USER_RE = /^(?=.{3,16}$)[a-z][a-z0-9-]*[a-z0-9](\.[a-z][a-z0-9-]*[a-z0-9])*$/;

/** Ask the Hive API nodes in turn for the account's posting authority (null: no such account). */
async function fetchPostingAuthority(user, nodes, { fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const errors = [];
  for (const node of nodes) {
    try {
      const res = await fetchImpl(node, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'condenser_api.get_accounts', params: [[user]] }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (body.error) throw new Error(body.error.message || 'rpc error');
      const acct = body.result && body.result[0];
      if (!acct) return null;
      return acct.posting;
    } catch (e) {
      errors.push(`${node}: ${e.message}`);
    }
  }
  throw new Error(`no Hive API node answered (${errors.join('; ')})`);
}

function createAuth({
  allowedUsers = config.auth.allowed_users,
  hiveApiNodes = config.auth.hive_api_nodes,
  site = config.hotnode.name,
  fetchImpl = fetch,
  now = () => Date.now(),
} = {}) {
  const pending = new Map();   // the exact challenge string → { user, exp }
  const allowed = new Set(allowedUsers);
  const prune = () => { const t = now(); for (const [k, v] of pending) if (v.exp <= t) pending.delete(k); };

  return {
    isAllowed: (user) => !!user && allowed.has(user),
    allowedCount: () => allowed.size,

    challenge(rawUser) {
      const user = String(rawUser || '').trim().toLowerCase().replace(/^@/, '');
      if (!HIVE_USER_RE.test(user)) throw Object.assign(new Error('not a Hive account name'), { status: 400 });
      prune();
      if (pending.size >= MAX_PENDING) throw Object.assign(new Error('too many pending logins, try again in a few minutes'), { status: 429 });
      const nonce = crypto.randomBytes(18).toString('base64url');
      const message = `hotnode:${site}:${user}:${nonce}:${now()}`;
      pending.set(message, { user, exp: now() + CHALLENGE_TTL_MS });
      return { user, message, expiresInMs: CHALLENGE_TTL_MS };
    },

    /** → { user, authorized }, or throws with the reason. The challenge is burnt either way. */
    async verify({ user: rawUser, message, signature }) {
      const user = String(rawUser || '').trim().toLowerCase().replace(/^@/, '');
      const entry = pending.get(String(message || ''));
      pending.delete(String(message || ''));
      if (!entry || entry.user !== user) throw new Error('unknown or already used challenge');
      if (entry.exp <= now()) throw new Error('challenge expired');
      let key;
      try {
        key = Signature.fromString(String(signature)).recover(cryptoUtils.sha256(message)).toString();
      } catch (e) {
        throw new Error('not a valid signature');
      }
      const posting = await fetchPostingAuthority(user, hiveApiNodes, { fetchImpl });
      if (!posting) throw new Error('no such Hive account');
      const ok = (posting.key_auths || []).some(([k, w]) => k === key && w >= posting.weight_threshold);
      if (!ok) throw new Error("the signature is not from this account's posting key");
      return { user, authorized: allowed.has(user) };
    },

    pendingCount: () => pending.size,
  };
}

let instance = null;
function getAuth() {
  if (!instance) instance = createAuth();
  return instance;
}

/** Express middleware: only a logged-in account on ALLOWED_USERS gets through. */
function requireAuth(req, res, next) {
  if (getAuth().isAllowed(req.session && req.session.user)) return next();
  const user = req.session && req.session.user;
  res.status(user ? 403 : 401).json({ error: user ? `@${user} is not in ALLOWED_USERS` : 'Log in with Hive Keychain' });
}

module.exports = { createAuth, getAuth, requireAuth, fetchPostingAuthority, HIVE_USER_RE, CHALLENGE_TTL_MS };
