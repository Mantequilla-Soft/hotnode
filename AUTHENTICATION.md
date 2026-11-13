# Authentication Guide

## Overview

Admins log in with **Hive Keychain**. The interface is **view-only by default**:
anyone can look, and only the Hive accounts listed in `ALLOWED_USERS` can change
anything. There is no shared password.

## Setup

Add to `.env`:

```bash
# Hive accounts that may act, comma-separated
ALLOWED_USERS=meno,coolmole
# At least 32 random characters (openssl rand -hex 32); login is refused without it
SESSION_SECRET=...
# Optional: Hive API nodes used to check signatures, tried in order
# HIVE_API_NODES=https://api.hive.blog,https://api.deathwing.me,https://anyx.io
```

Restart the service after changing `ALLOWED_USERS`. `ADMIN_PASSWORD` is no longer
used and can be removed.

## How login works

1. **🔒 Login**, type your Hive account, **Log in**.
2. The node gives your browser a one-time message (valid 5 minutes) that names this
   node and your account.
3. Keychain asks you to sign it with your **posting key**. Nothing is broadcast.
4. The node recovers the public key from the signature and checks on chain that it
   is one of the account's posting keys, strong enough to sign alone.
5. You get a session for 24 hours. Every write checks that your account is still
   in `ALLOWED_USERS`.

Logged in with an account that isn't listed, the pages stay read-only and say so.

Details:
- the session cookie is httpOnly and `SameSite=Strict`, and a new session id is
  issued at login;
- each message can be used once;
- login attempts are rate-limited per IP (40 every 15 minutes).

## Security Notes

- Sessions are stored in-memory (restart clears all sessions)
- For production, consider using Redis or MongoDB for session storage
- Always use HTTPS in production to protect credentials
- Consider adding IP whitelisting at the nginx/firewall level

## API Endpoints

### Authentication Endpoints

```
GET /api/auth/challenge?user=<account>
Response: { "user", "message", "expiresInMs" }

POST /api/auth/verify
Body: { "user", "message", "signature" }   (signature: Keychain requestSignBuffer, Posting)
Response: { "success": true, "user", "authorized" }

POST /api/auth/logout
Response: { "success": true }

GET /api/auth/status
Response: { "authenticated", "user", "authorized" }   (authenticated = logged in AND in ALLOWED_USERS)
```

### Protected Endpoints

All write operations require authentication:
- `POST /api/config/toggle`
- `POST /api/config/update`
- `POST /api/pins/add`
- `POST /api/pins/remove`
- `POST /api/pins/migrate`
- `POST /api/migration/run`
- `POST /api/gc/run`
- `POST /settings/migration-rate`
- `POST /api/discord/test`
- and every other write in `routes/api.js` marked `requireAuth`

401 is returned when nobody is logged in, 403 for a logged-in account that isn't in `ALLOWED_USERS`.

## Testing

To test authentication:

1. Start the server: `npm start`
2. Open browser to `http://localhost:3101`
3. Try to add a pin without logging in (button should be disabled)
4. Log in with Keychain, as an account in ALLOWED_USERS
5. Add a pin (should now work)
6. Logout
7. Verify actions are disabled again
