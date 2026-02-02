# Quick Installation Reference

## One-Line Install

```bash
sudo bash scripts/install.sh
```

## Installation Scenarios

### 🏢 3speak Infrastructure Server

**When prompted:**
- Node type → `infrastructure`
- MongoDB URI → `mongodb://...`
- Configure domain? → `y`
- Domain name → `hotipfs-N.3speak.tv`
- Install SSL? → `y`
- Email → `your-email@3speak.tv`

**Result:**
```
✅ Node Type: Infrastructure
✅ MongoDB: Direct access
✅ Validation API: Exposed
✅ IPFS Gateway: https://hotipfs-N.3speak.tv
✅ SSL Auto-Renewal: Enabled
✅ Dashboard: http://SERVER_IP:3100
✅ Monitoring: 3speak + custom webhook
```

---

### 🏠 Community Hot Node (with domain)

**When prompted:**
- Node type → `community`
- Validation server → `https://admin-hotipfs-1.3speak.tv` (or press ENTER for default)
- Configure domain? → `y`
- Domain name → `your-domain.com`
- Install SSL? → `y` (optional)
- Email → `your@email.com`

**Result:**
```
✅ Node Type: Community
✅ Validation: Via API (no MongoDB needed)
✅ IPFS Gateway: https://your-domain.com
✅ Dashboard: http://SERVER_IP:3100
✅ Monitoring: Reports to 3speak
```

---

### 🏠 Community Hot Node (IP-only)

**When prompted:**
- Node type → `community`
- Validation server → `https://admin-hotipfs-1.3speak.tv` (or press ENTER for default)
- Configure domain? → `n`

**Result:**
```
✅ Node Type: Community
✅ Validation: Via API (no MongoDB needed)
✅ IPFS Gateway: http://SERVER_IP:8080
✅ Dashboard: http://SERVER_IP:3100
✅ No domain/SSL required
✅ Monitoring: Reports to 3speak
```

---

## Post-Install

### 1. Configure
```bash
sudo nano /opt/ipfs-hotnode/.env
```

Set:
- `ADMIN_PASSWORD`
- `SUPERNODE_API`

### 2. Start
```bash
sudo systemctl start ipfs-hotnode
```

### 3. Check
```bash
sudo systemctl status ipfs-hotnode
sudo journalctl -u ipfs-hotnode -f
```

---

## Access Points

| Service | Domain Mode | IP Mode |
|---------|-------------|---------|
| **IPFS Gateway** | https://your-domain.com | http://ip:8080 |
| **Dashboard** | http://ip:3100 | http://ip:3100 |
| **API** | localhost:5001 | localhost:5001 |

---

## Common Commands

```bash
# Service management
sudo systemctl start ipfs-hotnode
sudo systemctl stop ipfs-hotnode
sudo systemctl restart ipfs-hotnode
sudo systemctl status ipfs-hotnode

# View logs
sudo journalctl -u ipfs-hotnode -f
sudo journalctl -u ipfs -f

# Check IPFS
ipfs version
ipfs id

# Test SSL renewal (if enabled)
sudo certbot renew --dry-run
```

---

## Firewall Ports

### Domain Mode
- 22 (SSH)
- 80 (HTTP)
- 443 (HTTPS)
- 3100 (Dashboard)
- 4001 (IPFS Swarm)

### IP Mode
- 22 (SSH)
- 3100 (Dashboard)
- 4001 (IPFS Swarm)
- 8080 (IPFS Gateway)

---

## Troubleshooting

```bash
# Check nginx config
sudo nginx -t

# Restart nginx
sudo systemctl restart nginx

# Check IPFS API
curl http://127.0.0.1:5001/api/v0/version

# Check SSL certs
sudo certbot certificates

# View IPFS config
ipfs config show
```

---

## Quick Links

- **Full Guide:** [INSTALL-GUIDE.md](INSTALL-GUIDE.md)
- **Changes:** [internal-docs/2026-02-02-install-script-improvements.md](internal-docs/2026-02-02-install-script-improvements.md)
- **Issues:** https://github.com/3speak/ipfs-hotnode/issues
