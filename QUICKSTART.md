# Quick Start Guide

## ⚡ Get Running in 5 Minutes

### 1. Install Dependencies

```bash
cd /home/meno/Documents/menosoft/hotnode
npm install
```

### 2. Configure

```bash
# Copy example config
cp config.example.json config.json

# Edit with your settings
nano config.json
```

**Minimum required changes:**
- `mongodb.uri` → Your MongoDB connection string
- `supernode.api` → Your supernode URL
- `hotnode.name` → Unique name like "HotNode-Dev"

### 3. Initialize Database

```bash
npm run init-db
```

### 4. Start Service

```bash
npm run dev
```

### 5. Access Dashboard

Open in browser: http://localhost:3100

---

## 🧪 Testing Without Full Setup

### Test Database Only

```bash
# Initialize database
npm run init-db

# Query database
sqlite3 database/hotnode.db "SELECT * FROM config;"
```

### Test IPFS Connection

```bash
# Ensure IPFS is running
ipfs daemon &

# Start hot node
npm run dev

# In another terminal, test health
curl http://localhost:3100/health
```

### Test Workers Manually

```bash
# Run log parser
npm run worker:logs

# Run MongoDB validator (requires MongoDB connection)
npm run worker:validate

# Run migration worker
npm run worker:migrate

# Run cleanup worker
npm run worker:cleanup

# Run stats aggregator
npm run worker:stats
```

---

## 🐳 Docker Quick Start (Alternative)

Create `docker-compose.yml`:

```yaml
version: '3.8'

services:
  ipfs:
    image: ipfs/kubo:latest
    ports:
      - "4001:4001"
      - "5001:5001"
      - "8080:8080"
    volumes:
      - ipfs-data:/data/ipfs

  hotnode:
    build: .
    ports:
      - "3100:3100"
    depends_on:
      - ipfs
    volumes:
      - ./config.json:/app/config.json
      - ./database:/app/database
    environment:
      - NODE_ENV=production

volumes:
  ipfs-data:
```

Then:

```bash
docker-compose up -d
```

---

## 🔍 Verify Everything Works

### 1. Check Services

```bash
# Check if app is running
curl http://localhost:3100/health

# Check IPFS
curl http://localhost:5001/api/v0/id
```

### 2. Check Database

```bash
sqlite3 database/hotnode.db "
SELECT 
  (SELECT COUNT(*) FROM pins) as total_pins,
  (SELECT value FROM config WHERE key='enabled') as enabled;
"
```

### 3. Check Logs

```bash
# In development
tail -f logs/combined.log

# In production
journalctl -u ipfs-hotnode -f
```

---

## 🚨 Common Issues

### Port Already in Use

```bash
# Find what's using port 3101
lsof -i :3101

# Kill the process
kill -9 <PID>
```

### IPFS Not Running

```bash
# Start IPFS daemon
ipfs daemon &

# Or via systemd
systemctl start ipfs
```

### Config File Missing

```bash
# Copy from example
cp config.example.json config.json

# Verify it's valid JSON
cat config.json | jq .
```

### Database Locked

```bash
# Remove lock files
rm -f database/*.db-*

# Restart service
npm run dev
```

---

## 📚 Next Steps

Once running:

1. ✅ Enable hot node from dashboard (toggle switch)
2. ✅ Test manual pin add/remove
3. ✅ Trigger manual migration
4. ✅ Set up Discord webhook
5. ✅ Register with Traffic Director

For full deployment: See [DEPLOYMENT.md](DEPLOYMENT.md)

---

**Need Help?** Check [PROJECT_SUMMARY.md](PROJECT_SUMMARY.md) for troubleshooting.
