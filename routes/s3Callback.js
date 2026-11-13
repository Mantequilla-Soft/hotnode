const express = require('express');
const config = require('../utils/config');
const logger = require('../utils/logger');
const { getDatabase } = require('../utils/database');
const { verifySignature } = require('../utils/migrator');
const { getS3Worker } = require('../workers/s3Worker');

/**
 * POST /api/s3/callback: events from snapie-migrator (copied, failed, archived).
 *
 * Mounted in app.js BEFORE express.json(): the signature covers the exact
 * bytes, so the raw body is checked first and only then parsed.
 *  - signed with HOTNODE_CALLBACK_SECRET (HMAC-SHA256 of `${timestamp}.${body}`);
 *    a timestamp more than 5 minutes off is refused;
 *  - from this machine only, and never through nginx (a proxied request
 *    carries X-Forwarded-For / X-Real-IP; nginx also denies the path);
 *  - each event id once: a repeat answers 200 and changes nothing;
 *  - 2xx only after the database write, so anything else is retried.
 */
function createS3CallbackRouter({ db = getDatabase(), worker = getS3Worker(), secret = config.migrator.callback_secret, now = () => Date.now() } = {}) {
  const router = express.Router();
  router.post('/', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
    const peer = req.socket.remoteAddress;
    const proxied = req.headers['x-forwarded-for'] || req.headers['x-real-ip'];
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer) || proxied) {
      return res.status(403).json({ error: 'local only' });
    }
    const body = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    if (!verifySignature(secret, { timestamp: req.headers['x-migrator-timestamp'], signature: req.headers['x-migrator-signature'], body, now: now() })) {
      logger.warn('S3 callback with a bad or stale signature refused');
      return res.status(401).json({ error: 'bad signature' });
    }
    let ev;
    try { ev = JSON.parse(body); } catch (_) { return res.status(400).json({ error: 'not JSON' }); }
    if (!ev?.id || !ev.event || !ev.cid) return res.status(400).json({ error: 'id, event and cid are required' });

    if (!(await db.recordS3Event(ev.id, ev.event, ev.cid))) return res.json({ ok: true, duplicate: true });
    try {
      await worker.handleEvent(ev);
    } catch (e) {
      // Not handled: forget the id so the migrator's retry is processed.
      await db.forgetS3Event(ev.id).catch(() => {});
      logger.error(`S3 callback ${ev.event} ${ev.cid} failed:`, e.message);
      return res.status(500).json({ error: 'not recorded' });
    }
    res.json({ ok: true });
  });
  return router;
}

module.exports = { createS3CallbackRouter };
