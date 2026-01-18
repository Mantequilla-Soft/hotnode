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
