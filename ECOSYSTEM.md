# Full setup: the hotnode ecosystem

This is the "read me first" for a fresh hotnode deployment. [DEPLOYMENT.md](DEPLOYMENT.md)
walks through installing the hotnode companion app on its own; this document
explains the three pieces a modern hotnode runs **together** and how they wire up,
so that videos end up on S3 rather than being pushed to the supernode.

The hotnode no longer has to push videos to the supernode before it lets them go.
Instead it asks a second app on the same box — **snapie-migrator** — to copy each
video to S3, and only unpins once the copy is confirmed. That means a working
hotnode now depends on a local IPFS daemon **and** a local migrator, not just on
itself.

## The three pieces

```
            uploads (encoders)                        viewers / SnapieVideoPlayer
                   │                                              ▲
                   ▼                                              │
        ┌────────────────────┐                        ┌───────────────────────┐
        │  Kubo (local IPFS)  │                        │  S3 (Buttercloud)     │
        │  daemon on this VPS │                        │  bucket admin-9eab69  │
        │  gateway :8080      │                        │  served via           │
        │  (trustless CAR)    │                        │  buttercloud.b-cdn.net│
        └─────────┬──────────┘                         │  + s3.3speak.tv       │
                  │ reads CAR by CID                    └───────────▲───────────┘
                  │ (?format=car)                                   │ uploads
                  ▼                                                 │
        ┌────────────────────┐   HTTP service API      ┌───────────┴───────────┐
        │  ipfs-hotnode       │   :3021 (Bearer token)  │  snapie-migrator      │
        │  companion app      │ ──────────────────────► │  page   :3020         │
        │  systemd, :3101     │                         │  service API :3021    │
        │  (pins, retention,  │ ◄────────────────────── │  (same VPS, pm2)      │
        │   S3-copy requests) │   HMAC-signed callback  └───────────────────────┘
        └────────────────────┘   POST :3101/api/s3/callback
```

1. **Kubo** — the hotnode's own IPFS daemon. It holds the hot pins and serves
   them. The migrator reads from it.
2. **ipfs-hotnode** (this repo) — the companion app: tracks pins, runs the
   retention/cleanup schedule, and *requests* S3 copies. It copies nothing
   itself.
3. **snapie-migrator** — the app that actually downloads each video from IPFS,
   verifies it, uploads it to S3, and reports back. It runs as a **second service
   on the same VPS**. Repo and full guide:
   <https://github.com/Mantequilla-Soft/snapie-migrator> (see its `DEPLOYMENT.md`).

S3 here means the **Buttercloud** object store (a Garage backend), bucket
**`admin-9eab69`**, served to viewers through `buttercloud.b-cdn.net` (Bunny CDN
zone) and `s3.3speak.tv`.

### The flow, in words

A video is uploaded and pinned on the local Kubo daemon. When it becomes eligible
(old enough, see the rate settings), the hotnode's migration worker asks the
migrator — over the loopback service API on `:3021`, with a Bearer token — to copy
that CID. The migrator downloads the CAR from the local Kubo gateway
(`http://127.0.0.1:8080`, `?format=car`), verifies every block, uploads the files
to `admin-9eab69/<cid>/…` plus the CAR to `admin-9eab69/car/<cid>.car`, checks the
objects back through the CDN, updates Mongo so the player serves from S3, and then
calls the hotnode back on `POST http://127.0.0.1:3101/api/s3/callback` — HMAC-signed
with a shared secret. The hotnode records the result against the pin. The pin is
not unpinned at this point: the copy only marks it `copied` and the video stays
hot. Later, at the daily cleanup, a *dormant* pin whose S3 copy is confirmed is
unpinned and flipped to `archived`, after which it plays straight from S3.

---

## 1. Kubo (local IPFS daemon)

The migrator reads each video from **this box's own IPFS gateway** — set as
`LOCAL_GATEWAY` in the migrator's `.env` — before trying any remote gateway, so
the copy is a local disk read rather than an internet download.

Requirements:

- A Kubo daemon running on this VPS (the hotnode's existing one is fine; see
  [DEPLOYMENT.md](DEPLOYMENT.md) "Install Kubo IPFS").
- Its gateway reachable at **`http://127.0.0.1:8080`**.
- The gateway must serve **trustless CAR** responses, i.e. `GET /ipfs/<cid>?format=car`
  returns a CAR stream. Recent Kubo does this by default. Quick check:

  ```bash
  curl -sI "http://127.0.0.1:8080/ipfs/<a-CID-this-node-pins>?format=car" | head
  # expect: Content-Type: application/vnd.ipld.car
  ```

The migrator's `check:car` / `smoke:s3` scripts verify this end to end during its
setup.

---

## 2. ipfs-hotnode (this repo)

The companion app. Install and run it as in [DEPLOYMENT.md](DEPLOYMENT.md); this
section only calls out what the ecosystem needs.

- **Node.js** — this app declares `>=20` (`package.json`), but the migrator that
  runs beside it needs **Node ≥22.12**. Provision **Node ≥22.12** on the box so
  one runtime satisfies both.
- **systemd service** `ipfs-hotnode`, running `node app.js`, listening on
  **port 3101** (`HOTNODE_PORT`). The admin dashboard and the `/api/s3/callback`
  endpoint are both on this port.

### Keychain login (required, or nobody can log in)

Logging in is Hive Keychain plus an allow-list. **Both** of these must be set in
`.env` or every login is refused:

```bash
SESSION_SECRET=        # at least 32 characters; e.g. openssl rand -hex 32
ALLOWED_USERS=meno,tibfox   # comma-separated Hive accounts allowed to log in / change settings
```

Leave `SESSION_SECRET` short (or unset) and login fails with
`SESSION_SECRET must be set (at least 32 characters)`. Leave `ALLOWED_USERS`
empty and the app logs `ALLOWED_USERS is empty: nobody can log in`. Everyone not
in the list still gets the read-only pages.

### Migrator-integration keys

These wire the hotnode to the migrator (see §3 for the matching migrator side):

```bash
MIGRATOR_SERVICE_URL=http://127.0.0.1:3021   # the migrator's service API on this box
MIGRATOR_SERVICE_TOKEN=                       # Bearer token; MUST match the migrator's .env
HOTNODE_CALLBACK_SECRET=                       # HMAC secret for callbacks; MUST match the migrator's .env
MIGRATOR_PUBLIC_URL=                           # optional: the migrator's page, linked from the Pins table
# Ingestion cutoff (also tunable at runtime on the Settings page):
HEALTH_CAPACITY_STOP_PERCENT=80                # stop accepting uploads at this repo usage
HEALTH_CAPACITY_RESUME_PERCENT=75              # resume below this
```

`MIGRATOR_SERVICE_TOKEN` and `HOTNODE_CALLBACK_SECRET` are **shared secrets** — the
exact same values must appear in the migrator's `.env`. Generate each once
(`openssl rand -hex 32`) and paste it into both files.

### Database init + the S3 tracking migration

The hotnode keeps its state in a **local SQLite** database
(`database/hotnode.db`), separate from Mongo. Initialise it and then apply the S3
tracking columns:

```bash
npm run init-db                      # creates the current schema
node scripts/migrateAddS3Tracking.js # adds the s3_* columns + s3_events table (schema_version -> 4)
```

`migrateAddS3Tracking.js` is an `ALTER TABLE` on the local SQLite DB — it does not
touch Mongo. After it runs, `config.schema_version` is `4`. (A fresh `init-db` on
current code may already include these; the migration is idempotent and safe to
run either way.)

> Ownership note: the service runs as user `ipfs`, so `database/hotnode.db` must
> be writable by `ipfs`. Run the migration as the user that owns the DB file, and
> do not blind-chown a production DB — check ownership first.

### Where videos go: the `migration_target` setting

A single config value, `migration_target`, decides the destination:

- **`supernode`** (default) — the old behaviour: eligible videos are pinned to the
  supernode's IPFS, then let go.
- **`s3`** — videos are copied to S3 through the migrator (everything in this
  document).

Flip it in the dashboard: **Settings → "Where Videos Go Before Unpinning"**, choose
**"S3, through snapie-migrator"**, and save (route `POST /api/settings/migration-target`,
admin only). The Settings page shows the migrator's reachability and whether the
token is accepted before you switch. Switching is reversible — choose
**Supernode** again at any time; records of S3 copies are kept.

---

## 3. snapie-migrator (required alongside)

The migrator is a **separate app you must deploy on the same VPS** for S3 mode to
work. Follow its own guide —
[snapie-migrator `DEPLOYMENT.md`](https://github.com/Mantequilla-Soft/snapie-migrator/blob/main/DEPLOYMENT.md),
the **Hotnode `.env`** section — for the full install (Node ≥22.12, pm2, its own
`.env`, S3 credentials, nginx). Only the hotnode-facing wiring is repeated here.

On the migrator's side, the hotnode-specific keys are:

```bash
SERVICE_PORT=3021                                       # the hotnode-facing service API (loopback only)
HOTNODE_CALLBACK_URL=http://127.0.0.1:3101/api/s3/callback   # where the migrator reports back
MIGRATOR_SERVICE_TOKEN=                                 # Bearer token; MUST match the hotnode's .env
HOTNODE_CALLBACK_SECRET=                                # HMAC secret; MUST match the hotnode's .env
LOCAL_GATEWAY=http://127.0.0.1:8080                     # this box's Kubo gateway (§1)
```

The two shared values must line up on both ends:

| Value | hotnode `.env` | migrator `.env` |
| --- | --- | --- |
| Service token | `MIGRATOR_SERVICE_TOKEN` | `MIGRATOR_SERVICE_TOKEN` |
| Callback secret | `HOTNODE_CALLBACK_SECRET` | `HOTNODE_CALLBACK_SECRET` |
| Service endpoint | `MIGRATOR_SERVICE_URL=…:3021` | `SERVICE_PORT=3021` |
| Callback endpoint | served at `:3101/api/s3/callback` | `HOTNODE_CALLBACK_URL=…:3101/api/s3/callback` |

The service port `3021` is loopback-only and **must never be proxied** to the
internet — it is the hotnode's private channel. Likewise keep the
`location /api/s3/` block from `config/nginx-ipfs-hotnode.conf.example` so nginx
refuses outside callers to the callback path; only requests made on the box
itself are accepted, and they are HMAC-checked regardless.

Quick check once both are up, from the box:

```bash
# token accepted (returns the CID's state); without the header it is 401
curl -s -H "Authorization: Bearer $MIGRATOR_SERVICE_TOKEN" \
  http://127.0.0.1:3021/api/cids/<a-CID-the-hotnode-pins>
```

---

## 4. The S3 lifecycle

Each pin moves through three S3 states:

```
requested ──► copied ──► archived
```

- **requested** — the hotnode has asked the migrator to copy this CID.
- **copied** — the migrator has uploaded and verified it on S3. **The video is
  still pinned and hot on this node.** Both the manual **Copy to S3** button and
  the paced auto worker only ever get you to `copied`; neither unpins anything.
  `s3_url` points at `https://buttercloud.b-cdn.net/admin-9eab69/<cid>/manifest.m3u8`.
- **archived** — the pin has been **unpinned** and now plays from S3 only. This
  happens **only at the daily cleanup** (`CLEANUP_GC_SCHEDULE`, ~02:00), and
  **only for dormant pins** whose S3 copy is confirmed. Manual Unpin follows the
  same "must be copied first" rule.

So copying and unpinning are deliberately separate: copying to S3 is safe and
reversible and leaves the video hot; the node's disk footprint only drops later,
when dormant content is cleaned up. (`failed` and `rejected` are the error states;
a failed copy is retried on a backoff and, if it keeps failing, raises one Discord
alert and stays on the node.)

### "migrated" and the overdue counter in S3 mode

`migrated` means **"safe off this node"**, and a confirmed S3 **copy** sets it
(`migrated = 1`, at `s3_state = copied` — `workers/s3Worker.js`). So it is
S3-aware, not a supernode-only flag:

- `overdue` counts pins older than 7 days with `migrated = 0`
  (`utils/database.js`). As the backlog is copied to S3 each pin becomes
  `migrated = 1` and leaves the overdue set, so **overdue comes down as content
  moves to S3** — the same as it did under supernode migration.
- `/health`, the stats pages and the overdue-based Discord alerts (degraded over
  ~50 overdue, disk-%-gated) stay meaningful in S3 mode.
- The healing/verify worker reports `stillOverdue` after it catches up with the
  migrator.

**Nuance:** `migrated = 1` is set at **copy** time — it is an accounting flag
meaning "safe in S3", not "disk freed". The pin is still physically **pinned and
hot** until the daily cleanup unpins a *dormant* copied pin and flips it to
`s3_state = archived`. So after a healthy backlog run you can see overdue at or
near zero while disk usage is still high; disk only drops as dormant content is
archived. Watch the **S3 state** (requested / copied / archived / failed) on the
Pins page for copy progress, and the overdue/disk numbers for node load.

---

## Bring-up order (summary)

1. Kubo daemon up, gateway on `:8080` serving trustless CAR (§1).
2. Deploy **snapie-migrator** on the same box per its `DEPLOYMENT.md`; set
   `SERVICE_PORT=3021`, `HOTNODE_CALLBACK_URL=…:3101/api/s3/callback`,
   `LOCAL_GATEWAY=…:8080`, and the shared token/secret.
3. Deploy **ipfs-hotnode** per [DEPLOYMENT.md](DEPLOYMENT.md); set
   `SESSION_SECRET`, `ALLOWED_USERS`, the `MIGRATOR_*`/`HOTNODE_CALLBACK_SECRET`
   keys (matching the migrator), and the capacity thresholds; run `npm run init-db`
   then `node scripts/migrateAddS3Tracking.js`.
4. Log in; **Settings → "Where Videos Go Before Unpinning"** should report the
   migrator reachable and the token accepted. Choose **S3** and save.
5. Prove the loop on one pin: **Copy to S3** → the pin reaches `copied` and
   `s3_url` is set; the video still plays and is still pinned. The auto worker
   then works through eligible pins on its schedule.
