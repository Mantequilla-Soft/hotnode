const { MongoClient } = require('mongodb');
const config = require('./config');

class MongoDBClient {
  constructor() {
    this.client = null;
    this.db = null;
    this.connected = false;
  }

  async connect() {
    if (this.connected) {
      return;
    }

    try {
      this.client = new MongoClient(config.mongodb.uri, {
        serverSelectionTimeoutMS: config.mongodb.timeout_ms || 5000,
        connectTimeoutMS: config.mongodb.timeout_ms || 5000
      });

      await this.client.connect();
      this.db = this.client.db(config.mongodb.database);
      this.connected = true;
      console.log('Connected to MongoDB (Traffic Director)');
    } catch (error) {
      console.error('MongoDB connection failed:', error.message);
      throw error;
    }
  }

  async disconnect() {
    if (this.client) {
      await this.client.close();
      this.connected = false;
      console.log('Disconnected from MongoDB');
    }
  }

  /**
   * Extract CID from ipfs:// URL format
   * Example: ipfs://QmXXX/manifest.m3u8 -> QmXXX
   */
  extractCIDFromIPFSUrl(url) {
    if (!url || typeof url !== 'string') return null;
    
    // Match ipfs://CID/... pattern
    const match = url.match(/^ipfs:\/\/([^\/]+)/);
    return match ? match[1] : null;
  }

  /**
   * Check if a CID exists in 3speak's video collections
   * Checks both legacy (videos) and new (embed-video) collections
   * This validates that the upload is legitimate (encoder-originated)
   */
  async validateCID(cid) {
    try {
      if (!this.connected) {
        await this.connect();
      }

      // Check legacy videos collection (video_v2 field with ipfs:// format)
      const legacyCollection = this.db.collection(config.mongodb.collection_legacy);
      const legacyResult = await legacyCollection.findOne({
        video_v2: { $exists: true, $ne: null }
      });
      
      // Search through legacy videos and extract CIDs from video_v2
      if (legacyResult) {
        const legacyVideos = await legacyCollection.find({
          video_v2: { $exists: true, $ne: null }
        }).toArray();
        
        for (const video of legacyVideos) {
          const extractedCID = this.extractCIDFromIPFSUrl(video.video_v2);
          if (extractedCID === cid) {
            console.log(`CID ${cid} found in legacy videos collection`);
            return true;
          }
        }
      }

      // Check new embed-video collection (manifest_cid field, direct CID)
      const newCollection = this.db.collection(config.mongodb.collection_new);
      const newResult = await newCollection.findOne({
        manifest_cid: cid
      });

      if (newResult) {
        console.log(`CID ${cid} found in embed-video collection`);
        return true;
      }

      console.log(`CID ${cid} not found in either collection`);
      return false;
    } catch (error) {
      console.error('MongoDB CID validation failed:', error.message);
      throw error;
    }
  }

  /**
   * Batch validate multiple CIDs
   * Returns array of { cid, valid } objects
   */
  async validateCIDs(cids) {
    try {
      if (!this.connected) {
        await this.connect();
      }

      console.log(`Validating ${cids.length} CIDs against MongoDB...`);
      const foundCIDs = new Set();

      // Check legacy videos collection - build ipfs:// URL patterns
      const legacyCollection = this.db.collection(config.mongodb.collection_legacy);
      
      // Build array of possible ipfs:// URL formats for each CID
      const ipfsUrls = cids.flatMap(cid => [
        `ipfs://${cid}/manifest.m3u8`,  // Most common format
        `ipfs://${cid}`,                 // Without path
      ]);
      
      // Query with $or to match any of the patterns
      const legacyVideos = await legacyCollection.find({
        video_v2: { 
          $regex: new RegExp(`^ipfs://(${cids.join('|')})(/|$)`)
        }
      }).toArray();
      
      console.log(`Found ${legacyVideos.length} matches in legacy collection`);
      
      // Extract CIDs from found videos
      legacyVideos.forEach(video => {
        const extractedCID = this.extractCIDFromIPFSUrl(video.video_v2);
        if (extractedCID && cids.includes(extractedCID)) {
          foundCIDs.add(extractedCID);
        }
      });

      // Check new embed-video collection - direct CID match
      const newCollection = this.db.collection(config.mongodb.collection_new);
      const embedVideos = await newCollection.find({
        manifest_cid: { $in: cids }
      }).toArray();
      
      console.log(`Found ${embedVideos.length} matches in embed-video collection`);
      
      embedVideos.forEach(video => {
        if (video.manifest_cid) {
          foundCIDs.add(video.manifest_cid);
        }
      });

      console.log(`Validation complete: ${foundCIDs.size}/${cids.length} CIDs found`);

      // Return validation results
      return cids.map(cid => ({
        cid,
        valid: foundCIDs.has(cid)
      }));
    } catch (error) {
      console.error('MongoDB batch CID validation failed:', error.message);
      throw error;
    }
  }

  /**
   * Get video metadata by CID (optional, for enrichment)
   */
  // Returns null only when the CID genuinely isn't a known video. Mongo
  // errors throw: callers store a null result as a NULL owner/permlink, which
  // the last-served sync never tracks, so a transient outage must not be
  // recorded as "not a video".
  async getVideoMetadata(cid) {
    if (!this.connected) {
      await this.connect();
    }

    // Check legacy videos collection
    const legacyCollection = this.db.collection(config.mongodb.collection_legacy);
    const legacyVideos = await legacyCollection.find({
      video_v2: { $exists: true, $ne: null }
    }).toArray();

    for (const video of legacyVideos) {
      const extractedCID = this.extractCIDFromIPFSUrl(video.video_v2);
      if (extractedCID === cid) {
        return video;
      }
    }

    // Check new embed-video collection
    const newCollection = this.db.collection(config.mongodb.collection_new);
    return newCollection.findOne({
      manifest_cid: cid
    });
  }

  /**
   * Last time a video was actually served to a real viewer, per the
   * video player's own tracking (snapievideoplayer's watchTracking.js).
   *
   * view-heatmaps has one doc per (owner, permlink), and its `updatedAt` is
   * bumped by watchStart on every genuine watch and by watchBeat on real
   * playback progress - crucially, watchStart explicitly skips this for
   * placeholder plays (deleted/encoding/failed), so a dead video's
   * placeholder view never counts as "still being watched" here. This is
   * the one true source for "is this content still in demand", so hotnode
   * doesn't need its own separate view-tracking.
   *
   * Returns null if the video has no heatmap doc yet (never watched, or a
   * collection/field name mismatch - check HEATMAP_COLLECTION on both
   * sides if this stays null for content you know was played).
   *
   * Throws on Mongo errors rather than returning null: downstream, null
   * means "fall back to added_at", i.e. eligible for dormancy cleanup, so
   * an outage must not look like "nobody watched this".
   */
  async getLastServedAt(owner, permlink) {
    if (!this.connected) {
      await this.connect();
    }
    const heatmaps = this.db.collection(config.mongodb.collection_heatmaps);
    const doc = await heatmaps.findOne(
      { owner, permlink },
      { projection: { updatedAt: 1 } }
    );
    return doc?.updatedAt || null;
  }

  /**
   * Rough doc count of the heatmaps collection. Zero almost certainly means
   * a misconfigured MONGODB_COLLECTION_HEATMAPS rather than "nothing has
   * ever been watched", so the sync worker refuses to trust it.
   */
  async countHeatmaps() {
    if (!this.connected) {
      await this.connect();
    }
    return this.db.collection(config.mongodb.collection_heatmaps).estimatedDocumentCount();
  }

  /**
   * Health check - verify MongoDB connection
   */
  async healthCheck() {
    try {
      if (!this.connected) {
        await this.connect();
      }

      // Ping the database
      await this.db.admin().ping();
      return true;
    } catch (error) {
      console.error('MongoDB health check failed:', error.message);
      return false;
    }
  }
}

// Singleton instance
let instance = null;

function getMongoDBClient() {
  if (!instance) {
    instance = new MongoDBClient();
  }
  return instance;
}

module.exports = { MongoDBClient, getMongoDBClient };
