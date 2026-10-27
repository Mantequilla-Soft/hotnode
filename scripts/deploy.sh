#!/bin/bash
#
# IPFS Hot Node - Deploy Script
#
# For ONGOING deploys of an already-installed hotnode (see install-service.sh
# for first-time setup, which this assumes has already been run once: the
# ipfs-hotnode systemd service and the ipfs system user already exist).
#
# Fetches the latest code, installs dependencies if the lockfile changed,
# runs schema migrations, restarts the service, and rolls back to the
# previously deployed commit if any of that fails.
#
# Usage:
#   sudo ./scripts/deploy.sh [branch]          # manual deploy (default: main)
#   sudo hotnode-deploy --auto                 # what hotnode-autodeploy.timer runs
#
# --auto is quiet when there is nothing new, and won't retry a commit that
# already failed to deploy until the branch moves past it (no rollback loop
# every timer tick). A manual run always tries.
#
# Continuous deployment: hotnode-autodeploy.timer runs this every 2 minutes
# and deploys whenever origin/main moves. See DEPLOYMENT.md "Auto-deploy".
#
# SECURITY: this runs as root, but the checkout is owned (and writable) by a
# regular user, so the timer must run a root-owned installed copy, never this
# file in place:
#   sudo install -o root -g root -m 755 \
#       /opt/ipfs-hotnode/scripts/deploy.sh /usr/local/sbin/hotnode-deploy
# A push that changes this script therefore needs that reinstall to take
# effect (a warning is logged when the two differ). For the same reason, root
# never runs git or node here: git/npm run as the checkout owner, and
# migrations/notifications as the service user.
#
# Exit code is non-zero on any failure.

set -euo pipefail
# Without this, a failing command inside $(...) (e.g. git fetch) is ignored.
shopt -s inherit_errexit

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

SERVICE_NAME="ipfs-hotnode"
INSTALL_DIR="${HOTNODE_INSTALL_DIR:-/opt/ipfs-hotnode}"
SERVICE_USER="ipfs"
# Fetched over HTTPS (public repo) so deploys need no SSH key or token, and
# the checkout's own `origin` remote (often SSH, for whoever develops here)
# is left alone.
REPO_URL="${HOTNODE_REPO_URL:-https://github.com/Mantequilla-Soft/hotnode.git}"
STATE_DIR="${HOTNODE_DEPLOY_STATE_DIR:-/var/lib/hotnode-deploy}"
LOCK_FILE="${HOTNODE_DEPLOY_LOCK:-/run/hotnode-deploy.lock}"

AUTO=0
BRANCH="main"
for arg in "$@"; do
    case "$arg" in
        --auto) AUTO=1 ;;
        -*) echo "Unknown option: $arg" >&2; exit 2 ;;
        *) BRANCH="$arg" ;;
    esac
done

# In --auto mode output goes to the journal; skip the colour codes there.
if [ "$AUTO" -eq 1 ]; then RED= GREEN= YELLOW= BLUE= NC=; fi

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
    CHECKOUT_USER=$(stat -c '%U' "$INSTALL_DIR/.git")
    if [ "$CHECKOUT_USER" == "root" ]; then
        log_error "$INSTALL_DIR/.git is owned by root - chown it to a regular user (git must not run as root here)"
        exit 1
    fi
}

as_user() {
    local user="$1"; shift
    sudo -u "$user" -H bash -c "cd '$INSTALL_DIR' && $1"
}
# git / npm write into the checkout -> its owner.
as_checkout_user() { as_user "$CHECKOUT_USER" "$1"; }
# Migrations write the database, notifications read .env -> the service user,
# matching the permissions the running service has.
as_service_user()  { as_user "$SERVICE_USER" "$1"; }

# Last commit that was successfully deployed (i.e. is what the service runs).
# Compared against the target instead of the checkout's HEAD, because HEAD can
# move without a deploy (a manual `git pull` by whoever develops here).
deployed_sha() { cat "$STATE_DIR/deployed_sha" 2>/dev/null || true; }
failed_sha()   { cat "$STATE_DIR/failed_sha" 2>/dev/null || true; }

fetch_target() {
    as_checkout_user "git fetch --quiet '$REPO_URL' '+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH'"
    as_checkout_user "git rev-parse 'refs/remotes/origin/$BRANCH'"
}

# Refuses to deploy over local work rather than destroying it. Only tracked
# files count - ignored runtime files (.env, database/, logs/) are untouched
# by the reset anyway.
check_checkout_clean() {
    local current
    current=$(as_checkout_user "git rev-parse --abbrev-ref HEAD")
    if [ "$current" != "$BRANCH" ]; then
        log_error "Checkout is on branch '$current', not '$BRANCH' - not deploying over it (switch back, or develop in a separate clone)"
        return 1
    fi
    if [ -n "$(as_checkout_user "git status --porcelain --untracked-files=no")" ]; then
        log_error "Checkout has uncommitted changes to tracked files - not deploying over them"
        return 1
    fi
    # The reset below would otherwise discard local commits that were never
    # pushed. (A rolled-back checkout is behind the target, which is fine.)
    if ! as_checkout_user "git merge-base --is-ancestor HEAD '$1'"; then
        log_error "Local '$BRANCH' has commits not in origin/$BRANCH - push or drop them first"
        return 1
    fi
}

checkout_commit() {
    as_checkout_user "git reset --hard --quiet '$1'"
}

lockfile_changed() {
    local from="$1" to="$2"
    [ -z "$from" ] && return 0
    ! as_checkout_user "git cat-file -e '$from^{commit}'" 2>/dev/null && return 0
    ! as_checkout_user "git diff --quiet '$from' '$to' -- package.json package-lock.json"
}

install_dependencies() {
    log_step "Installing dependencies"
    as_checkout_user "npm ci --omit=dev --no-audit --no-fund --loglevel=error" || return 1
    log_info "Dependencies installed"
}

run_migrations() {
    log_step "Ensuring schema is current"

    # No formal migration-runner exists yet in this project (see
    # scripts/migrations/*.md). ALTER-TABLE-style migrations run BEFORE
    # init-db: initDatabase.js's schema also creates indexes on the columns
    # they add, so on an existing database init-db fails until they exist.
    # Each one is idempotent and is a no-op on a fresh install (no tables
    # yet - init-db then creates the full current schema). As more of these
    # accumulate, this list is the thing to turn into a real migration
    # runner (numbered scripts + a schema_migrations table).
    local known_migrations=(
        "scripts/migrateAddServingTracking.js"
    )

    for migration in "${known_migrations[@]}"; do
        if [ -f "$INSTALL_DIR/$migration" ]; then
            log_info "Running $migration"
            as_service_user "node $migration" || return 1
        fi
    done

    as_service_user "npm run --silent init-db" || return 1
    log_info "Schema up to date"
}

restart_service() {
    log_step "Restarting $SERVICE_NAME"
    systemctl restart "$SERVICE_NAME"

    # Give it a moment to come up, then make sure it STAYS up - a crash on
    # startup can still read as "active" for the first second or two.
    sleep 10

    if systemctl is-active --quiet "$SERVICE_NAME"; then
        log_info "$SERVICE_NAME is active"
        return 0
    else
        log_error "$SERVICE_NAME failed to start - check: journalctl -u $SERVICE_NAME -n 50"
        return 1
    fi
}

notify_discord() {
    local color="$1" message="$2"   # color: a utils/discord.js colour name
    # Best-effort only: reuses the app's own configured webhook (utils/discord.js).
    # Never fails the deploy over a notify error.
    as_service_user "node -e \"require('./utils/discord').getDiscordNotifier().send('Deploy', process.argv[1], process.argv[2]).catch(() => {})\" $(printf '%q %q' "$message" "$color")" \
        >/dev/null 2>&1 || true
}

warn_if_installed_copy_stale() {
    local installed=/usr/local/sbin/hotnode-deploy
    if [ -f "$installed" ] && ! cmp -s "$installed" "$INSTALL_DIR/scripts/deploy.sh"; then
        log_warn "scripts/deploy.sh differs from $installed - reinstall it to pick up deploy changes:"
        log_warn "  sudo install -o root -g root -m 755 $INSTALL_DIR/scripts/deploy.sh $installed"
    fi
}

# Puts code (and dependencies, if needed) back to the previous deploy and
# restarts onto it. Schema migrations are additive, so the old code runs fine
# against the newer schema.
rollback() {
    local to="$1" from="$2"
    if [ -z "$to" ]; then
        log_error "No previously deployed commit recorded - can't roll back automatically"
        return 1
    fi
    log_warn "Rolling back to ${to:0:8}"
    checkout_commit "$to" || return 1
    if lockfile_changed "$from" "$to"; then
        install_dependencies || return 1
    fi
    restart_service
}

deploy() {
    local target="$1" previous="$2"

    # Called from `if deploy ...`, where set -e doesn't apply - so every step
    # propagates its own failure explicitly.
    log_step "Deploying ${target:0:8} (previously ${previous:-none})"
    checkout_commit "$target" || return 1

    if lockfile_changed "$previous" "$target"; then
        install_dependencies || return 1
    else
        log_info "package.json/package-lock.json unchanged - skipping npm ci"
    fi

    run_migrations || return 1
    restart_service
}

main() {
    check_root
    check_prereqs
    mkdir -p "$STATE_DIR"

    # One deploy at a time: a manual run and a timer tick must not interleave.
    exec 9>"$LOCK_FILE"
    if ! flock -n 9; then
        [ "$AUTO" -eq 1 ] || log_warn "Another deploy is already running"
        exit 0
    fi

    local target previous
    target=$(fetch_target)
    previous=$(deployed_sha)

    if [ "$target" == "$previous" ]; then
        [ "$AUTO" -eq 1 ] || log_info "Already deployed (${target:0:8})"
        exit 0
    fi
    if [ "$AUTO" -eq 1 ] && [ "$target" == "$(failed_sha)" ]; then
        exit 0
    fi

    if ! check_checkout_clean "$target"; then
        # Not a failure of the commit itself: keep retrying every tick (it
        # deploys as soon as the checkout is clean again), but only notify
        # once per target.
        if [ "$AUTO" -eq 1 ] && [ "$target" != "$(cat "$STATE_DIR/blocked_sha" 2>/dev/null || true)" ]; then
            echo "$target" > "$STATE_DIR/blocked_sha"
            notify_discord orange "auto-deploy of ${target:0:8} is waiting: the checkout at $INSTALL_DIR is not a clean, fast-forwardable '$BRANCH'"
        fi
        exit 1
    fi
    rm -f "$STATE_DIR/blocked_sha"

    if deploy "$target" "$previous"; then
        echo "$target" > "$STATE_DIR/deployed_sha"
        rm -f "$STATE_DIR/failed_sha"
        log_info "Deploy complete (${target:0:8})"
        notify_discord green "deployed ${target:0:8}"
        warn_if_installed_copy_stale
        exit 0
    fi

    log_error "Deploy of ${target:0:8} failed"
    echo "$target" > "$STATE_DIR/failed_sha"
    if rollback "$previous" "$target"; then
        notify_discord red "deploy of ${target:0:8} FAILED - rolled back to ${previous:0:8}"
    else
        notify_discord red "deploy of ${target:0:8} FAILED and rollback failed - service needs attention"
    fi
    exit 1
}

main
