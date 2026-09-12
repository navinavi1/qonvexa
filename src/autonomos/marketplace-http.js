// Fixed-origin marketplace transport. Retry reads only; ambiguous writes need a receipt.
export class MarketplaceHttp {
  constructor({
    origin,
    apiKey = "",
    fetchImpl = (...args) => fetch(...args),
    state = {},
    persist = () => {},
    now = () => Date.now(),
  } = {}) {
    this.origin = origin;
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
    this.state = state;
    this.persist = persist;
    this.now = now;
  }
  async request(
    path,
    { method = "GET", body, authenticated = true, signal } = {},
  ) {
    if (signal?.aborted)
      return { ok: false, reason: "cancelled", uncertain: false };
    if (!path.startsWith("/") || path.startsWith("//"))
      return { ok: false, reason: "invalid_api_path" };
    if (authenticated && !this.apiKey)
      return { ok: false, reason: "credentials_missing" };
    if (this.state.until > this.now())
      return {
        ok: false,
        reason: this.state.reason || "marketplace_cooldown",
        retryAt: this.state.until,
      };
    // A served cooldown clears the strike count. Without this, failures only ever grew:
    // this state is persisted, so after three failures every later error immediately
    // re-parked the lane for another two minutes, for the life of the deployment.
    if (this.state.until) {
      this.state.until = 0;
      this.state.reason = "";
      this.state.failures = 0;
      this.persist();
    }
    const read = method === "GET";
    for (let attempt = 0; attempt < (read ? 2 : 1); attempt++) {
      try {
        const response = await this.fetchImpl(this.origin + path, {
          method,
          redirect: "error",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            ...(authenticated
              ? { authorization: `Bearer ${this.apiKey}` }
              : {}),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(20000)])
            : AbortSignal.timeout(20000),
        });
        const data = await response.json().catch(() => null);
        if (response.ok && data !== null) {
          this.state.failures = 0;
          this.state.until = 0;
          this.state.reason = "";
          this.persist();
          return { ok: true, data, status: response.status };
        }
        const reason = response.ok ? "schema_drift" : `http_${response.status}`;
        if (response.status === 429) {
          const raw = response.headers.get("retry-after");
          const seconds =
            raw && /^\d+(\.\d+)?$/.test(raw)
              ? Number(raw)
              : Math.max(0, (Date.parse(raw || "") - this.now()) / 1000);
          this.state.until =
            this.now() +
            Math.max(1000, Number.isFinite(seconds) ? seconds * 1000 : 60000);
          this.state.reason = "rate_limited";
        } else if (response.status === 401 || response.status === 403) {
          this.state.until = this.now() + 300000;
          this.state.reason = "credentials_rejected";
        } else if (response.status >= 500) this.fail(reason);
        this.persist();
        if (
          read &&
          response.status >= 500 &&
          attempt === 0 &&
          !this.state.until
        )
          continue;
        return {
          ok: false,
          reason,
          detail: publicDetail(data),
          status: response.status,
          uncertain: !read && (response.status >= 500 || data === null),
          retryAt: this.state.until || null,
        };
      } catch (error) {
        const reason = signal?.aborted ? "cancelled" : "network_error";
        this.fail(reason);
        this.persist();
        if (read && !signal?.aborted && attempt === 0 && !this.state.until)
          continue;
        return { ok: false, reason, uncertain: !read };
      }
    }
  }
  fail(reason) {
    this.state.failures = (this.state.failures || 0) + 1;
    if (this.state.failures >= 3) {
      this.state.until = this.now() + 120000;
      this.state.reason = reason;
    }
  }
}

function publicDetail(body) {
  const value = body?.error?.message ?? body?.error ?? body?.message ?? body?.detail ?? "";
  return typeof value === "string" ? value.slice(0, 200) : "";
}

export function arrayEnvelope(body, keys) {
  if (Array.isArray(body)) return body;
  for (const key of keys) {
    const value = key.split(".").reduce((v, k) => v?.[k], body);
    if (Array.isArray(value)) return value;
  }
  throw new Error("schema_drift:list_missing");
}
export function objectEnvelope(body) {
  const value = body?.data ?? body;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("schema_drift:object_missing");
  return value;
}
export function requireFields(row, fields) {
  if (
    fields.some(
      (k) => row?.[k] === undefined || row?.[k] === null || row?.[k] === "",
    )
  )
    throw new Error("schema_drift:required_fields");
  return row;
}
export function publicUrl(value) {
  try {
    const u = new URL(String(value));
    return u.protocol === "https:" && !u.username && !u.password ? u.href : "";
  } catch {
    return "";
  }
}
export function solanaAddress(value) {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(value || ""));
}
