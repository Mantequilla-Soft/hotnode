const config = require('./config');
const logger = require('./logger');

/**
 * Repo capacity thresholds and the automatic ingestion cutoff.
 *
 * Every threshold is a percent of RepoSize / StorageMax. Defaults come from
 * .env (config.health); the Settings page overrides them in the DB config
 * table, so they can be changed without a restart.
 *
 * Cutoff: once the repo reaches stop_percent the node reports enabled=false
 * on GET /health, which takes it out of the Traffic Director's rotation. It
 * comes back only when usage falls below resume_percent, so it doesn't flap
 * at the line. This is separate from the manual Enable/Disable toggle:
 * dropping below resume never re-enables a node someone switched off.
 */

const THRESHOLD_KEYS = {
  stop_percent: 'capacity_stop_percent',
  resume_percent: 'capacity_resume_percent',
  overdue_alert_percent: 'overdue_alert_repo_percent',
  disk_warning_percent: 'disk_warning_percent',
  disk_critical_percent: 'disk_critical_percent'
};

const PAUSED_KEY = 'capacity_paused';

function defaults() {
  return {
    stop_percent: config.health.capacity_stop_percent,
    resume_percent: config.health.capacity_resume_percent,
    overdue_alert_percent: config.health.overdue_alert_repo_percent,
    disk_warning_percent: config.health.disk_warning_percent,
    disk_critical_percent: config.health.disk_critical_percent
  };
}

function parsePercent(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 100 ? n : null;
}

/** Current thresholds: DB overrides on top of .env defaults. */
async function getThresholds(db) {
  const result = defaults();
  for (const [field, key] of Object.entries(THRESHOLD_KEYS)) {
    try {
      const override = parsePercent(await db.getConfig(key));
      if (override !== null) result[field] = override;
    } catch (error) {
      logger.error(`Failed to read ${key}, using default:`, error);
    }
  }
  return result;
}

/** Returns an error message, or null when the thresholds are usable. */
function validateThresholds(t) {
  for (const field of Object.keys(THRESHOLD_KEYS)) {
    if (parsePercent(t[field]) === null) {
      return `${field} must be a whole number between 1 and 100`;
    }
  }
  if (Number(t.resume_percent) >= Number(t.stop_percent)) {
    return 'Resume percent must be lower than the stop percent';
  }
  if (Number(t.disk_warning_percent) >= Number(t.disk_critical_percent)) {
    return 'Warning percent must be lower than the critical percent';
  }
  return null;
}

async function saveThresholds(db, t) {
  for (const [field, key] of Object.entries(THRESHOLD_KEYS)) {
    await db.setConfig(key, String(Number(t[field])));
  }
}

async function isPaused(db) {
  return (await db.getConfig(PAUSED_KEY)) === 'true';
}

// GET /health is polled concurrently; serialise evaluations so a transition
// is recorded (and announced) once, not once per in-flight request.
let chain = Promise.resolve();

/**
 * Update the cutoff state from the current repo usage.
 *
 * @param {object} db
 * @param {number|null} repoPercent - null when usage couldn't be read; the
 *   state is then left as it is rather than guessed at.
 * @param {function} [onChange] - called with { paused, repoPercent, thresholds }
 *   when the state flips. Not awaited, so a slow webhook can't hold up /health.
 * @param {object} [opts]
 * @param {boolean} [opts.reset] - ignore the hysteresis band and decide on
 *   stop_percent alone. Used after the thresholds are edited, so a new
 *   higher cutoff takes effect immediately.
 * @returns {Promise<{paused: boolean, changed: boolean, thresholds: object}>}
 */
function evaluateCapacity(db, repoPercent, onChange, opts = {}) {
  const run = chain.then(async () => {
    const thresholds = await getThresholds(db);
    const wasPaused = await isPaused(db);

    if (repoPercent === null || repoPercent === undefined) {
      return { paused: wasPaused, changed: false, thresholds };
    }

    let paused;
    if (opts.reset || !wasPaused) {
      paused = repoPercent >= thresholds.stop_percent;
    } else {
      paused = repoPercent >= thresholds.resume_percent;
    }

    if (paused === wasPaused) {
      return { paused, changed: false, thresholds };
    }

    await db.setConfig(PAUSED_KEY, paused ? 'true' : 'false');

    const message = paused
      ? `Repo at ${repoPercent}% (cutoff ${thresholds.stop_percent}%): no longer accepting uploads`
      : `Repo at ${repoPercent}% (below ${thresholds.resume_percent}%): accepting uploads again`;
    logger.warn(message);

    try {
      await db.logEvent({
        event_type: 'capacity_change',
        severity: paused ? 'warning' : 'info',
        message,
        metadata: { repo_percent: repoPercent, ...thresholds }
      });
    } catch (error) {
      logger.error('Failed to log capacity event:', error);
    }

    if (onChange) {
      Promise.resolve()
        .then(() => onChange({ paused, repoPercent, thresholds }))
        .catch(error => logger.error('Capacity change notification failed:', error));
    }

    return { paused, changed: true, thresholds };
  });
  // Keep the chain alive even if this evaluation fails.
  chain = run.catch(() => {});
  return run;
}

/** Repo usage as a whole percent of StorageMax, or null if unknown. */
function repoUsagePercent(repoStat) {
  const repoSize = parseInt(repoStat?.RepoSize || 0, 10);
  const storageMax = parseInt(repoStat?.StorageMax || 0, 10);
  return storageMax > 0 ? Math.round((repoSize / storageMax) * 100) : null;
}

module.exports = {
  THRESHOLD_KEYS,
  PAUSED_KEY,
  getThresholds,
  validateThresholds,
  saveThresholds,
  isPaused,
  evaluateCapacity,
  repoUsagePercent
};
