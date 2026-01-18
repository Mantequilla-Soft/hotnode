/**
 * Supernode Upload and Pin Verification Test
 * 
 * Tests uploading content to the supernode and verifying it gets pinned
 * 
 * Usage:
 *   node tests/supernode-upload-test.js
 */

const axios = require('axios');
const FormData = require('form-data');

// Configuration
const SUPERNODE_UPLOAD_URL = 'https://ipfs.3speak.tv/api/v0/add';
const SUPERNODE_API_URL = 'http://65.21.201.94:5002';

/**
 * Upload content to supernode
 */
async function uploadToSupernode(content) {
  try {
    console.log('📤 Uploading test content to supernode...');
    console.log('   Endpoint:', SUPERNODE_UPLOAD_URL);
    console.log('   Content:', content.substring(0, 50) + '...');
    console.log('');
    
    const form = new FormData();
    form.append('file', Buffer.from(content), {
      filename: 'test-supernode.txt',
      contentType: 'text/plain'
    });

    const response = await axios.post(
      SUPERNODE_UPLOAD_URL,
      form,
      {
        headers: form.getHeaders(),
        timeout: 60000
      }
    );

    console.log('📊 Upload Response:');
    console.log('   Status:', response.status);
    console.log('   Data:', JSON.stringify(response.data, null, 2));
    console.log('');

    const cid = response.data.Hash || response.data.hash;
    
    if (!cid) {
      throw new Error('No CID returned from upload');
    }

    console.log('✅ Content uploaded successfully');
    console.log('   CID:', cid);
    console.log('');
    
    return cid;
  } catch (error) {
    console.error('❌ Upload failed:', error.message);
    if (error.response) {
      console.error('   Status:', error.response.status);
      console.error('   Data:', error.response.data);
    }
    throw error;
  }
}

/**
 * Check if CID is pinned on supernode
 */
async function checkSupernodePin(cid) {
  try {
    console.log('🔍 Checking if content is pinned on supernode...');
    console.log('   Endpoint:', SUPERNODE_API_URL);
    console.log('   CID:', cid);
    console.log('');
    
    const response = await axios.post(
      `${SUPERNODE_API_URL}/api/v0/pin/ls?arg=${cid}`,
      null,
      {
        timeout: 30000
      }
    );

    console.log('📊 Pin Check Response:');
    console.log('   Status:', response.status);
    console.log('   Data Type:', typeof response.data);
    console.log('   Data:', JSON.stringify(response.data, null, 2));
    console.log('');

    // Apply verification logic
    let exists = false;
    
    if (response.status === 200) {
      if (response.data && response.data.Keys && response.data.Keys[cid]) {
        exists = true;
        console.log('✅ Logic: Pin found in Keys object');
      } else if (typeof response.data === 'string') {
        exists = !response.data.includes('not pinned');
        console.log(`📝 Logic: String response - ${exists ? 'exists' : 'not found'}`);
      } else if (response.data && response.data.Message) {
        const hasError = response.data.Message.includes('not pinned') || 
                        response.data.Message.includes('permission denied');
        exists = !hasError;
        console.log(`📝 Logic: Message field - ${exists ? 'exists' : 'error/not found'}`);
        if (response.data.Message.includes('permission denied')) {
          console.log('⚠️  WARNING: Permission denied error on supernode!');
        }
      } else {
        console.log('❓ Logic: No Keys, no string, no Message - treating as NOT FOUND');
      }
    }

    console.log('');
    console.log(`${exists ? '✅ RESULT: Pin verified' : '❌ RESULT: Pin not verified'}`);
    console.log('');
    
    return exists;
  } catch (error) {
    console.error('❌ Pin check failed:', error.message);
    if (error.response) {
      console.error('   Status:', error.response.status);
      console.error('   Data:', JSON.stringify(error.response.data, null, 2));
    }
    console.log('');
    return false;
  }
}

/**
 * Retrieve content from supernode gateway
 */
async function retrieveContent(cid) {
  try {
    console.log('📥 Retrieving content from supernode gateway...');
    console.log('   Gateway:', `https://ipfs.3speak.tv/ipfs/${cid}`);
    console.log('');
    
    const response = await axios.get(
      `https://ipfs.3speak.tv/ipfs/${cid}`,
      {
        timeout: 30000,
        responseType: 'text'
      }
    );

    console.log('📊 Retrieval Response:');
    console.log('   Status:', response.status);
    console.log('   Content:', response.data);
    console.log('');
    console.log('✅ Content retrieved successfully');
    console.log('');
    
    return response.data;
  } catch (error) {
    console.error('❌ Retrieval failed:', error.message);
    if (error.response) {
      console.error('   Status:', error.response.status);
    }
    console.log('');
    return null;
  }
}

/**
 * Main test flow
 */
async function runTest() {
  console.log('🧪 Supernode Upload and Pin Verification Test\n');
  console.log('='.repeat(60));
  console.log('');

  try {
    // Step 1: Create unique test content
    const timestamp = Date.now();
    const testContent = `Supernode upload test ${timestamp}\nThis content was uploaded directly to the supernode.`;
    
    // Step 2: Upload to supernode
    console.log('STEP 1: Upload to Supernode');
    console.log('='.repeat(60));
    const cid = await uploadToSupernode(testContent);

    // Step 3: Wait a moment for pin to complete
    console.log('⏱️  Waiting 2 seconds for pin to complete...');
    console.log('');
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Step 4: Check if pinned
    console.log('STEP 2: Verify Pin on Supernode');
    console.log('='.repeat(60));
    const isPinned = await checkSupernodePin(cid);

    // Step 5: Try to retrieve content
    console.log('STEP 3: Retrieve Content from Gateway');
    console.log('='.repeat(60));
    const retrieved = await retrieveContent(cid);

    // Summary
    console.log('='.repeat(60));
    console.log('TEST SUMMARY');
    console.log('='.repeat(60));
    console.log('CID:', cid);
    console.log('Upload:', '✅ SUCCESS');
    console.log('Pin Verified:', isPinned ? '✅ SUCCESS' : '❌ FAILED');
    console.log('Content Retrieved:', retrieved ? '✅ SUCCESS' : '❌ FAILED');
    console.log('');

    if (isPinned && retrieved) {
      console.log('🎉 ALL TESTS PASSED - Supernode is working correctly!');
    } else if (!isPinned && retrieved) {
      console.log('⚠️  PARTIAL SUCCESS - Content is available but pin verification failed');
      console.log('   This suggests an issue with the pin/ls endpoint');
    } else {
      console.log('❌ TESTS FAILED - Supernode has issues');
    }

  } catch (error) {
    console.error('\n❌ Test failed with error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// Run the test
runTest();
