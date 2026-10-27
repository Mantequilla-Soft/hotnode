/**
 * One-off backfill: resolves owner/permlink for pins that were inserted
 * before this feature existed (or where the Mongo lookup wasn't wired in
 * yet at insert time). New pins get this filled in automatically going
 * forward - see the getVideoMetadata() calls in pinDiscoveryWorker.js and
 * routes/api.js's scan-logs route.
 *
 * Safe to re-run: only touches pins where owner/permlink are still both
 * NULL, so anything already resolved (or genuinely unresolvable, like a
 * manually-pinned arbitrary CID) is left alone. A Mongo lookup error aborts
 * the run (non-zero exit) rather than miscounting pins as unresolved - just
 * re-run it once Mongo is reachable. Also the repair path for pins that
 * discovery stored with a NULL identity during an earlier Mongo outage.
 *
 * Run once: node scripts/backfillOwnerPermlink.js
 */
const { getDatabase } = require('../utils/database');
const { getMongoDBClient } = require('../utils/mongo');

async function backfill() {
  const db = getDatabase();
  await db.connect();
  const mongo = getMongoDBClient();
  await mongo.connect();

  try {
    const pins = await db.getPinsMissingOwner();
    console.log(`Found ${pins.length} pins without an owner/permlink`);

    let resolved = 0;
    let unresolved = 0;

    for (const pin of pins) {
      const video = await mongo.getVideoMetadata(pin.cid);
      if (video && video.owner && (video.permlink || video.hive_permlink)) {
        await db.updatePin(pin.cid, {
          owner: video.owner,
          permlink: video.permlink || video.hive_permlink
        });
        resolved++;
      } else {
        // Genuinely not a known video (manual/arbitrary pin) - leave NULL.
        // getDormantPinsForCleanup() still ages this out via added_at.
        unresolved++;
      }
    }

    console.log(`✅ Backfill complete: ${resolved} resolved, ${unresolved} left unresolved (not found in Mongo)`);
  } finally {
    await mongo.disconnect();
    await db.close();
  }
}

if (require.main === module) {
  backfill()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('❌ backfill failed:', err);
      process.exit(1);
    });
}

module.exports = { backfill };
