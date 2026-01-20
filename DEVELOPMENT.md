# Hot Node Service - Development Guide

## Project Structure

```
ipfs-hotnode/
├── app.js                      # Main Express application
├── package.json                # Node.js dependencies
├── .env                        # Runtime configuration (not in git)
├── .env.example                # Environment variable template
├── README.md                   # User documentation
├── DEPLOYMENT.md               # Deployment guide
├── DEVELOPMENT.md              # This file
├── scripts/
│   ├── install.sh             # Installation script
│   └── initDatabase.js        # Database initialization
├── utils/
│   ├── config.js              # Centralized config (loads .env)
│   ├── database.js            # SQLite database wrapper
│   ├── ipfs.js                # IPFS API client
│   ├── mongo.js               # MongoDB client
│   ├── discord.js             # Discord notifications
│   └── logger.js              # Winston logger
├── workers/
│   ├── mongoValidator.js      # Validate CIDs
│   ├── migrationWorker.js     # Migrate to supernode
│   ├── cleanupWorker.js       # Cleanup and GC
│   └── statsAggregator.js     # Collect statistics
├── routes/
│   ├── health.js              # Health check API
│   ├── api.js                 # Admin API endpoints
│   └── admin.js               # Dashboard routes
├── views/
│   ├── dashboard.ejs          # Main dashboard
│   ├── pins.ejs               # Pin management
│   ├── settings.ejs           # Settings page
│   └── stats.ejs              # Statistics page
├── public/
│   ├── css/
│   │   └── style.css          # Dashboard styles
│   └── js/
│       └── main.js            # Dashboard JavaScript
├── config/
│   ├── nginx-ipfs-hotnode.conf  # nginx configuration
│   └── ipfs-hotnode.service     # systemd service
├── database/
│   └── hotnode.db             # SQLite database (created at runtime)
└── logs/
    └── *.log                  # Application logs
```

## Development Setup

### Prerequisites

- Node.js v20+
- IPFS daemon running locally
- MongoDB instance (for testing validation)
- nginx (optional for testing log parsing)

### Installation

```bash
# Clone repository
git clone <repository-url>
cd ipfs-hotnode

# Install dependencies
npm install

# Copy environment file
cp .env.example .env

# Edit configuration for local development
nano .env

# Initialize database
npm run init-db

# Start development server
npm run dev
```

### Configuration for Development

Edit `.env`:

```bash
# Hot Node Configuration
HOTNODE_NAME=HotNode-Dev
HOTNODE_PORT=3101
IPFS_API=http://127.0.0.1:5001
IPFS_GATEWAY=http://127.0.0.1:8080

# MongoDB (for CID validation)
MONGODB_URI=mongodb://localhost:27017/trafficdirector
MONGODB_DATABASE=trafficdirector
MONGODB_COLLECTION=directors

# Nginx log path
NGINX_LOG_PATH=/var/log/nginx/ipfs-access.log

# Logging
LOG_LEVEL=debug
```

## Architecture

### Worker System

Workers run on scheduled intervals using `node-cron`:

1. **MongoDB Validator** (30 min) - Validates pending CIDs against MongoDB
2. **Migration Worker** (12 hours) - Migrates old pins to supernode
3. **Cleanup Worker** (daily) - Unpins migrated content, runs GC
4. **Stats Aggregator** (hourly) - Collects bandwidth and repo statistics

### Database Schema

**pins table:**
- Tracks all pinned content
- Status: pending → valid/invalid → migrated → unpinned

**traffic_stats table:**
- Hourly/daily bandwidth statistics
- Pruned after 90 days

**gc_logs table:**
- Garbage collection history

**config table:**
- Key-value configuration storage
- Tracks last run times for workers

**events table:**
- System event log for debugging

### API Endpoints

**Public (Traffic Director):**
- `GET /health` - Health check for routing decisions

**Admin Dashboard:**
- `GET /` - Dashboard home
- `GET /pins` - Pin management
- `GET /settings` - Settings page
- `GET /stats` - Statistics page

**Admin API:**
- `POST /api/config/toggle` - Enable/disable node
- `POST /api/config/update` - Update configuration
- `GET /api/pins` - List pins
- `POST /api/pins/add` - Manual pin add
- `POST /api/pins/remove` - Manual pin remove
- `POST /api/migration/run` - Trigger migration
- `POST /api/gc/run` - Trigger garbage collection
- `GET /api/stats/:period` - Get statistics

## Development Workflow

### Running Workers Manually

```javascript
// In Node.js REPL or test script
const mongoValidator = require('./workers/mongoValidator');
const result = await mongoValidator.run();
console.log(result);
```

### Testing IPFS Integration

```javascript
const { getIPFSClient } = require('./utils/ipfs');

async function test() {
  const ipfs = getIPFSClient();
  
  // Test connection
  const id = await ipfs.id();
  console.log('IPFS ID:', id.ID);
  
  // Test pin operations
  await ipfs.pinAdd('QmTest...');
  const isPinned = await ipfs.isPinned('QmTest...');
  console.log('Is pinned:', isPinned);
}
```

### Testing MongoDB Validation

```javascript
const { getMongoDBClient } = require('./utils/mongo');

async function test() {
  const mongo = getMongoDBClient();
  await mongo.connect();
  
  const valid = await mongo.validateCID('QmTest...');
  console.log('CID valid:', valid);
  
  await mongo.disconnect();
}
```

### Database Queries

```javascript
const { getDatabase } = require('./utils/database');

async function test() {
  const db = getDatabase();
  await db.connect();
  
  // Get statistics
  const stats = await db.getPinStats();
  console.log('Pin stats:', stats);
  
  // Get pending pins
  const pending = await db.getPendingPins();
  console.log('Pending pins:', pending.length);
  
  await db.close();
}
```

## Testing

### Unit Tests (TODO)

Create test files in `test/` directory:

```javascript
// test/database.test.js
const { Database } = require('../utils/database');

describe('Database', () => {
  it('should connect to database', async () => {
    const db = new Database();
    await db.connect();
    expect(db.db).toBeDefined();
    await db.close();
  });
});
```

### Integration Tests

```bash
# Test health endpoint
curl http://localhost:3100/health

# Test pin add
curl -X POST http://localhost:3100/api/pins/add \
  -H "Content-Type: application/json" \
  -d '{"cid":"QmTest..."}'

# Test migration
curl -X POST http://localhost:3100/api/migration/run
```

## Code Style

### JavaScript Standards

- Use ES6+ features (async/await, arrow functions, etc.)
- Use semicolons
- 2-space indentation
- Descriptive variable names
- Comments for complex logic

### Error Handling

Always use try-catch for async operations:

```javascript
async function example() {
  try {
    const result = await someAsyncOperation();
    return result;
  } catch (error) {
    logger.error('Operation failed:', error);
    throw error;
  }
}
```

### Logging

Use Winston logger with appropriate levels:

```javascript
logger.debug('Detailed debug information');
logger.info('General information');
logger.warn('Warning messages');
logger.error('Error messages', error);
```

## Contributing

### Workflow

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Make changes and test
4. Commit with descriptive messages
5. Push to your fork
6. Create a pull request

### Commit Messages

Follow conventional commits:

```
feat: add manual pin migration endpoint
fix: resolve database lock issue
docs: update deployment guide
refactor: improve log parsing performance
```

## Debugging

### Enable Debug Logging

```bash
# Set log level to debug in .env
sed -i 's/LOG_LEVEL=info/LOG_LEVEL=debug/' .env

# Restart service
systemctl restart ipfs-hotnode

# View logs
journalctl -u ipfs-hotnode -f
```

### Common Issues

**Database locked:**
- Usually caused by multiple processes accessing database
- Solution: Ensure only one instance of app.js is running

**IPFS connection failed:**
- Check IPFS daemon is running: `systemctl status ipfs`
- Test IPFS API: `curl http://localhost:5001/api/v0/id`

**Worker not running:**
- Check cron schedule is correct
- Manually run worker to see errors
- Check system time is correct

## Performance Optimization

### Database

- SQLite is fast for single-node setup
- For high volume, consider PostgreSQL
- Add indexes for frequently queried columns

### IPFS

- Adjust `migration.batch_size` for throughput
- Increase `migration.throttle_delay_ms` to reduce load
- Monitor IPFS memory usage

### Workers

- Adjust worker intervals based on traffic patterns
- Monitor worker execution times

## Monitoring

### Metrics to Track

- Pin counts by status
- Migration success/failure rates
- Disk usage trends
- Bandwidth usage
- Worker execution times
- Error rates

### Integration with Monitoring Tools

Add Prometheus metrics (future enhancement):

```javascript
const prometheus = require('prom-client');
const register = new prometheus.Registry();

const pinsGauge = new prometheus.Gauge({
  name: 'hotnode_pins_total',
  help: 'Total number of pins',
  labelNames: ['status']
});

register.registerMetric(pinsGauge);
```

## Deployment

See [DEPLOYMENT.md](DEPLOYMENT.md) for production deployment guide.

## Future Enhancements

### Planned Features

1. **Multi-supernode support** - Redundant migrations
2. **Prometheus metrics** - Better monitoring
3. **API authentication** - Secure admin endpoints
4. **IPFS Cluster integration** - Use IPFS Cluster for pin management
5. **Advanced analytics** - Content popularity tracking
6. **Auto-scaling GC** - Dynamic GC based on disk usage

### Contributing Ideas

Open an issue to discuss new features or improvements.

---

**Happy Coding!** 🚀
