const axios = require('axios');
const fs = require('fs');
const config = require('./config');

class IPFSClient {
  constructor(apiUrl = config.hotnode.ipfs_api) {
    this.apiUrl = apiUrl;
    this.timeout = 30000; // 30 seconds default
  }

  /**
   * Check if IPFS daemon is running
   */
  async isRunning() {
    try {
      await axios.post(`${this.apiUrl}/api/v0/id`, null, {
        timeout: 5000
      });
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Get IPFS node ID and information
   */
  async id() {
    try {
      const response = await axios.post(`${this.apiUrl}/api/v0/id`, null, {
        timeout: this.timeout
      });
      return response.data;
    } catch (error) {
      throw new Error(`IPFS id failed: ${error.message}`);
    }
  }

  /**
   * Get object size from IPFS (legacy dag-pb only)
   */
  async objectStat(cid) {
    try {
      const response = await axios.post(
        `${this.apiUrl}/api/v0/object/stat`,
        null,
        {
          params: { arg: cid },
          timeout: this.timeout
        }
      );
      return response.data;
    } catch (error) {
      throw new Error(`IPFS object stat failed for ${cid}: ${error.message}`);
    }
  }

  /**
   * Get DAG statistics (works with all CID types in Kubo 0.23+)
   */
  async dagStat(cid) {
    try {
      const response = await axios.post(
        `${this.apiUrl}/api/v0/dag/stat`,
        null,
        {
          params: { arg: cid },
          timeout: this.timeout
        }
      );
      return response.data;
    } catch (error) {
      throw new Error(`IPFS dag stat failed for ${cid}: ${error.message}`);
    }
  }

  /**
   * Get block statistics (works with all CID types, returns raw block size)
   */
  async blockStat(cid) {
    try {
      const response = await axios.post(
        `${this.apiUrl}/api/v0/block/stat`,
        null,
        {
          params: { arg: cid },
          timeout: this.timeout
        }
      );
      return response.data;
    } catch (error) {
      throw new Error(`IPFS block stat failed for ${cid}: ${error.message}`);
    }
  }

  /**
   * Get cumulative size of a CID (including all children)
   * Uses fallback strategy to support both old and new Kubo versions
   */
  async getCIDSize(cid) {
    console.log(`Getting size for CID: ${cid}`);
    
    // Try dag/stat first (Kubo 0.23+, works with all CID types)
    try {
      console.log(`Trying dag/stat for ${cid}...`);
      const dagStat = await this.dagStat(cid);
      if (dagStat && dagStat.Size) {
        console.log(`✓ dag/stat succeeded: ${dagStat.Size} bytes`);
        return dagStat.Size;
      }
      console.log(`dag/stat returned no size data`);
    } catch (error) {
      console.log(`dag/stat failed: ${error.message}`);
    }

    // Try object/stat (legacy, works with dag-pb only)
    try {
      console.log(`Trying object/stat for ${cid}...`);
      const objStat = await this.objectStat(cid);
      if (objStat && (objStat.CumulativeSize || objStat.BlockSize)) {
        const size = objStat.CumulativeSize || objStat.BlockSize;
        console.log(`✓ object/stat succeeded: ${size} bytes`);
        return size;
      }
      console.log(`object/stat returned no size data`);
    } catch (error) {
      console.log(`object/stat failed: ${error.message}`);
    }

    // Try block/stat as last resort (single block size)
    try {
      console.log(`Trying block/stat for ${cid}...`);
      const blockStat = await this.blockStat(cid);
      if (blockStat && blockStat.Size) {
        console.log(`✓ block/stat succeeded: ${blockStat.Size} bytes`);
        return blockStat.Size;
      }
      console.log(`block/stat returned no size data`);
    } catch (error) {
      console.log(`block/stat failed: ${error.message}`);
    }

    console.error(`Failed to get size for CID ${cid}: all methods exhausted`);
    return 0;
  }

  /**
   * List all pins or check specific pin
   */
  async pinLs(cid = null, type = 'recursive') {
    try {
      let url = `${this.apiUrl}/api/v0/pin/ls`;
      if (cid) {
        url += `?arg=${cid}`;
      } else {
        url += `?type=${type}`;
      }

      const response = await axios.post(
        url,
        null,
        {
          timeout: this.timeout
        }
      );
      return response.data;
    } catch (error) {
      throw new Error(`IPFS pin ls failed: ${error.message}`);
    }
  }

  /**
   * Check if a CID is pinned
   */
  async isPinned(cid) {
    try {
      const result = await this.pinLs(cid);
      return result.Keys && result.Keys[cid] ? true : false;
    } catch (error) {
      return false;
    }
  }

  /**
   * Quick check if CID is resolvable (exists on network)
   * Uses a short timeout to fail fast on unavailable content
   * @param {string} cid - The CID to check
   * @returns {Promise<boolean>} True if CID is resolvable
   */
  async canResolve(cid) {
    try {
      const response = await axios.post(
        `${this.apiUrl}/api/v0/dag/resolve`,
        null,
        {
          params: { arg: cid },
          timeout: 10000 // 10 second timeout
        }
      );
      return response.data && response.data.Cid;
    } catch (error) {
      return false;
    }
  }

  /**
   * Pin a CID recursively
   * @param {string} cid - The CID to pin
   * @param {boolean} recursive - Whether to pin recursively
   * @param {number} timeout - Optional custom timeout in ms (default: 300000 = 5 minutes)
   */
  async pinAdd(cid, recursive = true, timeout = 300000) {
    try {
      const response = await axios.post(
        `${this.apiUrl}/api/v0/pin/add`,
        null,
        {
          params: {
            arg: cid,
            recursive: recursive
          },
          timeout: timeout
        }
      );
      return response.data;
    } catch (error) {
      if (error.code === 'ECONNABORTED') {
        throw new Error(`Timeout: CID ${cid} could not be fetched from the network within ${timeout/1000} seconds. The content may not exist or is unreachable.`);
      }
      throw new Error(`IPFS pin add failed for ${cid}: ${error.message}`);
    }
  }

  /**
   * Unpin a CID
   */
  async pinRm(cid, recursive = true) {
    try {
      const response = await axios.post(
        `${this.apiUrl}/api/v0/pin/rm`,
        null,
        {
          params: {
            arg: cid,
            recursive: recursive
          },
          timeout: this.timeout
        }
      );
      return response.data;
    } catch (error) {
      throw new Error(`IPFS pin rm failed for ${cid}: ${error.message}`);
    }
  }

  /**
   * Run garbage collection
   */
  async repoGC() {
    try {
      const response = await axios.post(
        `${this.apiUrl}/api/v0/repo/gc`,
        null,
        {
          timeout: 3600000 // 1 hour timeout for GC
        }
      );
      return response.data;
    } catch (error) {
      throw new Error(`IPFS repo gc failed: ${error.message}`);
    }
  }

  /**
   * Get repository statistics
   */
  async repoStat() {
    try {
      const response = await axios.post(
        `${this.apiUrl}/api/v0/repo/stat`,
        null,
        {
          timeout: this.timeout
        }
      );
      return response.data;
    } catch (error) {
      throw new Error(`IPFS repo stat failed: ${error.message}`);
    }
  }

  /**
   * Get bandwidth statistics
   */
  async statsBW() {
    try {
      const response = await axios.post(
        `${this.apiUrl}/api/v0/stats/bw`,
        null,
        {
          timeout: this.timeout
        }
      );
      return response.data;
    } catch (error) {
      throw new Error(`IPFS stats bw failed: ${error.message}`);
    }
  }

  /**
   * Get repository version
   */
  async version() {
    try {
      const response = await axios.post(
        `${this.apiUrl}/api/v0/version`,
        null,
        {
          timeout: this.timeout
        }
      );
      return response.data;
    } catch (error) {
      throw new Error(`IPFS version failed: ${error.message}`);
    }
  }
}

// Singleton instance
let instance = null;

function getIPFSClient(apiUrl) {
  if (!instance) {
    instance = new IPFSClient(apiUrl);
  }
  return instance;
}

module.exports = { IPFSClient, getIPFSClient };
