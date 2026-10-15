#!/usr/bin/env bash
#
# ipfs-watchdog — detect and recover a write-wedged kubo daemon.
#
# WHY THIS EXISTS
# ---------------
# kubo 0.27 serialises every blockstore mutation behind one process-wide
# GC lock. When an HTTP client abandons a request that holds that lock
# (repo/gc, block/rm, pin/add, add), kubo keeps the handler running and
# never releases the lock. From that moment:
#
#   * read-only endpoints (id, repo/stat, pin/ls, object/stat) stay FAST
#   * every write (add, pin/rm, block/put, repo/gc) blocks forever
#
# So the daemon looks perfectly healthy to a liveness check while being
# completely unable to ingest or garbage-collect. A process-liveness
# watchdog is useless here -- the process never dies. We have to probe
# the write path specifically.
#
# Only a daemon restart clears the lock.
#
# WHAT THIS DOES
# --------------
# Every run: confirm the daemon answers a read-only call quickly, then
# probe the write path with a tiny block/put. If reads are fine but the
# write path is blocked, that is the wedge signature -> capture a
# goroutine dump (the only artifact that identifies the stuck lock
# holder) and restart ipfs.service.
#
# Requires root (systemctl restart). Talks to kubo DIRECTLY on 5002,
# bypassing the nginx proxy on 5001 so that nginx's own 300s
# proxy_read_timeout cannot colour the result.

set -uo pipefail

# ---------------------------------------------------------------- config
API="${IPFS_WATCHDOG_API:-http://127.0.0.1:5002}"
UNIT="${IPFS_WATCHDOG_UNIT:-ipfs.service}"

READ_TIMEOUT="${IPFS_WATCHDOG_READ_TIMEOUT:-5}"    # read-only probe budget
WRITE_TIMEOUT="${IPFS_WATCHDOG_WRITE_TIMEOUT:-15}" # write probe budget
STRIKES_TO_ACT="${IPFS_WATCHDOG_STRIKES:-2}"       # consecutive wedges before restart

COOLDOWN_SECONDS="${IPFS_WATCHDOG_COOLDOWN:-900}"  # min gap between restarts
MAX_RESTARTS_24H="${IPFS_WATCHDOG_MAX_24H:-4}"     # above this, alert only

STATE_DIR="${IPFS_WATCHDOG_STATE_DIR:-/var/lib/ipfs-watchdog}"
DIAG_DIR="${IPFS_WATCHDOG_DIAG_DIR:-/var/log/ipfs-watchdog}"
ENV_FILE="${IPFS_WATCHDOG_ENV_FILE:-/opt/ipfs-hotnode/.env}"

STRIKE_FILE="$STATE_DIR/strikes"
LAST_RESTART_FILE="$STATE_DIR/last_restart"
HISTORY_FILE="$STATE_DIR/restart_history"

log() { printf '%s ipfs-watchdog: %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"; }

mkdir -p "$STATE_DIR" "$DIAG_DIR" 2>/dev/null

# Fail loudly rather than silently inert: without a writable state dir the
# strike counter can never increment, so a wedge would be detected on every
# run and acted on by none of them.
# Subshell so the shell's own redirection-failure message is suppressed too.
if ! ( : > "$STATE_DIR/.wtest" ) 2>/dev/null; then
    log "FATAL: state dir $STATE_DIR is not writable (run as root, or set IPFS_WATCHDOG_STATE_DIR)"
    exit 1
fi
rm -f "$STATE_DIR/.wtest"

# Discord is best-effort; never let a notification failure change the outcome.
notify() {
    local title="$1" body="$2" colour="${3:-15158332}" hook=""
    [ -r "$ENV_FILE" ] && hook=$(sed -n 's/^[[:space:]]*DISCORD_WEBHOOK_URL=//p' "$ENV_FILE" | tail -1 | tr -d '"'"'"' \r')
    case "$hook" in
        https://*) ;;
        *) return 0 ;;
    esac
    local payload
    payload=$(printf '{"embeds":[{"title":%s,"description":%s,"color":%s}]}' \
        "$(json_str "$title")" "$(json_str "$body")" "$colour")
    curl -sS -m 10 -H 'Content-Type: application/json' -d "$payload" "$hook" >/dev/null 2>&1 || true
}

# Minimal JSON string escaping (no python/jq dependency).
json_str() {
    local s=${1//\\/\\\\}
    s=${s//\"/\\\"}
    s=${s//$'\n'/\\n}
    s=${s//$'\r'/}
    s=${s//$'\t'/\\t}
    printf '"%s"' "$s"
}

# ---------------------------------------------------------------- probes

# Read-only path. Proves the daemon is up and serving, and that a failure
# of the write probe is not simply "daemon is down or still booting".
probe_read() {
    # -s (not -sS): a timeout here is an expected outcome, not noise.
    curl -s -m "$READ_TIMEOUT" -o /dev/null -X POST "$API/api/v0/id" 2>/dev/null
}

# Write path. block/put takes the same GC read lock that `add` and
# `pin/*` take, so it wedges exactly when ingestion wedges -- but it is
# ~5ms and idempotent on a healthy node (fixed payload => fixed CID, and
# pin=false leaves it collectable).
probe_write() {
    local probe="$STATE_DIR/probe.bin"
    [ -f "$probe" ] || printf 'ipfs-watchdog-probe' > "$probe"
    curl -s -m "$WRITE_TIMEOUT" -o /dev/null \
        -X POST -F "data=@$probe" \
        "$API/api/v0/block/put?format=raw&pin=false" 2>/dev/null
}

# ---------------------------------------------------------------- capture

# The goroutine dump is the whole point of capturing before a restart:
# it names the handler still holding the GC lock. Without it the restart
# destroys the only evidence of which endpoint wedged the node.
capture_diagnostics() {
    local stamp="$1" dest="$DIAG_DIR/wedge-$stamp"
    mkdir -p "$dest"
    log "capturing diagnostics to $dest"

    curl -s -m 30 "$API/debug/pprof/goroutine?debug=2" \
        -o "$dest/goroutine-full.txt" 2>/dev/null || true
    curl -s -m 20 "$API/debug/pprof/goroutine?debug=1" \
        -o "$dest/goroutine-summary.txt" 2>/dev/null || true
    # Read-only, so fast even while wedged -- but bounded in case they are not.
    curl -s -m 10 -X POST "$API/api/v0/repo/stat" \
        -o "$dest/repo-stat.json" 2>/dev/null || true
    curl -s -m 10 -X POST "$API/api/v0/swarm/peers" \
        -o "$dest/swarm-peers.json" 2>/dev/null || true

    journalctl -u "$UNIT" -n 400 --no-pager > "$dest/journal.txt" 2>/dev/null || true

    # The nginx API log shows which abandoned request (499) wedged it.
    if [ -r /var/log/nginx/ipfs-access.log ]; then
        grep -E '" (499|504) ' /var/log/nginx/ipfs-access.log 2>/dev/null \
            | tail -200 > "$dest/nginx-abandoned.txt" || true
        tail -500 /var/log/nginx/ipfs-access.log > "$dest/nginx-tail.txt" 2>/dev/null || true
    fi

    systemctl show "$UNIT" -p ActiveEnterTimestamp -p MainPID \
        > "$dest/unit-state.txt" 2>/dev/null || true

    # Name the likely culprit up front so the dump is actionable.
    {
        echo "# Abandoned lock-taking requests in the 90 min before the wedge"
        echo "# (a 499 on repo/gc, block/rm, pin/add or add is the usual trigger)"
        if [ -r /var/log/nginx/ipfs-access.log ]; then
            grep -E '/api/v0/(repo/gc|block/rm|block/put|pin/add|pin/rm|add)' \
                /var/log/nginx/ipfs-access.log 2>/dev/null \
                | grep -E '" 499 ' | tail -40 || echo "(none found)"
        fi
    } > "$dest/likely-trigger.txt" 2>/dev/null || true

    echo "$dest"
}

# ---------------------------------------------------------------- rate limiting

restarts_last_24h() {
    [ -f "$HISTORY_FILE" ] || { echo 0; return; }
    local cutoff=$(( $(date +%s) - 86400 ))
    awk -v c="$cutoff" '$1 >= c' "$HISTORY_FILE" | wc -l | tr -d ' '
}

in_cooldown() {
    [ -f "$LAST_RESTART_FILE" ] || return 1
    local last now
    last=$(cat "$LAST_RESTART_FILE" 2>/dev/null) || return 1
    case "$last" in ''|*[!0-9]*) return 1 ;; esac
    now=$(date +%s)
    [ $(( now - last )) -lt "$COOLDOWN_SECONDS" ]
}

prune_history() {
    [ -f "$HISTORY_FILE" ] || return 0
    local cutoff=$(( $(date +%s) - 604800 ))
    awk -v c="$cutoff" '$1 >= c' "$HISTORY_FILE" > "$HISTORY_FILE.tmp" 2>/dev/null \
        && mv "$HISTORY_FILE.tmp" "$HISTORY_FILE"
}

read_strikes() {
    local n=0
    [ -f "$STRIKE_FILE" ] && n=$(cat "$STRIKE_FILE" 2>/dev/null)
    case "$n" in ''|*[!0-9]*) n=0 ;; esac
    echo "$n"
}

# ---------------------------------------------------------------- main

main() {
    if ! probe_read; then
        # Daemon is down, restarting, or genuinely unresponsive. systemd's
        # own Restart=always owns that case; clear strikes so a reboot does
        # not count toward a wedge.
        log "read probe FAILED (daemon down/booting) -- leaving it to systemd"
        echo 0 > "$STRIKE_FILE"
        exit 0
    fi

    if probe_write; then
        local prev
        prev=$(read_strikes)
        [ "$prev" -gt 0 ] && log "write path recovered (was at $prev strike(s))"
        echo 0 > "$STRIKE_FILE"
        exit 0
    fi

    # Reads fast + writes blocked == the wedge signature.
    local strikes
    strikes=$(( $(read_strikes) + 1 ))
    echo "$strikes" > "$STRIKE_FILE"
    log "WEDGED: reads OK but write path blocked (>${WRITE_TIMEOUT}s) -- strike $strikes/$STRIKES_TO_ACT"

    [ "$strikes" -lt "$STRIKES_TO_ACT" ] && exit 0

    local stamp dest
    stamp=$(date -u '+%Y%m%dT%H%M%SZ')
    dest=$(capture_diagnostics "$stamp")

    prune_history
    local count
    count=$(restarts_last_24h)

    if [ "$count" -ge "$MAX_RESTARTS_24H" ]; then
        log "ALERT ONLY: $count restarts in last 24h (limit $MAX_RESTARTS_24H) -- not restarting"
        notify "IPFS wedged -- restart suppressed" \
"The IPFS write path is blocked (reads fine, writes hang) but the watchdog has already restarted $UNIT $count times in 24h, so it is holding off.

This needs a human: the node is not ingesting and GC cannot run.

Diagnostics: $dest" 15158332
        exit 1
    fi

    if in_cooldown; then
        log "in cooldown (<${COOLDOWN_SECONDS}s since last restart) -- not restarting yet"
        exit 0
    fi

    log "restarting $UNIT to clear the stuck GC lock"
    if systemctl restart "$UNIT"; then
        date +%s > "$LAST_RESTART_FILE"
        printf '%s %s\n' "$(date +%s)" "$stamp" >> "$HISTORY_FILE"
        echo 0 > "$STRIKE_FILE"
        log "restart complete"
        notify "IPFS write path recovered by restart" \
"The IPFS daemon was wedged -- read-only API calls were fast but every write (add / pin / repo gc) was blocked on kubo's GC lock. Ingestion and garbage collection were stopped.

Restarted $UNIT. Restarts in last 24h: $((count + 1)).

A goroutine dump naming the stuck lock holder was saved to:
$dest" 3447003
    else
        log "ERROR: systemctl restart $UNIT failed"
        notify "IPFS wedged -- restart FAILED" \
"The IPFS write path is blocked and 'systemctl restart $UNIT' returned non-zero. Manual intervention needed.

Diagnostics: $dest" 10038562
        exit 1
    fi
}

main "$@"
