import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Helpers that were copied verbatim into a dozen worker files. Only the byte-identical
// copies were replaced by these: publicError, arrayFrom, safeJson, maskEmail, hash, clamp
// and parseJson each have several genuinely different implementations across the codebase
// and are deliberately left where they are — merging those would change behaviour, which is
// how the two enabled() variants came to disagree about whether "0" means off.

export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return structuredClone(fallback); }
}

export function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// 300, matching the copies being replaced. The other safeError variants in the tree slice
// at 180, 220 and 260; those files keep their own version rather than silently changing
// how much of an error message reaches the event log.
export function safeError(error) {
  return String(error?.message || error || '').slice(0, 300);
}

export function round(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 1e6) / 1e6;
}

// Where the two publisher workers drop the JSON the dashboard fetches over HTTP.
//
// This used to be path.join(process.cwd(), 'public', ...) in each worker, while the server
// serves path.resolve(__dirname, 'public'). Those agree only while the process happens to be
// started from the repository root. Started from anywhere else the workers write into a
// 'public' directory that nothing serves, and the dashboard keeps fetching whatever stale
// copy was on disk — with no error anywhere, because writing succeeded.
//
// It also meant `npm run verify` scribbled generated output over the tracked files in the
// repository: worker-smoke-test.mjs constructs both workers against a temp storage dir, but
// the public path ignored that and pointed at the working tree.
export function publicDir(env = process.env) {
  return env.AUTONOMOS_PUBLIC_DIR
    ? path.resolve(env.AUTONOMOS_PUBLIC_DIR)
    : path.resolve(fileURLToPath(import.meta.url), '..', '..', '..', 'public');
}
