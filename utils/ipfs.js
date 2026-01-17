const axios = require('axios');
const fs = require('fs');
const config = require('../config.json');

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
   * Get object size from IPFS
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
   * Get cumulative size of a CID (including all children)
   */
  async getCIDSize(cid) {
    try {
      const stat = await this.objectStat(cid);
      return stat.CumulativeSize || stat.BlockSize || 0;
    } catch (error) {
      console.error(`Failed to get size for CID ${cid}:`, error.message);
      return 0;
    }
  }

  /**
   * List all pins or check specific pin
   */
  async pinLs(cid = null, type = 'recursive') {
    try {
      const params = { type };
      if (cid) {
        params.arg = cid;
      }

      const response = await axios.post(
        `${this.apiUrl}/api/v0/pin/ls`,
        null,
        {
          params,
          timeout: this.timeout
        }
      );
      return response.data;
    } catch (error) {
      // If pin doesn't exist, IPFS returns error
      if (error.response && error.response.status === 500) {
        return { Keys: {} };
      }
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
   * Pin a CID recursively
   */
  async pinAdd(cid, recursive = true) {
    try {
      const response = await axios.post(
        `${this.apiUrl}/api/v0/pin/add`,
        null,
        {
          params: {
            arg: cid,
            recursive: recursive
          },
          timeout: this.timeout * 2 // Allow more time for pinning
        }
      );
      return response.data;
    } catch (error) {
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
