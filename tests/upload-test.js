#!/usr/bin/env node

/**
 * Test script to upload and pin content to hotnode
 * Mimics encoder behavior to test validation workflow
 * 
 * Usage:
 *   node upload-test.js <file-path>              # Upload single file
 *   node upload-test.js -r <directory-path>      # Upload directory recursively
 */

const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const axios = require('axios');

// Load .env from project root
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const IPFS_API_URL = process.env.IPFS_API_URL;

if (!IPFS_API_URL) {
  console.error('❌ IPFS_API_URL not found in .env file');
  process.exit(1);
}

console.log(`🔗 Using IPFS API: ${IPFS_API_URL}`);

/**
 * Add file/directory to IPFS
 */
async function addToIPFS(filePath, recursive = false) {
  try {
    const form = new FormData();
    const stats = fs.statSync(filePath);

    if (stats.isDirectory()) {
      if (!recursive) {
        throw new Error('Use -r flag to upload directories');
      }
      
      // Add all files in directory recursively
      console.log(`📁 Adding directory: ${filePath}`);
      addDirectoryToForm(form, filePath, filePath);
    } else {
      // Add single file
      console.log(`📄 Adding file: ${filePath}`);
      const fileStream = fs.createReadStream(filePath);
      form.append('file', fileStream, {
        filename: path.basename(filePath)
      });
    }

    // Upload to IPFS
    const uploadUrl = `${IPFS_API_URL}/api/v0/add`;
    console.log(`📤 Uploading to: ${uploadUrl}`);
    
    const response = await axios.post(
      uploadUrl,
      form,
      {
        params: {
          'wrap-with-directory': recursive ? 'true' : 'false',
          'pin': 'true'
        },
        headers: form.getHeaders(),
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        responseType: 'text' // Get raw text response for NDJSON
      }
    );

    // Parse NDJSON response (newline-delimited JSON)
    const lines = response.data.trim().split('\n');
    const results = lines.map(line => JSON.parse(line));
    
    // Get root CID (last entry for directories, only entry for files)
    const rootCID = results[results.length - 1];
    
    console.log('\n✅ Upload successful!');
    console.log(`📦 Root CID: ${rootCID.Hash}`);
    console.log(`📏 Total size: ${formatBytes(rootCID.Size)}`);
    
    if (results.length > 1) {
      console.log(`📂 Files uploaded: ${results.length - 1}`);
    }

    return rootCID.Hash;
  } catch (error) {
    console.error('❌ Upload failed:', error.message);
    if (error.response) {
      console.error('Response:', error.response.data);
    }
    throw error;
  }
}

/**
 * Recursively add directory contents to form data
 */
function addDirectoryToForm(form, dirPath, basePath) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    const relativePath = path.relative(basePath, fullPath);
    
    if (entry.isDirectory()) {
      addDirectoryToForm(form, fullPath, basePath);
    } else {
      const fileStream = fs.createReadStream(fullPath);
      form.append('file', fileStream, {
        filename: relativePath
      });
    }
  }
}

/**
 * Verify pin exists
 */
async function verifyPin(cid) {
  try {
    console.log('\n🔍 Verifying pin...');
    
    const response = await axios.post(
      `${IPFS_API_URL}/api/v0/pin/ls?arg=${cid}`,
      null,
      {
        timeout: 10000
      }
    );

    // Pin exists if Keys object contains the CID
    let exists = false;
    if (response.status === 200 && response.data && response.data.Keys) {
      exists = response.data.Keys[cid] !== undefined;
    } else if (typeof response.data === 'string') {
      exists = !response.data.includes('not pinned');
    }
    
    if (exists) {
      console.log('✅ Pin verified on hotnode');
      return true;
    }
    
    return false;
  } catch (error) {
    console.error('❌ Pin verification failed:', error.message);
    return false;
  }
}

/**
 * Format bytes to human readable
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

/**
 * Main execution
 */
async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.log('Usage:');
    console.log('  node upload-test.js <file-path>              # Upload single file');
    console.log('  node upload-test.js -r <directory-path>      # Upload directory recursively');
    process.exit(1);
  }

  let recursive = false;
  let targetPath;

  if (args[0] === '-r' || args[0] === '--recursive') {
    recursive = true;
    targetPath = args[1];
  } else {
    targetPath = args[0];
  }

  if (!targetPath) {
    console.error('❌ Please provide a file or directory path');
    process.exit(1);
  }

  if (!fs.existsSync(targetPath)) {
    console.error(`❌ Path not found: ${targetPath}`);
    process.exit(1);
  }

  try {
    console.log('🚀 Starting upload test...\n');
    
    const cid = await addToIPFS(targetPath, recursive);
    await verifyPin(cid);
    
    console.log('\n📊 Next steps:');
    console.log(`   1. Check dashboard at your hotnode URL`);
    console.log(`   2. Look for CID: ${cid}`);
    console.log(`   3. Should show as "pending" initially`);
    console.log(`   4. mongoValidator should mark as "invalid" (not in MongoDB)`);
    console.log(`   5. Should be deleted after ${process.env.INVALID_RETENTION_DAYS || 2} days`);
    console.log('\n✨ Test complete!');
    
  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    process.exit(1);
  }
}

main();
