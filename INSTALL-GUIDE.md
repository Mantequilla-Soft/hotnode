# IPFS Hot Node Installation Guide

## Overview

The install script supports two deployment scenarios and two node types:

**Deployment Scenarios:**
1. **Domain-Based Deployment** (production servers with public domains)
2. **IP-Only Deployment** (private networks, no domain needed - Public IP address only)

**Node Types:**
1. **Infrastructure Node** (3speak managed, has MongoDB access, exposes validation API)
2. **Community Node** (third-party operators, uses remote validation, reports health)

## Prerequisites

- Ubuntu 20.04+ or Debian 11+
- Root/sudo access
- Minimum 4GB RAM
- 100GB+ available disk space
- For domain-based: Domain must point to server IP before SSL setup

## Installation

### 1. Download/Clone Repository

```bash
git clone https://github.com/3speak/ipfs-hotnode.git
cd ipfs-hotnode
```

### 2. Run Install Script

```bash
sudo bash scripts/install.sh
```

### 3. Follow Interactive Prompts

The script will ask:

#### Node Type Configuration
```
What type of node is this?

  INFRASTRUCTURE - 3speak managed server
    • Has MongoDB access for video validation
    • Exposes validation API for community nodes
    • Full monitoring and control

  COMMUNITY - Third-party operator node
    • No MongoDB access needed
    • Uses 3speak validation API
    • Reports health to 3speak monitoring

Node type (infrastructure/community):
```

**For Infrastructure Nodes:**
- You'll be prompted for MongoDB credentials
- Required for video validation
- Exposes validation API endpoint

**For Community Nodes:**
- You'll be prompted for validation server URL
- Default: `https://admin-hotipfs-1.3speak.tv`
- No MongoDB access needed (more secure)

#### Domain Configuration
```
Do you want to configure a domain for this hot node? (y/n)
```

- **YES** - For production deployments with public domains
- **NO** - For IP-only access (community nodes)

#### If YES - Domain Setup

You'll be prompted for:

```
Enter domain name (e.g., hotipfs-1.3speak.tv): your-domain.com
```

```
Install SSL certificate with Let's Encrypt? (y/n)
```

If SSL is enabled, you'll need:
```
Enter email for Let's Encrypt notifications: admin@example.com
```

**Important:** Make sure your domain's DNS points to this server's IP before SSL setup!

#### If NO - IP-Only Setup

The script will configure:
- IPFS gateway on port 8080 (direct access)
- Optional nginx proxy on port 8090 (for logging)
- Dashboard on port 3100

## What Gets Installed

### System Dependencies
- Node.js v20
- Kubo IPFS v0.30.0
- Nginx
- SQLite3
- Certbot (for SSL)
- UFW firewall

### Services
- IPFS daemon (systemd service)
- Hot Node application (systemd service)

### Directory Structure
```
/opt/ipfs-hotnode/          # Application directory
├── database/               # SQLite database
├── logs/                   # Application logs
└── .env                    # Configuration file
```

## Post-Installation

### 1. Configure Environment

Edit the configuration file:
```bash
sudo nano /opt/ipfs-hotnode/.env
```

**Required settings:**
- `ADMIN_PASSWORD` - Dashboard login password
- `NODE_TYPE` - Already set by installer (infrastructure/community)

**Infrastructure nodes also need:**
- `MONGODB_URI` - Already set by installer

**Community nodes also need:**
- `VALIDATION_SERVER_URL` - Already set by installer (default: admin-hotipfs-1.3speak.tv)

**Optional settings:**
- `DISCORD_WEBHOOK_URL` - Your own custom webhook for monitoring
- `DEFAULT_WEBHOOK_URL` - Already set (3speak monitoring, required)

### 2. Start Services

```bash
# Start hot node service
sudo systemctl start ipfs-hotnode

# Check status
sudo systemctl status ipfs-hotnode

# View logs
sudo journalctl -u ipfs-hotnode -f
```

## Access Points

### Domain-Based Deployment

- **IPFS Gateway:** `https://your-domain.com` (or `http://` without SSL)
- **Dashboard:** `http://server-ip:3100`

### IP-Only Deployment

- **IPFS Gateway (Direct):** `http://server-ip:8080`
- **IPFS Gateway (Nginx):** `http://server-ip:8090`
- **Dashboard:** `http://server-ip:3100`

## Firewall Ports

### Domain-Based
- 22 (SSH)
- 80 (HTTP)
- 443 (HTTPS)
- 3100 (Dashboard)
- 4001 (IPFS Swarm)

### IP-Only
- 22 (SSH)
- 3100 (Dashboard)
- 4001 (IPFS Swarm)
- 8080 (IPFS Gateway)
- 8090 (Nginx Proxy)

## SSL Certificate Renewal

If you installed SSL, certificates auto-renew via certbot:

```bash
# Test renewal
sudo certbot renew --dry-run

# Force renewal
sudo certbot renew
```

## Version Checking

The install script now checks IPFS versions:
- If the required version is already installed, it skips installation
- If a different version is found, it prompts to upgrade
- Prevents version mismatches

## Upgrading IPFS

To upgrade IPFS manually:

```bash
# Stop services
sudo systemctl stop ipfs-hotnode ipfs

# Run install script (it will detect and offer upgrade)
sudo bash scripts/install.sh

# Or download manually
wget https://dist.ipfs.tech/kubo/v0.30.0/kubo_v0.30.0_linux-amd64.tar.gz
tar -xzf kubo_v0.30.0_linux-amd64.tar.gz
cd kubo
sudo bash install.sh

# Restart services
sudo systemctl start ipfs ipfs-hotnode
```

## Troubleshooting

### Nginx configuration test fails
```bash
sudo nginx -t
```

### IPFS not starting
```bash
sudo journalctl -u ipfs -f
```

### Check IPFS version
```bash
ipfs version
```

### Hot node not connecting to IPFS
Check IPFS API is accessible:
```bash
curl http://127.0.0.1:5001/api/v0/version
```

### SSL certificate issues
```bash
sudo certbot certificates
sudo certbot renew --dry-run
```

## Uninstall

To remove the hot node service:
```bash
sudo bash scripts/install-service.sh --uninstall
```

To remove IPFS:
```bash
sudo systemctl stop ipfs
sudo systemctl disable ipfs
sudo rm /etc/systemd/system/ipfs.service
sudo rm /usr/local/bin/ipfs
```

## Community vs Infrastructure Deployment

### 3speak Infrastructure Servers
- **Node Type:** Infrastructure
- **MongoDB:** Direct access with credentials
- **Validation:** Queries MongoDB directly
- **API:** Exposes validation endpoint for community nodes
- **Domain:** Usually has domain (hotipfs-N.3speak.tv)
- **SSL:** Enable with Let's Encrypt
- **Webhook:** Reports to 3speak + optional custom

### Community Hot Nodes
- **Node Type:** Community
- **MongoDB:** No access needed (more secure)
- **Validation:** Calls infrastructure node's API
- **Domain:** Optional (can be IP-only)
- **SSL:** Optional
- **Webhook:** Reports health to 3speak + optional custom
- **Benefits:**
  - No database credentials needed
  - Simpler setup
  - More secure
  - Can run anywhere
  - Still fully functional

## Support

For issues or questions:
- GitHub Issues: https://github.com/3speak/ipfs-hotnode/issues
- Discord: [3speak Community]
