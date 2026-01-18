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
  async getVideoMetadata(cid) {
    try {
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
      const result = await newCollection.findOne({
        manifest_cid: cid
      });

      return result;
    } catch (error) {
      console.error('MongoDB get video metadata failed:', error.message);
      return null;
    }
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
