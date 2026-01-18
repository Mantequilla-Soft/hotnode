#!/usr/bin/env node
/**
 * Test script to validate CIDs against MongoDB
 * 
 * Usage:
 *   node validate-cid.js <CID>
 *   node validate-cid.js QmXxx...
 * 
 * This checks if a CID exists in 3speak's video collections (legacy or new)
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { MongoClient } = require('mongodb');

// Configuration from environment
const config = {
  mongodb: {
    uri: process.env.MONGODB_URI || '',
    database: process.env.MONGODB_DATABASE || 'threespeak',
    collection_legacy: process.env.MONGODB_COLLECTION_LEGACY || 'videos',
    collection_new: process.env.MONGODB_COLLECTION_NEW || 'embed-video',
    timeout_ms: parseInt(process.env.MONGODB_TIMEOUT_MS || '5000', 10)
  }
};

/**
 * Extract CID from ipfs:// URL format
 */
function extractCIDFromIPFSUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const match = url.match(/^ipfs:\/\/([^\/]+)/);
  return match ? match[1] : null;
}

async function validateCID(cid) {
  console.log('\n🔍 CID Validation Test');
  console.log('═'.repeat(60));
  console.log(`CID: ${cid}`);
  console.log('─'.repeat(60));
  
  if (!config.mongodb.uri) {
    console.error('❌ Error: MONGODB_URI not configured in .env');
    process.exit(1);
  }

  console.log(`\n📡 Connecting to MongoDB...`);
  console.log(`   Database: ${config.mongodb.database}`);
  console.log(`   Legacy collection: ${config.mongodb.collection_legacy}`);
  console.log(`   New collection: ${config.mongodb.collection_new}`);

  const client = new MongoClient(config.mongodb.uri, {
    serverSelectionTimeoutMS: config.mongodb.timeout_ms,
    connectTimeoutMS: config.mongodb.timeout_ms
  });

  try {
    await client.connect();
    console.log('   ✓ Connected to MongoDB\n');

    const db = client.db(config.mongodb.database);
    let found = false;
    let foundIn = null;
    let foundDocument = null;

    // Check legacy videos collection
    console.log(`🔎 Searching in "${config.mongodb.collection_legacy}" collection...`);
    const legacyCollection = db.collection(config.mongodb.collection_legacy);
    
    // First, try direct CID match on common fields
    let legacyDoc = await legacyCollection.findOne({
      $or: [
        { video_v2: `ipfs://${cid}` },
        { video_v2: { $regex: `^ipfs://${cid}` } },
        { ipfs_hash: cid },
        { 'files.cid': cid }
      ]
    });

    if (legacyDoc) {
      found = true;
      foundIn = 'legacy (videos)';
      foundDocument = legacyDoc;
      console.log(`   ✓ Found in legacy collection!`);
    } else {
      // Scan through all video_v2 fields
      console.log(`   Scanning video_v2 fields...`);
      const legacyVideos = await legacyCollection.find({
        video_v2: { $exists: true, $ne: null }
      }).limit(1000).toArray();
      
      console.log(`   Checked ${legacyVideos.length} documents with video_v2 field`);
      
      for (const video of legacyVideos) {
        const extractedCID = extractCIDFromIPFSUrl(video.video_v2);
        if (extractedCID === cid) {
          found = true;
          foundIn = 'legacy (videos)';
          foundDocument = video;
          console.log(`   ✓ Found via video_v2 extraction!`);
          break;
        }
      }
    }

    if (!found) {
      console.log(`   ✗ Not found in legacy collection`);
    }

    // Check new embed-video collection
    console.log(`\n🔎 Searching in "${config.mongodb.collection_new}" collection...`);
    const newCollection = db.collection(config.mongodb.collection_new);
    
    const embedDoc = await newCollection.findOne({
      $or: [
        { manifest_cid: cid },
        { video_cid: cid },
        { cid: cid }
      ]
    });

    if (embedDoc) {
      found = true;
      foundIn = 'embed-video';
      foundDocument = embedDoc;
      console.log(`   ✓ Found in embed-video collection!`);
    } else {
      console.log(`   ✗ Not found in embed-video collection`);
    }

    // Print results
    console.log('\n' + '═'.repeat(60));
    if (found) {
      console.log(`✅ RESULT: CID IS VALID (3speak video)`);
      console.log(`   Found in: ${foundIn}`);
      if (foundDocument) {
        console.log(`\n📄 Document details:`);
        console.log(`   _id: ${foundDocument._id}`);
        if (foundDocument.title) console.log(`   title: ${foundDocument.title}`);
        if (foundDocument.author) console.log(`   author: ${foundDocument.author}`);
        if (foundDocument.permlink) console.log(`   permlink: ${foundDocument.permlink}`);
        if (foundDocument.video_v2) console.log(`   video_v2: ${foundDocument.video_v2}`);
        if (foundDocument.manifest_cid) console.log(`   manifest_cid: ${foundDocument.manifest_cid}`);
        if (foundDocument.created) console.log(`   created: ${foundDocument.created}`);
      }
    } else {
      console.log(`❌ RESULT: CID IS NOT VALID (not a 3speak video)`);
      console.log(`   This CID was not found in any 3speak video collection.`);
      console.log(`   It may be spam, garbage, or an unrelated IPFS upload.`);
    }
    console.log('═'.repeat(60) + '\n');

    return found;
  } catch (error) {
    console.error(`\n❌ Error: ${error.message}`);
    if (error.message.includes('getaddrinfo')) {
      console.error('   Could not resolve MongoDB host. Check MONGODB_URI.');
    }
    if (error.message.includes('Authentication failed')) {
      console.error('   MongoDB authentication failed. Check credentials.');
    }
    throw error;
  } finally {
    await client.close();
    console.log('📡 Disconnected from MongoDB');
  }
}

// Main
const cid = process.argv[2];

if (!cid) {
  console.log(`
Usage: node validate-cid.js <CID>

Examples:
  node validate-cid.js QmXxx...
  node validate-cid.js bafyxxx...

This script checks if a CID exists in 3speak's MongoDB video collections.
`);
  process.exit(1);
}

validateCID(cid)
  .then(valid => {
    process.exit(valid ? 0 : 1);
  })
  .catch(error => {
    console.error('Validation failed:', error.message);
    process.exit(2);
  });
