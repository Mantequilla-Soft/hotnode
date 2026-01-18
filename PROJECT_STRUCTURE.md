# IPFS Hot Node Service - Complete Project Structure

```
ipfs-hotnode/
│
├── 📄 Core Application Files
│   ├── app.js                          # Main Express application (entry point)
│   ├── package.json                    # Node.js dependencies and scripts
│   ├── .env.example                    # Environment variable template
│   └── .gitignore                      # Git ignore rules
│
├── 📚 Documentation
│   ├── README.md                       # User guide and overview
│   ├── QUICKSTART.md                   # 5-minute quick start
│   ├── DEPLOYMENT.md                   # Complete deployment guide
│   ├── DEVELOPMENT.md                  # Developer documentation
│   └── PROJECT_SUMMARY.md              # This scaffold summary
│
├── 🔧 Configuration Files
│   ├── config/
│   │   ├── nginx-ipfs-hotnode.conf    # nginx reverse proxy config
│   │   └── ipfs-hotnode.service       # systemd service definition
│
├── 🛠️ Utility Modules
│   ├── utils/
│   │   ├── config.js                  # Centralized configuration (loads .env)
│   │   ├── database.js                # SQLite database wrapper
│   │   ├── ipfs.js                    # IPFS API client
│   │   ├── mongo.js                   # MongoDB client (for validation)
│   │   ├── discord.js                 # Discord webhook integration
│   │   └── logger.js                  # Winston logger configuration
│
├── ⚙️ Worker Modules (Automated Tasks)
│   ├── workers/
│   │   ├── logParser.js               # Parse nginx logs (every 5 min)
│   │   ├── mongoValidator.js          # Validate CIDs (every 30 min)
│   │   ├── migrationWorker.js         # Migrate to supernode (every 12h)
│   │   ├── cleanupWorker.js           # Cleanup & GC (daily)
│   │   └── statsAggregator.js         # Collect statistics (hourly)
│
├── 🌐 API Routes
│   ├── routes/
│   │   ├── health.js                  # Health check API (for Traffic Director)
│   │   ├── api.js                     # Admin API endpoints
│   │   └── admin.js                   # Dashboard page routes
│
├── 🎨 Web Dashboard (Views)
│   ├── views/
│   │   ├── dashboard.ejs              # Main dashboard
│   │   ├── pins.ejs                   # Pin management page
│   │   ├── settings.ejs               # Settings page
│   │   ├── stats.ejs                  # Statistics page
│   │   └── layout.ejs                 # Base layout template
│
├── 🎭 Frontend Assets
│   ├── public/
│   │   ├── css/
│   │   │   └── style.css              # Dashboard styles
│   │   └── js/
│   │       └── main.js                # Dashboard JavaScript
│
├── 📜 Installation Scripts
│   ├── scripts/
│   │   ├── install.sh                 # Automated installation script
│   │   └── initDatabase.js            # Database initialization
│
├── 💾 Runtime Directories (Created on First Run)
│   ├── database/
│   │   └── hotnode.db                 # SQLite database (auto-created)
│   ├── logs/
│   │   ├── combined.log               # Application logs (auto-created)
│   │   └── error.log                  # Error logs (auto-created)
│   └── node_modules/                  # npm dependencies (after npm install)
│
└── 🔒 Ignored Files (.gitignore)
    ├── .env                           # User configuration (not in git)
    ├── database/*.db                  # Database files (not in git)
    ├── logs/*.log                     # Log files (not in git)
    └── node_modules/                  # Dependencies (not in git)
```

## File Count Summary

| Category | Files | Lines of Code (est.) |
|----------|-------|---------------------|
| Core Application | 1 | 200 |
| Documentation | 5 | 1,500 |
| Configuration | 2 | 100 |
| Utilities | 5 | 800 |
| Workers | 5 | 1,000 |
| Routes | 3 | 600 |
| Views | 5 | 800 |
| Frontend | 2 | 500 |
| Scripts | 2 | 300 |
| **Total** | **30** | **~5,800** |

## Key Features by File

### Core Entry Point
- **app.js** - Express server, worker scheduling, graceful shutdown

### Data Layer
- **utils/database.js** - All database operations (pins, stats, config, events)
- **scripts/initDatabase.js** - Schema creation and migration

### External Integrations
- **utils/ipfs.js** - IPFS pinning, unpinning, stats, GC
- **utils/mongo.js** - CID validation against Traffic Director
- **utils/discord.js** - Event notifications

### Business Logic (Workers)
- **workers/logParser.js** - Discovers new uploads from nginx logs
- **workers/mongoValidator.js** - Validates CIDs are legitimate
- **workers/migrationWorker.js** - Pins content to supernode
- **workers/cleanupWorker.js** - Unpins old content, runs GC
- **workers/statsAggregator.js** - Collects bandwidth metrics

### API & Dashboard
- **routes/health.js** - `/health` endpoint for Traffic Director
- **routes/api.js** - Admin API (pin management, config, stats)
- **routes/admin.js** - Dashboard pages (HTML rendering)
- **views/*.ejs** - Dashboard UI templates

### Deployment
- **config/nginx-ipfs-hotnode.conf** - Reverse proxy & logging
- **config/ipfs-hotnode.service** - systemd service
- **scripts/install.sh** - One-command installation

## Dependencies Overview

### Production Dependencies
```json
{
  "express": "Web framework",
  "sqlite3": "Database",
  "mongodb": "CID validation",
  "node-cron": "Worker scheduling",
  "axios": "HTTP client",
  "ejs": "Templating",
  "chart.js": "Dashboard charts",
  "tail": "Log file watching",
  "winston": "Logging",
  "express-rate-limit": "Rate limiting"
}
```

### Development Dependencies
```json
{
  "nodemon": "Auto-restart in development"
}
```

## Configuration Structure

### .env (User-Editable)
```bash
# Hot Node Configuration
HOTNODE_NAME=HotNode-1              # Unique identifier
HOTNODE_PORT=3101                   # Dashboard port
IPFS_API=http://127.0.0.1:5001      # Local IPFS API URL
IPFS_GATEWAY=http://127.0.0.1:8080  # Local IPFS gateway URL

# Supernode Configuration
SUPERNODE_API=http://65.21.201.94:5002  # Supernode IPFS API

# MongoDB Configuration
MONGODB_URI=mongodb://localhost:27017/trafficdirector
MONGODB_COLLECTION=directors

# Migration Settings
MIGRATION_START_AFTER_DAYS=4
MIGRATION_DELETE_AFTER_DAYS=7
MIGRATION_BATCH_SIZE=10

# Discord Notifications
DISCORD_WEBHOOK_URL=                # Optional Discord webhook
```

## Database Schema

### Tables
1. **pins** - All pinned content (CID, status, migration state)
2. **traffic_stats** - Bandwidth statistics (hourly/daily/weekly)
3. **gc_logs** - Garbage collection history
4. **config** - Key-value configuration store
5. **events** - System event log

## API Endpoints

### Public (Traffic Director)
- `GET /health` - Health check

### Admin Dashboard
- `GET /` - Dashboard home
- `GET /pins` - Pin management
- `GET /settings` - Settings
- `GET /stats` - Statistics

### Admin API
- `POST /api/config/toggle` - Enable/disable
- `GET /api/pins` - List pins
- `POST /api/pins/add` - Manual pin
- `POST /api/pins/remove` - Manual unpin
- `POST /api/migration/run` - Run migration
- `POST /api/gc/run` - Run GC
- `GET /api/stats/:period` - Get stats

## Worker Schedule

| Worker | Frequency | Purpose |
|--------|-----------|---------|
| Log Parser | Every 5 minutes | Track new uploads |
| MongoDB Validator | Every 30 minutes | Validate CIDs |
| Migration Worker | Every 12 hours | Migrate to supernode |
| Cleanup Worker | Daily at 2 AM | Unpin & GC |
| Stats Aggregator | Every hour | Collect metrics |

## Ports Used

| Port | Service | Access |
|------|---------|--------|
| 3100 | Dashboard | Public (nginx proxy) |
| 3101 | Express App | Internal |
| 4001 | IPFS Swarm | Public |
| 5001 | IPFS API | Internal (nginx proxy) |
| 8080 | IPFS Gateway | Internal |

## System Requirements

- **OS**: Ubuntu 20.04+ or Debian 11+
- **Node.js**: v20+
- **IPFS**: Kubo v0.30+
- **RAM**: 4GB minimum
- **Disk**: 500GB+ for IPFS repo
- **Network**: 100 Mbps+

## Installation Methods

1. **Automated** - `sudo bash scripts/install.sh`
2. **Manual** - Follow DEPLOYMENT.md step-by-step
3. **Docker** - Use docker-compose.yml (in QUICKSTART.md)

## Monitoring Points

- Health endpoint response time
- Pin counts by status
- Disk usage percentage
- Migration success rate
- Worker execution errors
- Bandwidth utilization

## Security Features

- No credentials in code (all in .env)
- .env not committed to git
- MongoDB validation prevents abuse
- systemd service hardening
- Firewall configuration included
- Discord alerts for critical events

---

## Ready to Deploy? 🚀

Follow these docs in order:

1. **QUICKSTART.md** - Get running locally in 5 minutes
2. **DEPLOYMENT.md** - Deploy to production server
3. **DEVELOPMENT.md** - Customize and extend

**Questions?** Check PROJECT_SUMMARY.md for comprehensive overview.
