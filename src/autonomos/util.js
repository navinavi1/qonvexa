import fs from 'node:fs';

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
