-- Additive database only. Existing NDJSON/JSON records are not modified.
CREATE TABLE IF NOT EXISTS records (
 kind TEXT NOT NULL, id TEXT NOT NULL, owner TEXT NOT NULL DEFAULT '',
 data TEXT NOT NULL, PRIMARY KEY(kind,id)
);
CREATE INDEX IF NOT EXISTS records_owner ON records(kind,owner);
CREATE TABLE IF NOT EXISTS jobs (
 id TEXT PRIMARY KEY, type TEXT NOT NULL, owner TEXT NOT NULL, payload TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'QUEUED', attempt INTEGER NOT NULL DEFAULT 0,
 createdAt INTEGER NOT NULL, startedAt INTEGER, finishedAt INTEGER,
 nextRetryAt INTEGER NOT NULL DEFAULT 0, leaseUntil INTEGER NOT NULL DEFAULT 0,
 leaseToken TEXT, progress INTEGER NOT NULL DEFAULT 0, lastError TEXT, result TEXT
);
CREATE INDEX IF NOT EXISTS jobs_ready ON jobs(status,nextRetryAt);
CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);
INSERT OR IGNORE INTO schema_version VALUES (1);
