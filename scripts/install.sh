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

# Domain configuration (will be set during installation)
USE_DOMAIN=""
DOMAIN_NAME=""
USE_SSL=""
ADMIN_EMAIL=""

# Node type configuration
NODE_TYPE=""
VALIDATION_SERVER=""
MONGODB_URI=""
MONGODB_DATABASE=""

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

prompt_domain_config() {
    echo ""
    log_info "Domain Configuration"
    echo "════════════════════════════════════════════════════════════"
    echo "Do you want to configure a domain for this hot node?"
    echo ""
    echo "  YES - For production deployments with public domain names"
    echo "        (e.g., hotipfs-1.3speak.tv)"
    echo "        Nginx will proxy IPFS gateway on ports 80/443"
    echo ""
    echo "  NO  - For private networks or IP-only deployments"
    echo "        IPFS gateway will be accessible on port 8080"
    echo "        Dashboard will be on port 3100"
    echo ""
    read -p "Configure domain? (y/n): " -n 1 -r
    echo
    
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        USE_DOMAIN="yes"
        
        # Get domain name
        while [ -z "$DOMAIN_NAME" ]; do
            read -p "Enter domain name (e.g., hotipfs-1.3speak.tv): " DOMAIN_NAME
            if [ -z "$DOMAIN_NAME" ]; then
                log_error "Domain name cannot be empty"
            fi
        done
        
        log_info "Domain: $DOMAIN_NAME"
        
        # Ask about SSL
        echo ""
        read -p "Install SSL certificate with Let's Encrypt? (y/n): " -n 1 -r
        echo
        
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            USE_SSL="yes"
            
            # Get email for Let's Encrypt
            while [ -z "$ADMIN_EMAIL" ]; do
                read -p "Enter email for Let's Encrypt notifications: " ADMIN_EMAIL
                if [ -z "$ADMIN_EMAIL" ]; then
                    log_error "Email cannot be empty"
                fi
            done
            
            log_info "SSL will be configured with Let's Encrypt"
        else
            USE_SSL="no"
            log_info "SSL will not be configured (HTTP only)"
        fi
    else
        USE_DOMAIN="no"
        log_info "Domain configuration skipped. IPFS gateway will be on port 8080"
    fi
    
    echo "════════════════════════════════════════════════════════════"
    echo ""
}

prompt_node_type() {
    echo ""
    log_info "Node Type Configuration"
    echo "════════════════════════════════════════════════════════════"
    echo "What type of node is this?"
    echo ""
    echo "  INFRASTRUCTURE - 3speak managed server"
    echo "    • Has MongoDB access for video validation"
    echo "    • Exposes validation API for community nodes"
    echo "    • Full monitoring and control"
    echo ""
    echo "  COMMUNITY - Third-party operator node"
    echo "    • No MongoDB access needed"
    echo "    • Uses 3speak validation API"
    echo "    • Reports health to 3speak monitoring"
    echo ""
    read -p "Node type (infrastructure/community): " NODE_TYPE
    
    # Convert to lowercase
    NODE_TYPE=$(echo "$NODE_TYPE" | tr '[:upper:]' '[:lower:]')
    
    # Validate input
    while [[ ! "$NODE_TYPE" =~ ^(infrastructure|community)$ ]]; do
        log_error "Please enter 'infrastructure' or 'community'"
        read -p "Node type (infrastructure/community): " NODE_TYPE
        NODE_TYPE=$(echo "$NODE_TYPE" | tr '[:upper:]' '[:lower:]')
    done
    
    log_info "Node type: $NODE_TYPE"
    
    if [ "$NODE_TYPE" = "infrastructure" ]; then
        echo ""
        log_info "Infrastructure Node - MongoDB Configuration"
        echo "────────────────────────────────────────────────────────────"
        
        # Get MongoDB URI
        while [ -z "$MONGODB_URI" ]; do
            read -p "MongoDB URI: " MONGODB_URI
            if [ -z "$MONGODB_URI" ]; then
                log_error "MongoDB URI cannot be empty for infrastructure nodes"
            fi
        done
        
        # Get MongoDB database name
        read -p "MongoDB Database [threespeak]: " MONGODB_DATABASE
        MONGODB_DATABASE=${MONGODB_DATABASE:-threespeak}
        
        log_info "MongoDB configured"
    else
        echo ""
        log_info "Community Node - Validation Server Configuration"
        echo "────────────────────────────────────────────────────────────"
        
        # Get validation server URL
        read -p "Validation Server URL [https://admin-hotipfs-1.3speak.tv]: " VALIDATION_SERVER
        VALIDATION_SERVER=${VALIDATION_SERVER:-https://admin-hotipfs-1.3speak.tv}
        
        log_info "Validation server: $VALIDATION_SERVER"
    fi
    
    echo "════════════════════════════════════════════════════════════"
    echo ""
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
        jq \
        certbot \
        python3-certbot-nginx
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
        INSTALLED_VERSION=$(ipfs --version | grep -oP 'version \K[0-9.]+' || echo "unknown")
        REQUIRED_VERSION=$(echo "${IPFS_VERSION}" | sed 's/^v//')
        
        if [ "$INSTALLED_VERSION" = "$REQUIRED_VERSION" ]; then
            log_info "IPFS ${INSTALLED_VERSION} already installed (matches required version)"
            return
        else
            log_warn "IPFS ${INSTALLED_VERSION} is installed, but ${REQUIRED_VERSION} is required"
            read -p "Do you want to upgrade/reinstall IPFS? (y/n): " -n 1 -r
            echo
            if [[ ! $REPLY =~ ^[Yy]$ ]]; then
                log_warn "Continuing with existing IPFS version. This may cause compatibility issues."
                return
            fi
            log_info "Upgrading IPFS to ${IPFS_VERSION}..."
        fi
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

generate_nginx_config() {
    log_info "Generating nginx configuration..."
    
    local CONFIG_FILE="/etc/nginx/sites-available/ipfs-hotnode"
    
    # Create base configuration
    cat > "$CONFIG_FILE" <<'EOF'
# IPFS Hot Node - nginx Configuration
# Generated by install script

# Custom log format for IPFS gateway requests
log_format ipfs_gateway '$remote_addr - [$time_local] "$request" '
                        '$status $body_bytes_sent "$http_user_agent" '
                        '$request_time';

# Rate limit zone (protects gateway abuse)
limit_req_zone $binary_remote_addr zone=ipfs:20m rate=30r/s;

EOF

    if [ "$USE_DOMAIN" = "yes" ]; then
        # Domain-based configuration
        if [ "$USE_SSL" = "yes" ]; then
            # HTTPS configuration (SSL will be added by certbot)
            cat >> "$CONFIG_FILE" <<EOF
# ============================================================================
# IPFS Gateway (Public Content Delivery)
# Domain: ${DOMAIN_NAME}
# ============================================================================

server {
    listen 80;
    server_name ${DOMAIN_NAME};
    
    # Temporary location for Let's Encrypt verification
    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }
    
    # Redirect all other traffic to HTTPS (will be configured after SSL setup)
    location / {
        return 301 https://\$host\$request_uri;
    }
}

# HTTPS server block (certbot will add SSL certificates)
server {
    listen 443 ssl http2;
    server_name ${DOMAIN_NAME};

    # SSL certificates will be added by certbot
    # ssl_certificate /etc/letsencrypt/live/${DOMAIN_NAME}/fullchain.pem;
    # ssl_certificate_key /etc/letsencrypt/live/${DOMAIN_NAME}/privkey.pem;

    # Access logging for bandwidth tracking
    access_log /var/log/nginx/ipfs-gateway.log ipfs_gateway;
    error_log /var/log/nginx/ipfs-gateway-error.log;

    # BIG uploads (encoders)
    client_max_body_size 100G;

    # Timeouts for large media
    proxy_connect_timeout 60s;
    proxy_send_timeout 900s;
    proxy_read_timeout 900s;
    send_timeout 900s;

    location / {
        limit_req zone=ipfs burst=200 nodelay;

        proxy_pass http://127.0.0.1:8080;

        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;

        # Critical for streaming video
        proxy_buffering off;
        proxy_request_buffering off;

        # Prevent temp file disk abuse
        proxy_max_temp_file_size 0;
    }
}
EOF
        else
            # HTTP only configuration
            cat >> "$CONFIG_FILE" <<EOF
# ============================================================================
# IPFS Gateway (Public Content Delivery)
# Domain: ${DOMAIN_NAME} (HTTP only)
# ============================================================================

server {
    listen 80;
    server_name ${DOMAIN_NAME};

    # Access logging for bandwidth tracking
    access_log /var/log/nginx/ipfs-gateway.log ipfs_gateway;
    error_log /var/log/nginx/ipfs-gateway-error.log;

    # BIG uploads (encoders)
    client_max_body_size 100G;

    # Timeouts for large media
    proxy_connect_timeout 60s;
    proxy_send_timeout 900s;
    proxy_read_timeout 900s;
    send_timeout 900s;

    location / {
        limit_req zone=ipfs burst=200 nodelay;

        proxy_pass http://127.0.0.1:8080;

        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;

        # Critical for streaming video
        proxy_buffering off;
        proxy_request_buffering off;

        # Prevent temp file disk abuse
        proxy_max_temp_file_size 0;
    }
}
EOF
        fi
    else
        # IP-only configuration (minimal proxy, mainly for logging)
        cat >> "$CONFIG_FILE" <<EOF
# ============================================================================
# IPFS Gateway (IP-only deployment)
# No domain configured - IPFS gateway is also directly accessible on port 8080
# This nginx proxy is optional and mainly used for logging/rate limiting
# ============================================================================

server {
    listen 8090;
    server_name _;

    # Access logging for bandwidth tracking
    access_log /var/log/nginx/ipfs-gateway.log ipfs_gateway;
    error_log /var/log/nginx/ipfs-gateway-error.log;

    # BIG uploads (encoders)
    client_max_body_size 100G;

    # Timeouts for large media
    proxy_connect_timeout 60s;
    proxy_send_timeout 900s;
    proxy_read_timeout 900s;
    send_timeout 900s;

    location / {
        limit_req zone=ipfs burst=200 nodelay;

        proxy_pass http://127.0.0.1:8080;

        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;

        # Critical for streaming video
        proxy_buffering off;
        proxy_request_buffering off;

        # Prevent temp file disk abuse
        proxy_max_temp_file_size 0;
    }
}
EOF
    fi
    
    # Dashboard configuration (always included)
    cat >> "$CONFIG_FILE" <<'EOF'

# ============================================================================
# Hot Node Dashboard (Admin Interface)
# Port 3100 - Internal admin panel
# ============================================================================
server {
    listen 3100;
    server_name _;
    
    access_log /var/log/nginx/hotnode-admin.log combined;
    error_log /var/log/nginx/hotnode-admin-error.log;
    
    location / {
        proxy_pass http://127.0.0.1:3101;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_cache_bypass $http_upgrade;
    }
}
EOF

    log_info "Nginx configuration generated: $CONFIG_FILE"
}

configure_nginx() {
    log_info "Configuring nginx..."
    
    # Generate nginx configuration
    generate_nginx_config
    
    # Enable site
    ln -sf /etc/nginx/sites-available/ipfs-hotnode /etc/nginx/sites-enabled/
    
    # Remove default site if it exists
    if [ -f /etc/nginx/sites-enabled/default ]; then
        rm /etc/nginx/sites-enabled/default
    fi
    
    # Test configuration
    nginx -t
    
    # Restart nginx
    systemctl restart nginx
    
    log_info "nginx configured and restarted"
}

setup_ssl() {
    if [ "$USE_SSL" != "yes" ]; then
        return
    fi
    
    log_info "Setting up SSL certificate with Let's Encrypt..."
    
    # Make sure domain resolves
    log_warn "Make sure ${DOMAIN_NAME} points to this server's IP before continuing"
    read -p "Press ENTER to continue with SSL setup (Ctrl+C to cancel)..."
    
    # Request certificate
    certbot --nginx \
        -d "${DOMAIN_NAME}" \
        --email "${ADMIN_EMAIL}" \
        --agree-tos \
        --no-eff-email \
        --redirect \
        --non-interactive
    
    if [ $? -eq 0 ]; then
        log_info "SSL certificate installed successfully"
        
        # Test auto-renewal
        certbot renew --dry-run
        
        log_info "SSL auto-renewal configured"
    else
        log_error "Failed to install SSL certificate"
        log_warn "You can retry later with: sudo certbot --nginx -d ${DOMAIN_NAME}"
    fi
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
    
    # Create .env file with configuration
    log_info "Creating environment file..."
    
    cat > "$INSTALL_DIR/.env" <<EOF
# IPFS Hot Node Environment Configuration
# Generated by install script on $(date)

# Admin Authentication
ADMIN_PASSWORD=change_me_after_install
SESSION_SECRET=$(openssl rand -hex 32)

# Hot Node Configuration
HOTNODE_NAME=HotNode-01
HOTNODE_PORT=3101
IPFS_API_URL=http://127.0.0.1:5001
IPFS_GATEWAY_URL=http://127.0.0.1:8080

# Node Type
NODE_TYPE=${NODE_TYPE}

# Supernode Configuration
SUPERNODE_API=http://65.21.201.94:5002
SUPERNODE_TIMEOUT_MS=30000

EOF

    # Add node-type-specific configuration
    if [ "$NODE_TYPE" = "infrastructure" ]; then
        cat >> "$INSTALL_DIR/.env" <<EOF
# MongoDB (Traffic Director) - Infrastructure Node Only
MONGODB_URI=${MONGODB_URI}
MONGODB_DATABASE=${MONGODB_DATABASE}
MONGODB_COLLECTION_LEGACY=videos
MONGODB_COLLECTION_NEW=embed-video
MONGODB_TIMEOUT_MS=5000

EOF
    else
        cat >> "$INSTALL_DIR/.env" <<EOF
# Validation Server (for Community Nodes)
VALIDATION_SERVER_URL=${VALIDATION_SERVER}

# MongoDB not needed for community nodes
# MONGODB_URI=
# MONGODB_DATABASE=
# MONGODB_COLLECTION_LEGACY=
# MONGODB_COLLECTION_NEW=
# MONGODB_TIMEOUT_MS=

EOF
    fi

    # Add common configuration
    cat >> "$INSTALL_DIR/.env" <<EOF
# Discord Notifications
# DEFAULT_WEBHOOK_URL: Reports to 3speak monitoring (REQUIRED - contact 3speak for URL)
# DISCORD_WEBHOOK_URL: Your own custom webhook (optional)
DEFAULT_WEBHOOK_URL=
DISCORD_WEBHOOK_URL=

# Nginx Logs
NGINX_LOG_PATH=/var/log/nginx/ipfs-access.log

# Migration Settings
MIGRATION_START_AFTER_DAYS=4
MIGRATION_DELETE_AFTER_DAYS=7
MIGRATION_BATCH_SIZE=10
MIGRATION_CHECK_INTERVAL_HOURS=12
MIGRATION_THROTTLE_DELAY_MS=2000
MIGRATION_MAX_RETRIES=10

# Cleanup Settings
CLEANUP_INVALID_RETENTION_DAYS=2
CLEANUP_GC_SCHEDULE="0 2 * * *"
CLEANUP_GC_TIMEOUT_MINUTES=60

# Stats
STATS_RETENTION_DAYS=90
STATS_AGGREGATION_INTERVAL_MINUTES=60

# Health Monitoring
HEALTH_DISK_WARNING_PERCENT=80
HEALTH_DISK_CRITICAL_PERCENT=90

# Logging
LOG_LEVEL=info
LOG_FILE=logs/hotnode.log
LOG_MAX_SIZE=10m
LOG_MAX_FILES=5

# Environment
NODE_ENV=production
EOF

    chown $IPFS_USER:$IPFS_GROUP "$INSTALL_DIR/.env"
    chmod 600 "$INSTALL_DIR/.env"
    
    log_info "Environment file created with ${NODE_TYPE} node configuration"
    log_warn "IMPORTANT: Change ADMIN_PASSWORD in $INSTALL_DIR/.env before starting!"
    
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
    
    # Allow Hot Node Dashboard
    ufw allow 3100/tcp comment 'Hot Node Dashboard'
    
    # Configure ports based on deployment type
    if [ "$USE_DOMAIN" = "yes" ]; then
        # Domain-based: Allow HTTP/HTTPS
        ufw allow 80/tcp comment 'HTTP'
        ufw allow 443/tcp comment 'HTTPS'
        log_info "Opened ports 80/443 for domain-based access"
    else
        # IP-only: Allow direct IPFS gateway access
        ufw allow 8080/tcp comment 'IPFS Gateway'
        ufw allow 8090/tcp comment 'IPFS Gateway (nginx proxy)'
        log_info "Opened ports 8080/8090 for IP-based access"
    fi
    
    log_info "Firewall configured"
}

print_summary() {
    local IPFS_ID=$(su - $IPFS_USER -c "ipfs id -f '<id>'")
    local SERVER_IP=$(hostname -I | awk '{print $1}')
    
    echo ""
    echo "═══════════════════════════════════════════════════════════"
    log_info "Installation complete!"
    echo "═══════════════════════════════════════════════════════════"
    echo ""
    echo "  IPFS Node ID: $IPFS_ID"
    echo "  IPFS API: http://localhost:5001"
    echo ""
    
    if [ "$USE_DOMAIN" = "yes" ]; then
        echo "  Domain Configuration: ENABLED"
        echo "  Domain: ${DOMAIN_NAME}"
        if [ "$USE_SSL" = "yes" ]; then
            echo "  IPFS Gateway: https://${DOMAIN_NAME}"
            echo "  SSL: Enabled (Let's Encrypt)"
        else
            echo "  IPFS Gateway: http://${DOMAIN_NAME}"
            echo "  SSL: Not configured"
        fi
    else
        echo "  Domain Configuration: DISABLED"
        echo "  IPFS Gateway (Direct): http://${SERVER_IP}:8080"
        echo "  IPFS Gateway (Nginx): http://${SERVER_IP}:8090"
    fi
    
    echo ""
    echo "  Hot Node Dashboard: http://${SERVER_IP}:3100"
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
    
    if [ "$USE_DOMAIN" = "yes" ] && [ "$USE_SSL" = "yes" ]; then
        echo ""
        echo "  SSL Certificate auto-renewal is configured via certbot"
        echo "  Test renewal: certbot renew --dry-run"
    fi
    
    echo "═══════════════════════════════════════════════════════════"
    echo ""
}

main() {
    log_info "Starting IPFS Hot Node installation..."
    echo ""
    
    check_root
    check_os
    
    # Get user configuration
    prompt_node_type
    prompt_domain_config
    
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
    
    # Setup SSL if requested
    setup_ssl
    
    install_hotnode_service
    configure_firewall
    
    print_summary
}

# Run main function
main
