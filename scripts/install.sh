#!/bin/bash
#
# IPFS Hot Node Installation Script
# 
# This script installs and configures the IPFS Hot Node service
# on a fresh Ubuntu/Debian system.
#
# Usage: sudo bash install.sh
#

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
INSTALL_DIR="/opt/ipfs-hotnode"
IPFS_USER="ipfs"
IPFS_GROUP="ipfs"
IPFS_VERSION="v0.30.0"
NODE_VERSION="20"

# Helper functions
log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

check_root() {
    if [ "$EUID" -ne 0 ]; then
        log_error "Please run as root (use sudo)"
        exit 1
    fi
}

check_os() {
    if [ ! -f /etc/os-release ]; then
        log_error "Cannot detect OS. This script requires Ubuntu/Debian."
        exit 1
    fi
    
    . /etc/os-release
    if [[ ! "$ID" =~ ^(ubuntu|debian)$ ]]; then
        log_error "This script requires Ubuntu or Debian"
        exit 1
    fi
    
    log_info "Detected OS: $PRETTY_NAME"
}

install_dependencies() {
    log_info "Updating package lists..."
    apt-get update -qq
    
    log_info "Installing system dependencies..."
    apt-get install -y -qq \
        curl \
        wget \
        git \
        build-essential \
        sqlite3 \
        nginx \
        ufw \
        jq
}

install_nodejs() {
    log_info "Installing Node.js v${NODE_VERSION}..."
    
    # Check if Node.js is already installed
    if command -v node &> /dev/null; then
        NODE_INSTALLED_VERSION=$(node --version | cut -d'v' -f2 | cut -d'.' -f1)
        if [ "$NODE_INSTALLED_VERSION" -ge "$NODE_VERSION" ]; then
            log_info "Node.js v$NODE_INSTALLED_VERSION already installed"
            return
        fi
    fi
    
    # Install from NodeSource
    curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash -
    apt-get install -y -qq nodejs
    
    log_info "Node.js version: $(node --version)"
    log_info "npm version: $(npm --version)"
}

create_user() {
    if id "$IPFS_USER" &>/dev/null; then
        log_info "User $IPFS_USER already exists"
    else
        log_info "Creating user $IPFS_USER..."
        useradd -r -s /bin/bash -d /home/$IPFS_USER -m $IPFS_USER
    fi
}

install_ipfs() {
    log_info "Installing Kubo IPFS ${IPFS_VERSION}..."
    
    # Check if IPFS is already installed
    if command -v ipfs &> /dev/null; then
        log_info "IPFS already installed: $(ipfs --version)"
        return
    fi
    
    # Download and install
    cd /tmp
    wget -q "https://dist.ipfs.tech/kubo/${IPFS_VERSION}/kubo_${IPFS_VERSION}_linux-amd64.tar.gz"
    tar -xzf "kubo_${IPFS_VERSION}_linux-amd64.tar.gz"
    cd kubo
    bash install.sh
    cd /tmp
    rm -rf kubo kubo_*.tar.gz
    
    log_info "IPFS installed: $(ipfs --version)"
}

configure_ipfs() {
    log_info "Configuring IPFS..."
    
    # Initialize IPFS repo as IPFS user
    if [ ! -d "/home/$IPFS_USER/.ipfs" ]; then
        su - $IPFS_USER -c "ipfs init"
    else
        log_info "IPFS repo already initialized"
    fi
    
    # Configure IPFS settings
    su - $IPFS_USER -c "ipfs config Addresses.API /ip4/127.0.0.1/tcp/5001"
    su - $IPFS_USER -c "ipfs config Addresses.Gateway /ip4/127.0.0.1/tcp/8080"
    su - $IPFS_USER -c "ipfs config --json Datastore.StorageMax '\"500GB\"'"
    
    log_info "IPFS configured"
}

install_ipfs_service() {
    log_info "Installing IPFS systemd service..."
    
    cat > /etc/systemd/system/ipfs.service <<EOF
[Unit]
Description=IPFS Daemon
After=network.target

[Service]
Type=simple
User=$IPFS_USER
Group=$IPFS_GROUP
ExecStart=/usr/local/bin/ipfs daemon
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF
    
    systemctl daemon-reload
    systemctl enable ipfs
    systemctl start ipfs
    
    log_info "IPFS service installed and started"
}

configure_nginx() {
    log_info "Configuring nginx..."
    
    # Copy nginx configuration
    cp "$INSTALL_DIR/config/nginx-ipfs-hotnode.conf" /etc/nginx/sites-available/ipfs-hotnode
    
    # Enable site
    ln -sf /etc/nginx/sites-available/ipfs-hotnode /etc/nginx/sites-enabled/
    
    # Test configuration
    nginx -t
    
    # Restart nginx
    systemctl restart nginx
    
    log_info "nginx configured and restarted"
}

install_hotnode_service() {
    log_info "Installing Hot Node service..."
    
    # Create installation directory
    mkdir -p "$INSTALL_DIR"
    
    # Copy files (assumes script is run from project directory)
    if [ -f "package.json" ]; then
        cp -r . "$INSTALL_DIR/"
    else
        log_error "package.json not found. Run this script from the project root."
        exit 1
    fi
    
    # Set ownership
    chown -R $IPFS_USER:$IPFS_GROUP "$INSTALL_DIR"
    
    # Install npm dependencies
    log_info "Installing Node.js dependencies..."
    cd "$INSTALL_DIR"
    su - $IPFS_USER -c "cd $INSTALL_DIR && npm install --production"
    
    # Copy example .env if .env doesn't exist
    if [ ! -f "$INSTALL_DIR/.env" ]; then
        log_info "Creating environment file..."
        cp "$INSTALL_DIR/.env.example" "$INSTALL_DIR/.env"
        chown $IPFS_USER:$IPFS_GROUP "$INSTALL_DIR/.env"
        chmod 600 "$INSTALL_DIR/.env"
        log_warn "Please edit $INSTALL_DIR/.env with your settings"
    fi
    
    # Initialize database
    log_info "Initializing database..."
    su - $IPFS_USER -c "cd $INSTALL_DIR && npm run init-db"
    
    # Install systemd service
    cp "$INSTALL_DIR/config/ipfs-hotnode.service" /etc/systemd/system/
    
    systemctl daemon-reload
    systemctl enable ipfs-hotnode
    systemctl start ipfs-hotnode
    
    log_info "Hot Node service installed and started"
}

configure_firewall() {
    log_info "Configuring firewall..."
    
    # Enable UFW if not already enabled
    if ! ufw status | grep -q "Status: active"; then
        ufw --force enable
    fi
    
    # Allow SSH
    ufw allow 22/tcp comment 'SSH'
    
    # Allow IPFS
    ufw allow 4001/tcp comment 'IPFS Swarm'
    
    # Allow IPFS API (localhost only via nginx)
    # ufw allow from 127.0.0.1 to any port 5001
    
    # Allow Hot Node Dashboard (adjust as needed)
    ufw allow 3100/tcp comment 'Hot Node Dashboard'
    
    log_info "Firewall configured"
}

print_summary() {
    local IPFS_ID=$(su - $IPFS_USER -c "ipfs id -f '<id>'")
    
    echo ""
    echo "═══════════════════════════════════════════════════════════"
    log_info "Installation complete!"
    echo "═══════════════════════════════════════════════════════════"
    echo ""
    echo "  IPFS Node ID: $IPFS_ID"
    echo "  IPFS API: http://localhost:5001"
    echo "  IPFS Gateway: http://localhost:8080"
    echo "  Hot Node Dashboard: http://$(hostname -I | awk '{print $1}'):3100"
    echo ""
    echo "  Configuration: $INSTALL_DIR/.env"
    echo "  Logs: journalctl -u ipfs-hotnode -f"
    echo ""
    echo "═══════════════════════════════════════════════════════════"
    log_warn "Next steps:"
    echo "  1. Edit $INSTALL_DIR/.env with your settings"
    echo "  2. Set ADMIN_PASSWORD and SUPERNODE_API"
    echo "  3. Add MONGODB_URI for video validation (optional)"
    echo "  4. Add DISCORD_WEBHOOK_URL for notifications (optional)"
    echo "  5. Restart service: systemctl restart ipfs-hotnode"
    echo "═══════════════════════════════════════════════════════════"
    echo ""
}

main() {
    log_info "Starting IPFS Hot Node installation..."
    echo ""
    
    check_root
    check_os
    install_dependencies
    install_nodejs
    create_user
    install_ipfs
    configure_ipfs
    install_ipfs_service
    
    # Wait for IPFS to start
    log_info "Waiting for IPFS to start..."
    sleep 5
    
    configure_nginx
    install_hotnode_service
    configure_firewall
    
    print_summary
}

# Run main function
main
