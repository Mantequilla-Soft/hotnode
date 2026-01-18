/**
 * Supernode Migration Check Test
 * 
 * This test verifies that supernode verification logic works correctly:
 * 1. Pin content locally to Kubo
 * 2. Get the CID
 * 3. Check supernode - should return FALSE (not on supernode yet)
 * 4. Pin to hotnode
 * 5. Check supernode again - should still return FALSE (only on hotnode)
 * 
 * Usage:
 *   node tests/supernode-check-test.js
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');

// Configuration
const IPFS_API_URL = 'http://127.0.0.1:5001';
const SUPERNODE_API_URL = 'http://65.21.201.94:5002';

/**
 * Add content to local IPFS
 */
async function addToIPFS(content) {
  try {
    console.log('📝 Creating test content...');
    
    const FormData = require('form-data');
    const form = new FormData();
    form.append('file', Buffer.from(content), {
      filename: 'test.txt',
      contentType: 'text/plain'
    });

    const response = await axios.post(
      `${IPFS_API_URL}/api/v0/add`,
      form,
      {
        headers: form.getHeaders(),
        timeout: 30000
      }
    );

    const cid = response.data.Hash;
    console.log('✅ Content added to local IPFS:', cid);
    return cid;
  } catch (error) {
    console.error('❌ Failed to add to IPFS:', error.message);
    throw error;
  }
}

/**
 * Pin to local IPFS
 */
async function pinToLocal(cid) {
  try {
    console.log('\n📌 Pinning to local IPFS...');
    
    await axios.post(
      `${IPFS_API_URL}/api/v0/pin/add?arg=${cid}&recursive=true`,
      null,
      { timeout: 30000 }
    );

    console.log('✅ Pinned to local IPFS:', cid);
  } catch (error) {
    console.error('❌ Failed to pin locally:', error.message);
    throw error;
  }
}

/**
 * Check if CID exists on supernode
 */
async function checkSupernode(cid) {
  try {
    console.log('\n🔍 Checking supernode for:', cid);
    
    const response = await axios.post(
      `${SUPERNODE_API_URL}/api/v0/pin/ls?arg=${cid}`,
      null,
      {
        timeout: 10000
      }
    );

    console.log('📊 Supernode response status:', response.status);
    console.log('📊 Supernode response data type:', typeof response.data);
    console.log('📊 Supernode response data:', JSON.stringify(response.data, null, 2));

    // Check using our current logic
    let exists = false;
    if (response.status === 200) {
      if (response.data && response.data.Keys && response.data.Keys[cid]) {
        exists = true;
        console.log('✅ Pin found in Keys object');
      } else if (typeof response.data === 'string') {
        exists = !response.data.includes('not pinned');
        console.log(`📝 String response: ${exists ? 'exists' : 'not found'}`);
      } else if (response.data && response.data.Message) {
        exists = !response.data.Message.includes('not pinned');
        console.log(`📝 Message field: ${exists ? 'exists' : 'not found'}`);
      } else {
        console.log('❓ No Keys, no string, no Message - treating as not found');
      }
    }

    console.log(`${exists ? '✅' : '❌'} Supernode check result: ${exists ? 'EXISTS' : 'NOT FOUND'}`);
    return exists;
  } catch (error) {
    console.log('❌ Supernode check error:', error.message);
    if (error.response) {
      console.log('   Status:', error.response.status);
      console.log('   Data:', error.response.data);
    }
    return false;
  }
}

/**
 * Pin to hotnode (local node acting as hotnode)
 */
async function pinToHotnode(cid) {
  try {
    console.log('\n📌 Pinning to hotnode...');
    
    await axios.post(
      `${IPFS_API_URL}/api/v0/pin/add?arg=${cid}&recursive=true`,
      null,
      { timeout: 30000 }
    );

    console.log('✅ Pinned to hotnode:', cid);
  } catch (error) {
    // Might already be pinned
    if (error.message.includes('already pinned')) {
      console.log('ℹ️  Already pinned to hotnode');
    } else {
      console.error('❌ Failed to pin to hotnode:', error.message);
      throw error;
    }
  }
}

/**
 * Main test flow
 */
async function runTest() {
  console.log('🧪 Supernode Migration Check Test\n');
  console.log('Configuration:');
  console.log('  Local IPFS:', IPFS_API_URL);
  console.log('  Supernode:', SUPERNODE_API_URL);
  console.log('=' .repeat(60));

  try {
    // Step 1: Create unique content with timestamp
    const testContent = `Supernode test ${Date.now()} - This content should NOT be on supernode`;
    const cid = await addToIPFS(testContent);

    // Step 2: Pin locally
    await pinToLocal(cid);

    // Step 3: Check supernode (should be FALSE)
    console.log('\n' + '='.repeat(60));
    console.log('TEST 1: Check supernode BEFORE migration');
    console.log('EXPECTED: FALSE (not on supernode)');
    console.log('='.repeat(60));
    
    const check1 = await checkSupernode(cid);
    
    if (check1) {
      console.log('\n❌ TEST FAILED: CID reported as existing on supernode when it shouldn\'t');
      console.log('   This indicates the verification logic has a bug!');
    } else {
      console.log('\n✅ TEST PASSED: CID correctly reported as NOT on supernode');
    }

    // Step 4: Pin to hotnode (simulate)
    await pinToHotnode(cid);

    // Step 5: Check supernode again (should still be FALSE)
    console.log('\n' + '='.repeat(60));
    console.log('TEST 2: Check supernode AFTER pinning to hotnode');
    console.log('EXPECTED: FALSE (only on hotnode, not supernode)');
    console.log('='.repeat(60));
    
    const check2 = await checkSupernode(cid);
    
    if (check2) {
      console.log('\n❌ TEST FAILED: CID reported as on supernode when it\'s only on hotnode');
      console.log('   This indicates the verification logic has a bug!');
    } else {
      console.log('\n✅ TEST PASSED: CID correctly reported as NOT on supernode');
    }

    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('TEST SUMMARY');
    console.log('='.repeat(60));
    console.log('CID:', cid);
    console.log('Test 1 (before hotnode):', check1 ? '❌ FAILED' : '✅ PASSED');
    console.log('Test 2 (after hotnode):', check2 ? '❌ FAILED' : '✅ PASSED');
    
    if (!check1 && !check2) {
      console.log('\n🎉 ALL TESTS PASSED - Verification logic is working correctly!');
    } else {
      console.log('\n❌ TESTS FAILED - Verification logic needs fixing!');
      process.exit(1);
    }

  } catch (error) {
    console.error('\n❌ Test failed with error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// Run the test
runTest();
