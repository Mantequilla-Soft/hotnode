/**
 * Which video a Mongo doc is, in the two forms the hotnode needs.
 *
 * - owner/permlink: the video's internal ID. On embed-video docs `permlink`
 *   is a random ID (e.g. `7omyrbvf`), NOT the Hive permlink - but it is the
 *   key view-heatmaps uses, so retention (getLastServedAt) needs exactly this.
 * - embed_url: the public address, `@owner/hive-permlink`, used for the Pins
 *   page and 3speak.tv links (issue #24). embed-video docs carry it as
 *   `embed_url` once the video is posted to Hive; until then it's null.
 *   Legacy `videos` docs have no embed_url, but their `permlink` already is
 *   the Hive permlink.
 */
const EMBED_URL_RE = /^@?([^/\s]+)\/([^/\s]+)$/;

function normaliseEmbedUrl(value) {
  if (typeof value !== 'string') return null;
  const m = value.trim().match(EMBED_URL_RE);
  return m ? `@${m[1]}/${m[2]}` : null;
}

function embedUrlFor(video) {
  if (!video) return null;
  const fromField = normaliseEmbedUrl(video.embed_url);
  if (fromField) return fromField;
  if (video.hive_permlink) return normaliseEmbedUrl(`${video.hive_author || video.owner}/${video.hive_permlink}`);
  // Legacy docs are the ones keyed by video_v2 (see findLegacyVideoByCID).
  if (video.video_v2 && video.owner && video.permlink) return normaliseEmbedUrl(`${video.owner}/${video.permlink}`);
  return null;
}

function videoIdentity(video) {
  return {
    owner: video?.owner || null,
    permlink: video ? (video.permlink || video.hive_permlink || null) : null,
    embed_url: embedUrlFor(video)
  };
}

/**
 * Looks up pins that have no embed_url yet and stores it where Mongo now has
 * one. Videos are usually pinned before they're posted to Hive, so this has
 * to keep running, not just once. Pins with nothing in Mongo yet stay NULL
 * and are tried again next time. A Mongo error stops the run (thrown).
 */
async function fillMissingEmbedUrls(db, mongo, { heldOnly = true } = {}) {
  const pins = await db.getPinsMissingEmbedUrl({ heldOnly });
  let filled = 0;
  for (const pin of pins) {
    const embedUrl = embedUrlFor(await mongo.getVideoMetadata(pin.cid));
    if (embedUrl) {
      await db.updatePin(pin.cid, { embed_url: embedUrl });
      filled++;
    }
  }
  return { checked: pins.length, filled };
}

module.exports = { videoIdentity, embedUrlFor, normaliseEmbedUrl, fillMissingEmbedUrls };
