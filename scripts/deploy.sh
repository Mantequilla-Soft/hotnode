#!/bin/bash
#
# IPFS Hot Node - Deploy Script
#
# For ONGOING deploys of an already-installed hotnode (see install-service.sh
# for first-time setup, which this assumes has already been run once: the
# ipfs-hotnode systemd service and the ipfs system user already exist).
#
# Pulls the latest code, installs dependencies, runs pending schema
# migrations, and restarts the service. Meant to be wired into a CI/CD
# pipeline (e.g. a GitHub Actions job that SSHes in and runs this on push to
# main) as well as run by hand.
#
# Usage: sudo ./scripts/deploy.sh [branch]
#   branch defaults to "main"
#
# Exit code is non-zero on any failure, so a CI pipeline can fail the job.

set -e

# Colors (matches install-service.sh)
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

SERVICE_NAME="ipfs-hotnode"
INSTALL_DIR="/opt/ipfs-hotnode"
SERVICE_USER="ipfs"
BRANCH="${1:-main}"

log_info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }
log_step()  { echo -e "${BLUE}[STEP]${NC} $1"; }

check_root() {
    if [ "$EUID" -ne 0 ]; then
        log_error "Please run as root (use sudo) - needs to restart a systemd service"
        exit 1
    fi
}

check_prereqs() {
    if [ ! -d "$INSTALL_DIR/.git" ]; then
        log_error "$INSTALL_DIR is not a git checkout - run install-service.sh first, or clone manually"
        exit 1
    fi
    if ! id "$SERVICE_USER" &>/dev/null; then
        log_error "Service user '$SERVICE_USER' doesn't exist - run install-service.sh first"
        exit 1
    fi
}

# Runs a command as the service user, from the install dir. Keeps
# git/npm-created files owned by ipfs:ipfs instead of root, matching what
# install-service.sh set up (ProtectSystem=strict in the unit means the
# service can only write under ReadWritePaths, but it also needs to be able
# to READ everything deploy.sh touches - simplest to just keep it all owned
# by the same user that runs it).
as_service_user() {
    sudo -u "$SERVICE_USER" -H bash -c "cd '$INSTALL_DIR' && $1"
}

pull_latest() {
    log_step "Fetching latest code (branch: $BRANCH)"
    as_service_user "git fetch origin"

    local before after
    before=$(as_service_user "git rev-parse HEAD")

    as_service_user "git checkout '$BRANCH'"
    as_service_user "git reset --hard 'origin/$BRANCH'"

    after=$(as_service_user "git rev-parse HEAD")

    if [ "$before" == "$after" ]; then
        log_info "Already up to date (${after:0:8})"
    else
        log_info "Updated ${before:0:8} -> ${after:0:8}"
    fi
}

install_dependencies() {
    log_step "Installing dependencies"
    as_service_user "npm ci --production --silent 2>/dev/null || npm install --production --silent"
    log_info "Dependencies installed"
}

run_migrations() {
    log_step "Ensuring schema is current"
    as_service_user "npm run init-db"

    # No formal migration-runner exists yet in this project (see
    # scripts/migrations/*.md - past changes were either new tables via
    # initDatabase.js's CREATE TABLE IF NOT EXISTS, or documented manually).
    # migrateAddServingTracking.js is the first ALTER-TABLE-style migration;
    # it's idempotent (checks PRAGMA table_info before adding each column),
    # so it's safe to just always run it here. As more of these accumulate,
    # this list is the thing to turn into a real migration runner (a
    # migrations/ folder of numbered scripts + a schema_migrations table
    # tracking which ones have run) rather than growing indefinitely.
    local known_migrations=(
        "scripts/migrateAddServingTracking.js"
    )

    for migration in "${known_migrations[@]}"; do
        if [ -f "$INSTALL_DIR/$migration" ]; then
            log_info "Running $migration"
            as_service_user "node $migration"
        fi
    done

    log_info "Schema up to date"
}

restart_service() {
    log_step "Restarting $SERVICE_NAME"
    systemctl restart "$SERVICE_NAME"

    # Give it a moment to come up before checking, rather than racing it.
    sleep 3

    if systemctl is-active --quiet "$SERVICE_NAME"; then
        log_info "$SERVICE_NAME is active"
        return 0
    else
        log_error "$SERVICE_NAME failed to start - check: journalctl -u $SERVICE_NAME -n 50"
        return 1
    fi
}

notify_discord() {
    local status="$1"
    local commit="$2"
    # Best-effort only: reuses the app's own configured webhook (utils/discord.js),
    # so nothing new to configure here. Never fails the deploy over a notify error.
    as_service_user "node -e \"
        require('./utils/discord').getDiscordNotifier().send(
            'Deploy',
            '${status} - ${commit:0:8}',
            '$([ "$status" == "failed" ] && echo error || echo info)'
        ).catch(() => {});
    \"" 2>/dev/null || true
}

main() {
    echo -e "${GREEN}========================================${NC}"
    echo -e "${GREEN}  IPFS Hot Node Deploy${NC}"
    echo -e "${GREEN}========================================${NC}"
    echo ""

    check_root
    check_prereqs

    # Called directly (not via $(...)) so set -e still aborts on a failed
    # git step, and its log output can't leak into the commit SHA.
    pull_latest
    local commit
    commit=$(as_service_user "git rev-parse HEAD")
    install_dependencies
    run_migrations

    if restart_service; then
        notify_discord "deployed" "$commit"
    else
        notify_discord "failed" "$commit"
        exit 1
    fi

    echo ""
    log_info "Deploy complete (${commit:0:8})"
    echo -e "  Logs:   ${BLUE}journalctl -u $SERVICE_NAME -f${NC}"
    echo -e "  Status: ${BLUE}systemctl status $SERVICE_NAME${NC}"
}

main "$@"
