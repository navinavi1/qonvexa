# QONVEXA Production 5.1 — Admin Cabinet

## Added
- Protected admin login at `/admin`.
- Username/password authentication configured from environment variables.
- HttpOnly, SameSite=Strict admin session cookie.
- Session expiry after 12 hours.
- Timing-safe credential comparison.
- Login rate limiting.
- Preview-request dashboard.
- Paid-order dashboard.
- Search/filter.
- Refresh.
- Logout.
- Existing public website design and sales funnel preserved.

## Production values still required
- ADMIN_USERNAME
- ADMIN_PASSWORD
- ADMIN_SESSION_SECRET

Use a unique long password and long random session secret.

## Important MVP note
Admin sessions are stored in server memory. That is acceptable for a simple single-instance MVP. If the service later runs on multiple server instances, move sessions to Redis/database storage.
