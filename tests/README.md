# Hot Node Tests

Test scripts for validating hotnode functionality.

## upload-test.js

Tests the pin validation workflow by uploading content that doesn't exist in MongoDB collections.

### Setup

Make sure `IPFS_API_URL` is set in your `.env` file:

```bash
IPFS_API_URL=https://hotipfs-1.3speak.tv
```

### Usage

**Upload a single file:**
```bash
node tests/upload-test.js path/to/file.txt
```

**Upload a directory recursively:**
```bash
node tests/upload-test.js -r path/to/directory
```

### What it tests

1. ✅ Content uploads to hotnode via IPFS API
2. ✅ Pin is created and verified
3. ✅ Pin appears in dashboard with "pending" status
4. ✅ mongoValidator marks as "invalid" (not in MongoDB collections)
5. ✅ Cleanup worker deletes invalid pins after retention period (2 days)

### Create test content

**Single file:**
```bash
echo "This is a test file" > test-file.txt
node tests/upload-test.js test-file.txt
```

**Directory:**
```bash
mkdir -p test-directory
echo "File 1" > test-directory/file1.txt
echo "File 2" > test-directory/file2.txt
node tests/upload-test.js -r test-directory
```

### Expected results

- CID will be printed to console
- Check dashboard to see pin status
- Initially: status = "pending"
- After mongoValidator runs: status = "invalid"
- After 2 days: pin deleted by cleanup worker

---

## supernode-check-test.js

Tests the supernode pin verification logic to ensure it correctly identifies which CIDs exist on the supernode vs only on the hotnode.

### Purpose

This test validates that the hotnode can accurately distinguish between:
- Content that exists on the supernode (migrated)
- Content that only exists locally on the hotnode (not yet migrated)

This is critical for the migration worker to function correctly.

### Setup

Requirements:
- Local IPFS Kubo node running on `http://127.0.0.1:5001`
- Access to supernode API at `http://65.21.201.94:5002`

### Usage

```bash
node tests/supernode-check-test.js
```

### What it tests

1. ✅ Creates unique test content with timestamp
2. ✅ Pins content to local IPFS
3. ✅ Checks supernode - **should return FALSE** (not migrated yet)
4. ✅ Pins to hotnode
5. ✅ Checks supernode again - **should still return FALSE** (only on hotnode)

### Expected output

```
TEST 1: Check supernode BEFORE migration
EXPECTED: FALSE (not on supernode)
✅ TEST PASSED: CID correctly reported as NOT on supernode

TEST 2: Check supernode AFTER pinning to hotnode  
EXPECTED: FALSE (only on hotnode, not supernode)
✅ TEST PASSED: CID correctly reported as NOT on supernode

🎉 ALL TESTS PASSED - Verification logic is working correctly!
```

### Debugging

The test prints detailed response information:
- HTTP status code
- Response data type (string vs object)
- Full response structure
- Which logic branch was used for verification

This helps diagnose issues with the supernode API integration.

### Why this matters

If the verification logic reports false positives (saying content exists on supernode when it doesn't):
- Migration worker won't attempt to migrate content
- Content remains only on hotnode
- No redundancy achieved
- Defeats the purpose of the migration system
