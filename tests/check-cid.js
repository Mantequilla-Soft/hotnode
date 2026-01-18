/**
 * Quick CID Supernode Check
 * 
 * Checks if a specific CID exists on the supernode
 * 
 * Usage:
 *   node tests/check-cid.js <CID>
 */

const axios = require('axios');

const SUPERNODE_API_URL = 'http://65.21.201.94:5002';

async function checkSupernode(cid) {
  try {
    console.log('🔍 Checking supernode for CID:', cid);
    console.log('   Endpoint:', SUPERNODE_API_URL);
    console.log('');
    
    const response = await axios.post(
      `${SUPERNODE_API_URL}/api/v0/pin/ls?arg=${cid}`,
      null,
      {
        timeout: 30000
      }
    );

    console.log('📊 Response Details:');
    console.log('   Status:', response.status);
    console.log('   Data Type:', typeof response.data);
    console.log('   Data:', JSON.stringify(response.data, null, 2));
    console.log('');

    // Apply our verification logic
    let exists = false;
    
    if (response.status === 200) {
      if (response.data && response.data.Keys && response.data.Keys[cid]) {
        exists = true;
        console.log('✅ Logic: Pin found in Keys object');
      } else if (typeof response.data === 'string') {
        exists = !response.data.includes('not pinned');
        console.log(`📝 Logic: String response - ${exists ? 'exists' : 'not found'}`);
      } else if (response.data && response.data.Message) {
        exists = !response.data.Message.includes('not pinned');
        console.log(`📝 Logic: Message field - ${exists ? 'exists' : 'not found'}`);
      } else {
        console.log('❓ Logic: No Keys, no string, no Message - treating as NOT FOUND');
      }
    }

    console.log('');
    console.log('='.repeat(60));
    console.log(`${exists ? '✅ RESULT: EXISTS' : '❌ RESULT: NOT FOUND'} on supernode`);
    console.log('='.repeat(60));
    
    return exists;
  } catch (error) {
    console.log('');
    console.log('❌ Error Details:');
    console.log('   Message:', error.message);
    if (error.response) {
      console.log('   Status:', error.response.status);
      console.log('   Data:', JSON.stringify(error.response.data, null, 2));
    }
    console.log('');
    console.log('='.repeat(60));
    console.log('❌ RESULT: NOT FOUND (error)');
    console.log('='.repeat(60));
    return false;
  }
}

// Get CID from command line
const cid = process.argv[2];

if (!cid) {
  console.error('Usage: node tests/check-cid.js <CID>');
  console.error('Example: node tests/check-cid.js QmXTB7rYSRdYTvpU4FZvn74Cphjr44fapa3K4p6MzXRdVH');
  process.exit(1);
}

checkSupernode(cid);
