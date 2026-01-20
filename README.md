# IPFS Hot Node Service

Lightweight IPFS hot node service that provides temporary high-speed storage for video uploads, automatically migrates content to supernode within 7 days, and provides operators with an admin dashboard for monitoring and manual intervention.

## Features

- 🚀 Automatic log parsing and pin tracking
- ✅ MongoDB validation against Traffic Director
- 📦 Automatic migration to supernode (4-7 day window)
- 🧹 Automatic cleanup and garbage collection
- 📊 Real-time monitoring dashboard with authentication
- 💓 Health check API for Traffic Director integration
- 🔔 Discord notifications for critical events
- 🎛️ Manual intervention via web UI
- 🔐 Password-protected admin controls

## Traffic Volume

- ~50 videos/day
- HLS structures with recursive pins
- 7-day migration window (strict)

## Requirements

- Ubuntu 20.04+ (or Debian-based Linux)
- Node.js v20+
- Kubo IPFS v0.30+
- nginx v1.18+
- SQLite3
- 4GB RAM minimum
- 500GB+ disk space

## Quick Start

### Installation

```bash
# Clone the repository
cd /opt
sudo git clone <repository-url> ipfs-hotnode
cd ipfs-hotnode

# Run the installation script (as root)
sudo bash scripts/install.sh
```

### Manual Setup

```bash
# Install dependencies
npm install

# Initialize database
npm run init-db

# Configure environment variables
cp .env.example .env
nano .env

# Set your admin password and other settings
# Required: ADMIN_PASSWORD, SUPERNODE_API
# Optional: MONGODB_URI (for video validation)

# Start the service
npm start
```

### SystemD Service

```bash
# Enable and start the service
sudo systemctl enable ipfs-hotnode
sudo systemctl start ipfs-hotnode

# Check status
sudo systemctl status ipfs-hotnode

# View logs
sudo journalctl -u ipfs-hotnode -f
```

## Configuration

All configuration is done via environment variables in the `.env` file.

### Environment Variables

Copy `.env.example` to `.env` and configure:

```bash
# Required
ADMIN_PASSWORD=your_secure_password_here
SUPERNODE_API=http://65.21.201.94:5002

# Optional
MONGODB_URI=mongodb://username:password@host:port/database
HOTNODE_NAME=HotNode-01
HOTNODE_PORT=3101
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...

# Migration Settings
MIGRATION_START_AFTER_DAYS=4
MIGRATION_DELETE_AFTER_DAYS=7

# Cleanup Settings
CLEANUP_INVALID_RETENTION_DAYS=2

# Health Thresholds
HEALTH_DISK_WARNING_PERCENT=80
HEALTH_DISK_CRITICAL_PERCENT=90
```

See `.env.example` for all available options with descriptions.

## Admin Dashboard

Access the web UI at: `http://your-server:3101`

### Authentication

The dashboard is **view-only by default**. To perform administrative actions:

1. Click **🔒 Login** in the top-right corner
2. Enter your admin password (from `.env`)
3. All controls become enabled

**Protected Actions:**
- Toggle enable/disable hotnode
- Add/remove pins manually
- Trigger migrations or garbage collection
- Modify settings

See [AUTHENTICATION.md](AUTHENTICATION.md) for details.

### Pages

- **Dashboard**: System status, pin statistics, repo usage
- **Pins**: Browse/search pins, manual pin management
- **Stats**: Traffic graphs and bandwidth analytics
- **Settings**: Configuration, manual worker triggers

## Health Check API

The Traffic Director polls the health check endpoint:

```bash
GET http://your-server:3100/health
```

Response includes:
- Enabled status
- Disk usage percentage
- Bandwidth metrics (24h)
- Pin counts (total, pending, overdue)

## Workers

The service runs several background workers:

1. **MongoDB Validator** (every 30 minutes) - Validates CIDs against Traffic Director
2. **Migration Worker** (every 12 hours) - Migrates old content to supernode
3. **Cleanup Worker** (daily at 2 AM) - Unpins migrated content, runs GC
4. **Stats Aggregator** (hourly) - Collects bandwidth and repo statistics

## Architecture

```
Encoder → nginx:5001 → Kubo IPFS → Hot Node Service → Supernode
                ↓                           ↓
           access.log                  SQLite DB
                                           ↓
                                    Admin Dashboard
                                           ↓
                                   Traffic Director
```

## Ports

- **5001**: IPFS API (nginx proxy for uploads)
- **8080**: IPFS Gateway (public content access)
- **4001**: IPFS Swarm (p2p networking)
- **3101**: Admin Dashboard & API

## Security Notes

- ✅ Password-protected admin dashboard (session-based auth)
- ⚠️ No authentication on IPFS API (open contribution model)
- ✅ MongoDB validator prevents abuse
- ⚠️ Admin dashboard should be internal/VPN/firewalled
- ✅ Sensitive credentials in `.env` (not committed to git)
- ✅ Regular GC prevents disk exhaustion

**Important:** Never commit `.env` to version control!

## Monitoring

### Daily Checks (Automated)
- ✅ Cleanup worker runs
- ✅ Stats aggregated
- ✅ Health check responding

### Weekly Checks (Manual)
- Review migration success rate
- Check for overdue pins
- Review disk usage trends
- Verify supernode connectivity

## Troubleshooting

### Check service status
```bash
sudo systemctl status ipfs-hotnode
sudo journalctl -u ipfs-hotnode -n 100
```

### Check IPFS
```bash
ipfs id
ipfs pin ls --type=recursive | wc -l
ipfs repo stat
```

### Check nginx logs
```bash
tail -f /var/log/nginx/ipfs-access.log
tail -f /var/log/nginx/ipfs-error.log
```

### Database queries
```bash
sqlite3 database/hotnode.db "SELECT status, COUNT(*) FROM pins GROUP BY status;"
sqlite3 database/hotnode.db "SELECT * FROM pins WHERE migrated=0 ORDER BY added_at DESC LIMIT 10;"
```

## Development

```bash
# Run in development mode
npm run dev

# Initialize fresh database
npm run init-db

# Test individual workers
npm run worker:validate  # MongoDB validator
npm run worker:migrate   # Migration worker
npm run worker:cleanup   # Cleanup & GC
npm run worker:stats     # Stats aggregator
```

## Documentation

- [README.md](README.md) - This file (overview)
- [QUICKSTART.md](QUICKSTART.md) - Get running in 5 minutes
- [AUTHENTICATION.md](AUTHENTICATION.md) - Admin auth setup
- [DEPLOYMENT.md](DEPLOYMENT.md) - Production deployment guide
- [DEVELOPMENT.md](DEVELOPMENT.md) - Developer documentation
- [PROJECT_STRUCTURE.md](PROJECT_STRUCTURE.md) - Code organization
- [PROJECT_SUMMARY.md](PROJECT_SUMMARY.md) - Technical overview

## License

MIT

## Support

For issues and questions, contact: support@3speak.tv
