/**
 * One-off backfill for pins.embed_url (issue #24): looks up every pin that
 * has an owner but no embed_url, including ones no longer pinned here, and
 * stores the video's public @owner/hive-permlink address.
 *
 * syncLastServedWorker keeps doing this for pins still held here; this
 * script is for the rest, right after migrateAddEmbedUrl.js. Safe to re-run:
 * only NULL embed_urls are touched. A Mongo error aborts (non-zero exit);
 * re-run once Mongo is reachable.
 *
 * Run once: node scripts/backfillEmbedUrl.js
 */
const { getDatabase } = require('../utils/database');
const { getMongoDBClient } = require('../utils/mongo');
const { fillMissingEmbedUrls } = require('../utils/videoIdentity');

async function backfill() {
  const db = getDatabase();
  await db.connect();
  const mongo = getMongoDBClient();
  await mongo.connect();
  try {
    const { checked, filled } = await fillMissingEmbedUrls(db, mongo, { heldOnly: false });
    console.log(`✅ Backfill complete: ${filled}/${checked} pins got an embed_url (the rest aren't on Hive yet, or aren't in Mongo)`);
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
