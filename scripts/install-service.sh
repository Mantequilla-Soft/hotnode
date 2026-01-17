#!/bin/bash
#
# IPFS Hot Node Service Installation Script
# 
# This script installs the IPFS Hot Node as a systemd service
# that will automatically start on boot and restart on failure.
#
# Usage: sudo ./install-service.sh
#

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
SERVICE_NAME="ipfs-hotnode"
INSTALL_DIR="/opt/ipfs-hotnode"
SERVICE_USER="ipfs"
SERVICE_GROUP="ipfs"

# Get current directory (where the script is run from)
CURRENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

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

log_step() {
    echo -e "${BLUE}[STEP]${NC} $1"
}

check_root() {
    if [ "$EUID" -ne 0 ]; then
        log_error "Please run as root (use sudo)"
        exit 1
    fi
}

check_node() {
    if ! command -v node &> /dev/null; then
        log_error "Node.js is not installed. Please install Node.js first."
        exit 1
    fi
    log_info "Node.js version: $(node --version)"
}

create_user() {
    if id "$SERVICE_USER" &>/dev/null; then
        log_info "User $SERVICE_USER already exists"
    else
        log_step "Creating service user: $SERVICE_USER"
        useradd --system --no-create-home --shell /bin/false "$SERVICE_USER"
        log_info "User $SERVICE_USER created"
    fi
}

install_application() {
    log_step "Installing application to $INSTALL_DIR"
    
    # Create install directory
    mkdir -p "$INSTALL_DIR"
    
    # Copy application files
    log_info "Copying application files..."
    cp -r "$CURRENT_DIR"/* "$INSTALL_DIR/"
    
    # Create necessary directories
    mkdir -p "$INSTALL_DIR/database"
    mkdir -p "$INSTALL_DIR/logs"
    
    # Install dependencies
    log_info "Installing npm dependencies..."
    cd "$INSTALL_DIR"
    npm install --production --silent
    
    # Copy .env if it exists, otherwise copy example
    if [ -f "$CURRENT_DIR/.env" ]; then
        log_info "Copying .env file..."
        cp "$CURRENT_DIR/.env" "$INSTALL_DIR/.env"
    else
        log_warn ".env file not found. Creating from example..."
        cp "$INSTALL_DIR/.env.example" "$INSTALL_DIR/.env"
        log_warn "Please edit $INSTALL_DIR/.env before starting the service!"
    fi
    
    # Initialize database
    log_info "Initializing database..."
    npm run init-db
    
    # Set ownership
    log_info "Setting ownership to $SERVICE_USER:$SERVICE_GROUP"
    chown -R "$SERVICE_USER:$SERVICE_GROUP" "$INSTALL_DIR"
    
    # Set permissions
    chmod 755 "$INSTALL_DIR"
    chmod 644 "$INSTALL_DIR/.env"
    chmod 755 "$INSTALL_DIR/database"
    chmod 755 "$INSTALL_DIR/logs"
    
    log_info "Application installed successfully"
}

install_systemd_service() {
    log_step "Installing systemd service"
    
    # Create service file
    cat > /etc/systemd/system/${SERVICE_NAME}.service <<EOF
[Unit]
Description=IPFS Hot Node Service
Documentation=https://github.com/3speak/ipfs-hotnode
After=network.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_GROUP}
WorkingDirectory=${INSTALL_DIR}
ExecStart=/usr/bin/node ${INSTALL_DIR}/app.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${SERVICE_NAME}

# Environment
Environment=NODE_ENV=production
Environment=NODE_OPTIONS=--max-old-space-size=2048

# Security
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${INSTALL_DIR}/database ${INSTALL_DIR}/logs
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true

# Limits
LimitNOFILE=65536
LimitNPROC=4096

[Install]
WantedBy=multi-user.target
EOF
    
    log_info "Service file created: /etc/systemd/system/${SERVICE_NAME}.service"
    
    # Reload systemd
    log_info "Reloading systemd daemon..."
    systemctl daemon-reload
    
    # Enable service
    log_info "Enabling service to start on boot..."
    systemctl enable ${SERVICE_NAME}
    
    log_info "Systemd service installed successfully"
}

print_usage() {
    echo ""
    echo -e "${GREEN}========================================${NC}"
    echo -e "${GREEN}  Installation Complete!${NC}"
    echo -e "${GREEN}========================================${NC}"
    echo ""
    echo -e "Service installed as: ${BLUE}${SERVICE_NAME}${NC}"
    echo -e "Installation directory: ${BLUE}${INSTALL_DIR}${NC}"
    echo ""
    echo -e "${YELLOW}Important: Edit the configuration file before starting:${NC}"
    echo -e "  sudo nano ${INSTALL_DIR}/.env"
    echo ""
    echo -e "${GREEN}Common commands:${NC}"
    echo -e "  Start service:    ${BLUE}sudo systemctl start ${SERVICE_NAME}${NC}"
    echo -e "  Stop service:     ${BLUE}sudo systemctl stop ${SERVICE_NAME}${NC}"
    echo -e "  Restart service:  ${BLUE}sudo systemctl restart ${SERVICE_NAME}${NC}"
    echo -e "  Service status:   ${BLUE}sudo systemctl status ${SERVICE_NAME}${NC}"
    echo -e "  View logs:        ${BLUE}sudo journalctl -u ${SERVICE_NAME} -f${NC}"
    echo -e "  Disable service:  ${BLUE}sudo systemctl disable ${SERVICE_NAME}${NC}"
    echo ""
    echo -e "Application logs: ${BLUE}${INSTALL_DIR}/logs/hotnode.log${NC}"
    echo -e "Database: ${BLUE}${INSTALL_DIR}/database/hotnode.db${NC}"
    echo ""
}

uninstall() {
    log_warn "Uninstalling ${SERVICE_NAME}..."
    
    # Stop and disable service
    if systemctl is-active --quiet ${SERVICE_NAME}; then
        log_info "Stopping service..."
        systemctl stop ${SERVICE_NAME}
    fi
    
    if systemctl is-enabled --quiet ${SERVICE_NAME}; then
        log_info "Disabling service..."
        systemctl disable ${SERVICE_NAME}
    fi
    
    # Remove service file
    if [ -f "/etc/systemd/system/${SERVICE_NAME}.service" ]; then
        log_info "Removing service file..."
        rm /etc/systemd/system/${SERVICE_NAME}.service
        systemctl daemon-reload
    fi
    
    # Remove installation directory
    if [ -d "$INSTALL_DIR" ]; then
        log_warn "Removing installation directory: $INSTALL_DIR"
        rm -rf "$INSTALL_DIR"
    fi
    
    log_info "Uninstallation complete"
    exit 0
}

# Main script
main() {
    echo -e "${GREEN}========================================${NC}"
    echo -e "${GREEN}  IPFS Hot Node Service Installer${NC}"
    echo -e "${GREEN}========================================${NC}"
    echo ""
    
    # Check for uninstall flag
    if [ "$1" == "--uninstall" ] || [ "$1" == "-u" ]; then
        check_root
        uninstall
    fi
    
    # Pre-flight checks
    check_root
    check_node
    
    # Installation steps
    create_user
    install_application
    install_systemd_service
    
    # Show usage
    print_usage
}

# Run main function
main "$@"
