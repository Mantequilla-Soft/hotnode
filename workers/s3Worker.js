const { getDatabase } = require('../utils/database');
const { getDiscordNotifier } = require('../utils/discord');
const { getMigratorClient } = require('../utils/migrator');
const logger = require('../utils/logger');
const config = require('../utils/config');

/**
 * S3 copies through snapie-migrator (issue #19). Replaces the supernode
 * migration when Settings → migration target is "s3".
 *
 * The hotnode copies nothing itself. It asks the migrator (on this VPS) by
 * CID, keeps one record per pin (pins.s3_*), and learns the outcome from the
 * migrator's signed events (routes/s3Callback.js):
 *
 *   NULL → requested → copied → (unpin here) → archived
 *                    ↘ failed (retried with backoff when retryable)
 *                    ↘ rejected (permanent: not a video the player can serve from S3)
 *
 * "copied" is what lets cleanup unpin a pin (cleanupWorker.js). After the
 * unpin, the migrator flips the video to `archived` so the player goes
 * straight to S3; until then the player still falls back to S3 on its own.
 */

const HOUR = 3600 * 1000;
const MAX_ATTEMPTS = 5;                 // failed copies asked again, then an alert
const STALE_REQUEST_HOURS = 6;          // no event this long: look the CID up

class S3Worker {
  constructor({ db = getDatabase(), client = getMigratorClient(), discord = getDiscordNotifier(), now = () => Date.now() } = {}) {
    this.db = db;
    this.client = client;
    this.discord = discord;
    this.now = now;
  }

  iso(t = this.now()) { return new Date(t).toISOString(); }
  today() { return this.iso().split('T')[0]; }

  async isOn() { return (await this.db.getMigrationTarget()) === 's3'; }

  // ------------------------------------------------------------ requests

  /** Ask for up to `limit` eligible pins (the migration worker's batch). */
  async requestBatch(limit) {
    const pins = await this.db.getPinsForS3Request(config.migration.start_after_days, limit);
    if (!pins.length) return { requested: 0, rejected: 0, already: 0, answers: [] };
    const answers = await this.client.requestCids(pins.map((p) => p.cid));
    const counts = { requested: 0, rejected: 0, already: 0, answers };
    for (const a of answers) {
      await this.applyAnswer(a);
      if (a.status === 'rejected') counts.rejected++;
      else if (a.status === 'already_copied') counts.already++;
      else counts.requested++;
    }
    return counts;
  }

  /** The admin's Migrate button: ask for one pin now, whatever its age. */
  async requestOne(cid) {
    const pin = await this.db.getPin(cid);
    if (!pin) throw Object.assign(new Error('Pin not found'), { status: 404 });
    if (['copied', 'archived'].includes(pin.s3_state)) throw Object.assign(new Error(`Already ${pin.s3_state} in S3`), { status: 400 });
    if (pin.unpinned) throw Object.assign(new Error('Not pinned here any more; the migrator could not read it from this node'), { status: 400 });
    const [answer] = await this.client.requestCids([cid]);
    await this.applyAnswer(answer);
    return answer;
  }

  async applyAnswer(a) {
    if (!a?.cid) return;
    if (a.status === 'rejected') {
      await this.db.updatePin(a.cid, {
        s3_state: 'rejected', s3_error_code: a.reason || 'rejected', s3_error: a.detail || null,
        s3_retryable: 0, s3_next_attempt_at: null,
      });
      logger.warn(`S3 copy rejected for ${a.cid}: ${a.reason}${a.detail ? ` (${a.detail})` : ''}`);
      return;
    }
    // queued, in_progress, already_copied: the event follows.
    await this.db.updatePin(a.cid, { s3_state: 'requested', s3_requested_at: this.iso() });
  }

  // ------------------------------------------------------------ events

  /** One verified event from the migrator. Idempotency is the caller's (s3_events). */
  async handleEvent(ev) {
    const pin = await this.db.getPin(ev.cid);
    if (!pin) { logger.info(`S3 ${ev.event} event for ${ev.cid}, which isn't a pin here; ignored`); return; }
    if (ev.event === 'copied') return this.markCopied(pin, { s3_url: ev.s3_url, s3_car_url: ev.s3_car_url, bytes: ev.bytes, warnings: ev.warnings });
    if (ev.event === 'failed') return this.markFailed(pin, { code: ev.error?.code, message: ev.error?.message, retryable: ev.retryable });
    if (ev.event === 'archived') return this.markArchived(pin);
    logger.warn(`Unknown S3 event "${ev.event}" for ${ev.cid}; ignored`);
  }

  async markCopied(pin, { s3_url, s3_car_url, bytes, warnings = [] }) {
    const first = !['copied', 'archived'].includes(pin.s3_state);
    await this.db.updatePin(pin.cid, {
      s3_state: pin.s3_state === 'archived' ? 'archived' : 'copied',
      s3_url: s3_url || pin.s3_url || null,
      s3_car_url: s3_car_url || pin.s3_car_url || null,
      s3_bytes: Number.isFinite(bytes) ? bytes : pin.s3_bytes ?? null,
      s3_copied_at: pin.s3_copied_at || this.iso(),
      s3_error_code: null, s3_error: null, s3_retryable: null, s3_next_attempt_at: null,
      // `migrated` keeps meaning "safe off this node", so the overdue counts,
      // health report and stats keep working unchanged.
      migrated: 1,
      migrated_at: pin.migrated_at || this.iso(),
      notes: warnings.length ? `Copied to S3 (${warnings.length} warning(s): ${warnings[0]})` : 'Copied to S3',
    });
    if (first && !pin.migrated) {
      await this.db.updateMigrationStats(this.today(), { success_count: 1, bytes_migrated: pin.size_bytes || bytes || 0 });
    }
    if (first) logger.info(`✓ Copied to S3: ${pin.cid}`);
    // Already unpinned here (before the copy was confirmed): flip it now.
    if (pin.unpinned) await this.archiveAfterUnpin(pin.cid);
  }

  async markFailed(pin, { code, message, retryable }) {
    const attempts = (pin.s3_attempts || 0) + 1;
    const again = !!retryable && attempts < MAX_ATTEMPTS;
    await this.db.updatePin(pin.cid, {
      s3_state: 'failed', s3_error_code: code || 'unknown', s3_error: message || null,
      s3_attempts: attempts, s3_retryable: again ? 1 : 0,
      s3_next_attempt_at: again ? this.iso(this.now() + HOUR * 2 ** (attempts - 1)) : null,
      retry_count: attempts, last_retry_at: this.iso(), notes: `S3 copy failed: ${code}${message ? `: ${message}` : ''}`,
    });
    await this.db.updateMigrationStats(this.today(), { failure_count: 1, ...(again ? {} : { max_retries_reached: 1 }) });
    logger.error(`✗ S3 copy failed for ${pin.cid}: ${code} (${message}); ${again ? `retry ${attempts + 1} later` : 'giving up'}`);
    if (!again) {
      await this.discord.send(
        '❌ S3 copy gave up',
        [`**CID:** ${pin.cid}`, pin.owner ? `**Video:** ${pin.owner}/${pin.permlink}` : null, `**Error:** ${code}${message ? `: ${message}` : ''}`,
          `**Attempts:** ${attempts}`, '', 'The pin stays here. Retry it from the Pins page once the cause is fixed.'].filter(Boolean).join('\n'),
        'red',
      ).catch((e) => logger.error('Discord alert failed:', e.message));
    }
  }

  async markArchived(pin) {
    await this.db.updatePin(pin.cid, { s3_state: 'archived', s3_archived_at: pin.s3_archived_at || this.iso() });
  }

  // ------------------------------------------------------------ after unpin

  /** Ask for the flip to `archived`. A failure is retried by catchUp(); playback is unaffected meanwhile. */
  async archiveAfterUnpin(cid) {
    try {
      await this.client.archive(cid);
      const pin = await this.db.getPin(cid);
      if (pin) await this.markArchived(pin);
      return true;
    } catch (e) {
      logger.warn(`Archive flip for ${cid} failed (${e.code || e.message}); retried hourly`);
      return false;
    }
  }

  // ------------------------------------------------------------ catching up

  /** Hourly: requests that never got an event, and unpinned copies not yet archived. */
  async catchUp() {
    const summary = { checked: 0, updated: 0, archived: 0, errors: [] };
    for (const pin of await this.db.getStaleS3Requests(STALE_REQUEST_HOURS)) {
      summary.checked++;
      try {
        if (await this.applyState(pin, await this.client.cidState(pin.cid))) summary.updated++;
      } catch (e) {
        summary.errors.push(`${pin.cid}: ${e.message}`);
        if (!e.status) break;   // the migrator is down: try the rest next hour
      }
    }
    for (const pin of await this.db.getPinsToArchive()) {
      if (await this.archiveAfterUnpin(pin.cid)) summary.archived++;
    }
    if (summary.checked || summary.archived) logger.info(`S3 catch-up: ${JSON.stringify(summary)}`);
    return summary;
  }

  /** Take the migrator's view of a CID (GET /api/cids/:cid). → true if anything changed. */
  async applyState(pin, st) {
    switch (st?.state) {
      case 'copied':
      case 'archived': {
        const doc = st.documents?.find((d) => d.s3_url) || {};
        const last = st.last_event?.event === 'copied' ? st.last_event : {};
        await this.markCopied(pin, { s3_url: doc.s3_url || last.s3_url, s3_car_url: last.s3_car_url, bytes: last.bytes });
        if (st.state === 'archived') await this.markArchived(await this.db.getPin(pin.cid));
        return true;
      }
      case 'failed': {
        const ev = st.last_event?.event === 'failed' ? st.last_event : { error: { code: 'unknown' }, retryable: true };
        await this.markFailed(pin, { code: ev.error?.code, message: ev.error?.message, retryable: ev.retryable });
        return true;
      }
      case 'in_progress':
        return false;
      default:
        // unknown: never asked (a lost request), or not a video it can copy.
        if (st?.reason) await this.applyAnswer({ cid: pin.cid, status: 'rejected', reason: st.reason });
        else await this.db.updatePin(pin.cid, { s3_state: null, s3_requested_at: null });
        return true;
    }
  }
}

let instance = null;
function getS3Worker() {
  if (!instance) instance = new S3Worker();
  return instance;
}

module.exports = { S3Worker, getS3Worker, MAX_ATTEMPTS, STALE_REQUEST_HOURS };
