# Authentication Guide

## Overview

The Hot Node UI uses simple password-based authentication to protect administrative actions. The interface is **view-only by default** and requires login to perform any write operations.

## Setup

### 1. Configure Password

Add your admin password to the `.env` file:

```bash
ADMIN_PASSWORD=your_secure_password_here
SESSION_SECRET=your_random_secret_key_here
```

**Important:**
- Use a strong, unique password
- Never commit `.env` to version control
- Change `SESSION_SECRET` to a random string in production

### 2. Session Configuration

Sessions are configured to:
- Last 24 hours
- Use httpOnly cookies (XSS protection)
- Use secure cookies in production (HTTPS only)

## Usage

### Login

1. Open the Hot Node UI in your browser
2. Click the **🔒 Login** button in the top-right corner
3. Enter your admin password
4. Click **Login**

Once authenticated, all administrative controls become enabled.

### Logout

Click the **🔓 Logout** button in the top-right corner to end your session.

### View-Only Mode

When not authenticated:
- ✅ View all dashboards, stats, and pin lists
- ✅ See system health and status
- ❌ Cannot toggle enable/disable
- ❌ Cannot add or remove pins
- ❌ Cannot trigger migrations or GC
- ❌ Cannot modify settings

### Protected Actions

The following actions require authentication:
- Toggle hot node enabled/disabled
- Add manual pins
- Remove pins
- Update configuration
- Trigger manual migration
- Run garbage collection
- Modify Discord webhook settings

## Security Notes

- Sessions are stored in-memory (restart clears all sessions)
- For production, consider using Redis or MongoDB for session storage
- Always use HTTPS in production to protect credentials
- Implement rate limiting for login attempts (future enhancement)
- Consider adding IP whitelisting at the nginx/firewall level

## API Endpoints

### Authentication Endpoints

```
POST /api/auth/login
Body: { "password": "your_password" }
Response: { "success": true }

POST /api/auth/logout
Response: { "success": true }

GET /api/auth/status
Response: { "authenticated": true/false }
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

401 Unauthorized is returned for unauthenticated requests to protected endpoints.

## Testing

To test authentication:

1. Start the server: `npm start`
2. Open browser to `http://localhost:3101`
3. Try to add a pin without logging in (button should be disabled)
4. Login with your password
5. Add a pin (should now work)
6. Logout
7. Verify actions are disabled again
