// One header shape for every task-force.app request. Three call sites used to build their
// own and they disagreed: the discovery lane sent the raw key as `authorization` (no
// `Bearer` prefix), the verifier sent `Bearer` only, and the lifecycle lane sent both
// `x-api-key` and `Bearer`. Against a strict server two of the three would answer 401, and
// a 401 in the discovery lane looks exactly like "there is no work today".
// Both headers are sent because task-force.app accepts either; the caller only picks the
// user-agent so per-lane traffic stays distinguishable in their logs.
export function taskForceHeaders(apiKey, userAgent = 'AutonomOS/1.0') {
  const key = String(apiKey || '');
  return {
    accept: 'application/json',
    'x-api-key': key,
    authorization: `Bearer ${key}`,
    'user-agent': String(userAgent || 'AutonomOS/1.0')
  };
}
