# IPFS Hot Node - Deployment Guide

## Overview

This guide covers the deployment and configuration of the IPFS Hot Node Service on Ubuntu/Debian systems.

## System Requirements

### Hardware
- **CPU**: 2+ cores recommended
- **RAM**: 4GB minimum, 8GB recommended
- **Disk**: 500GB+ SSD (for IPFS repository)
- **Network**: 100 Mbps+ connection

### Software
- Ubuntu 20.04+ or Debian 11+
- Node.js v20+
- Kubo IPFS v0.30+
- nginx v1.18+
- MongoDB access (for validation)

## Quick Installation

### Automated Installation

```bash
# Clone the repository
git clone <repository-url> /opt/ipfs-hotnode
cd /opt/ipfs-hotnode

# Run the installation script
sudo bash scripts/install.sh
```

The script will:
1. Install system dependencies
2. Install Node.js v20
3. Install and configure Kubo IPFS
4. Install and configure nginx
5. Set up the Hot Node service
6. Configure firewall rules

### Post-Installation Configuration

After installation, edit the configuration file:

```bash
sudo nano /opt/ipfs-hotnode/config.json
```

**Required Configuration:**

1. **MongoDB Connection** - Update with Traffic Director details:
```json
"mongodb": {
  "uri": "mongodb://username:password@host:27017/database",
  "database": "trafficdirector",
  "collection": "directors"
}
```

2. **Supernode Configuration** - Update with your supernode API:
```json
"supernode": {
  "api": "https://supernode.example.com:5001"
}
```

3. **Hot Node Name** - Set a unique identifier:
```json
"hotnode": {
  "name": "HotNode-01"
}
```

4. **Discord Webhook** (optional):
```json
"discord": {
  "webhook_url": "https://discord.com/api/webhooks/..."
}
```

After editing, restart the service:

```bash
sudo systemctl restart ipfs-hotnode
```

## Manual Installation

### 1. Install Dependencies

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install base packages
sudo apt install -y curl wget git build-essential sqlite3 nginx ufw

# Install Node.js v20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

### 2. Install Kubo IPFS

```bash
# Download Kubo
cd /tmp
wget https://dist.ipfs.tech/kubo/v0.30.0/kubo_v0.30.0_linux-amd64.tar.gz
tar -xzf kubo_v0.30.0_linux-amd64.tar.gz
cd kubo
sudo bash install.sh

# Create IPFS user
sudo useradd -r -s /bin/bash -d /home/ipfs -m ipfs

# Initialize IPFS
sudo -u ipfs ipfs init

# Configure IPFS
sudo -u ipfs ipfs config Addresses.API /ip4/127.0.0.1/tcp/5001
sudo -u ipfs ipfs config Addresses.Gateway /ip4/127.0.0.1/tcp/8080
sudo -u ipfs ipfs config --json Datastore.StorageMax '"500GB"'
```

### 3. Create IPFS systemd Service

```bash
sudo nano /etc/systemd/system/ipfs.service
```

Paste the following:

```ini
[Unit]
Description=IPFS Daemon
After=network.target

[Service]
Type=simple
User=ipfs
Group=ipfs
ExecStart=/usr/local/bin/ipfs daemon
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable ipfs
sudo systemctl start ipfs
```

### 4. Configure nginx

```bash
# Copy nginx configuration
sudo cp /opt/ipfs-hotnode/config/nginx-ipfs-hotnode.conf /etc/nginx/sites-available/ipfs-hotnode

# Enable site
sudo ln -s /etc/nginx/sites-available/ipfs-hotnode /etc/nginx/sites-enabled/

# Test configuration
sudo nginx -t

# Restart nginx
sudo systemctl restart nginx
```

### 5. Install Hot Node Service

```bash
# Clone repository
sudo git clone <repository-url> /opt/ipfs-hotnode
cd /opt/ipfs-hotnode

# Set ownership
sudo chown -R ipfs:ipfs /opt/ipfs-hotnode

# Install dependencies
sudo -u ipfs npm install --production

# Copy configuration
sudo cp config.example.json config.json
sudo nano config.json  # Edit with your settings

# Initialize database
sudo -u ipfs npm run init-db

# Install systemd service
sudo cp config/ipfs-hotnode.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable ipfs-hotnode
sudo systemctl start ipfs-hotnode
```

### 6. Configure Firewall

```bash
# Enable firewall
sudo ufw enable

# Allow SSH
sudo ufw allow 22/tcp

# Allow IPFS swarm
sudo ufw allow 4001/tcp

# Allow Hot Node dashboard
sudo ufw allow 3100/tcp
```

## Verification

### Check Service Status

```bash
# Check Hot Node service
sudo systemctl status ipfs-hotnode

# Check IPFS daemon
sudo systemctl status ipfs

# Check nginx
sudo systemctl status nginx
```

### View Logs

```bash
# Hot Node logs
sudo journalctl -u ipfs-hotnode -f

# IPFS logs
sudo journalctl -u ipfs -f

# nginx logs
sudo tail -f /var/log/nginx/ipfs-access.log
```

### Test Health Endpoint

```bash
curl http://localhost:3100/health
```

Expected response:
```json
{
  "enabled": true,
  "timestamp": "2026-01-16T10:30:00Z",
  "disk_usage_percent": 5,
  "bandwidth_24h": {
    "in_mb": 0,
    "out_mb": 0
  },
  "pins": {
    "total": 0,
    "pending_migration": 0,
    "overdue": 0
  }
}
```

### Access Dashboard

Open in your browser:
```
http://your-server-ip:3100
```

## Configuration Management

### Environment Variables

The service runs in production mode by default. Set environment variables in the systemd service file:

```bash
sudo nano /etc/systemd/system/ipfs-hotnode.service
```

Add under `[Service]`:
```ini
Environment=NODE_ENV=production
Environment=NODE_OPTIONS=--max-old-space-size=2048
```

### Database Location

The SQLite database is stored at:
```
/opt/ipfs-hotnode/database/hotnode.db
```

### Backup Database

```bash
# Create backup
sudo -u ipfs sqlite3 /opt/ipfs-hotnode/database/hotnode.db ".backup '/backup/hotnode-$(date +%Y%m%d).db'"

# Restore backup
sudo -u ipfs sqlite3 /opt/ipfs-hotnode/database/hotnode.db ".restore '/backup/hotnode-20260116.db'"
```

## Monitoring

### Health Checks

The Traffic Director polls the health endpoint every time it routes traffic. You can monitor health status:

```bash
watch -n 5 'curl -s http://localhost:3100/health | jq'
```

### System Metrics

```bash
# IPFS stats
ipfs stats bw

# Repository stats
ipfs repo stat

# Pin count
ipfs pin ls --type=recursive | wc -l
```

### Database Queries

```bash
# Connect to database
sqlite3 /opt/ipfs-hotnode/database/hotnode.db

# Check pin stats
SELECT status, COUNT(*) FROM pins GROUP BY status;

# Check recent uploads
SELECT cid, status, added_at FROM pins ORDER BY added_at DESC LIMIT 10;

# Check overdue pins
SELECT COUNT(*) FROM pins 
WHERE julianday('now') - julianday(added_at) > 7 
AND migrated = 0;
```

## Troubleshooting

### Service Won't Start

```bash
# Check logs
sudo journalctl -u ipfs-hotnode -n 50

# Common issues:
# 1. Config file missing - copy from config.example.json
# 2. Database not initialized - run npm run init-db
# 3. IPFS not running - check sudo systemctl status ipfs
```

### IPFS Connection Issues

```bash
# Restart IPFS
sudo systemctl restart ipfs

# Check IPFS API
curl http://localhost:5001/api/v0/id

# Check IPFS connectivity
ipfs swarm peers | wc -l
```

### Migration Not Working

```bash
# Check supernode connectivity
curl -X POST "https://your-supernode:5001/api/v0/id"

# Manually trigger migration
curl -X POST http://localhost:3100/api/migration/run

# Check migration logs
sudo journalctl -u ipfs-hotnode | grep migration
```

### Database Locked

```bash
# If database is locked, restart service
sudo systemctl restart ipfs-hotnode

# Check for stale locks
ls -la /opt/ipfs-hotnode/database/
```

## Maintenance

### Update Service

```bash
# Pull latest changes
cd /opt/ipfs-hotnode
sudo -u ipfs git pull

# Install new dependencies
sudo -u ipfs npm install --production

# Restart service
sudo systemctl restart ipfs-hotnode
```

### Manual Garbage Collection

Via dashboard: Settings → Manual Actions → Run Garbage Collection

Or via command line:
```bash
curl -X POST http://localhost:3100/api/gc/run
```

### Clean Old Stats

Stats older than 90 days are automatically pruned. To manually clean:

```bash
sqlite3 /opt/ipfs-hotnode/database/hotnode.db "DELETE FROM traffic_stats WHERE julianday('now') - julianday(timestamp) > 90;"
```

## Performance Tuning

### IPFS Configuration

```bash
# Increase connection limits
ipfs config --json Swarm.ConnMgr.HighWater 900
ipfs config --json Swarm.ConnMgr.LowWater 600

# Adjust datastore settings
ipfs config --json Datastore.BloomFilterSize 1048576

# Restart IPFS
sudo systemctl restart ipfs
```

### System Limits

```bash
# Increase file descriptor limit
echo "ipfs soft nofile 65536" | sudo tee -a /etc/security/limits.conf
echo "ipfs hard nofile 65536" | sudo tee -a /etc/security/limits.conf
```

## Security Considerations

### Access Control

The IPFS API is intentionally open (no authentication) for the encoder contribution model. However:

1. **Use firewall rules** to restrict access if needed
2. **Keep MongoDB credentials secure** in config.json
3. **Restrict dashboard access** to internal network/VPN
4. **Regular updates** for security patches

### Secure Dashboard

To add basic authentication to nginx:

```bash
# Install apache2-utils
sudo apt install apache2-utils

# Create password file
sudo htpasswd -c /etc/nginx/.htpasswd admin

# Update nginx config
sudo nano /etc/nginx/sites-available/ipfs-hotnode
```

Add to dashboard location block:
```nginx
auth_basic "Hot Node Dashboard";
auth_basic_user_file /etc/nginx/.htpasswd;
```

## Traffic Director Integration

The Hot Node is designed to work with Traffic Director for routing encoder uploads.

### Register with Traffic Director

1. Ensure health endpoint is accessible
2. Add hot node URL to Traffic Director configuration
3. Traffic Director will automatically poll `/health` endpoint
4. Healthy nodes are included in round-robin routing

### Health Criteria

For Traffic Director to consider a node healthy:
- `enabled` must be `true`
- `disk_usage_percent` must be < 90%
- `pins.overdue` must be 0
- Response within 5 seconds
- HTTP 200 status

## Scaling

### Multiple Hot Nodes

Deploy multiple hot nodes for redundancy:

1. Install on separate servers
2. Use unique names (HotNode-01, HotNode-02, etc.)
3. Register all with Traffic Director
4. Traffic Director distributes load via round-robin

### Storage Expansion

To increase IPFS storage:

```bash
# Update storage limit
ipfs config --json Datastore.StorageMax '"1TB"'

# Restart IPFS
sudo systemctl restart ipfs
```

## Support

For issues and questions:
- GitHub Issues: <repository-url>/issues
- Email: support@3speak.tv
- Documentation: <repository-url>/docs

---

**Version**: 1.0.0  
**Last Updated**: January 16, 2026
