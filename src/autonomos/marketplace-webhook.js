import crypto from "node:crypto";

// TaskBounty signs the exact request bytes. Notifications only wake API polling;
// they never authorize a claim, create revenue, or replace provider state.
export function verifyMarketplaceWebhook(raw, signature, secret) {
  if (!secret || secret.length < 32)
    return { ok: false, status: 503, reason: "webhook_not_configured" };
  if (
    !Buffer.isBuffer(raw) ||
    !/^sha256=[a-f0-9]{64}$/i.test(signature || "")
  ) {
    return { ok: false, status: 401, reason: "invalid_webhook_signature" };
  }
  const expected = crypto.createHmac("sha256", secret).update(raw).digest();
  const actual = Buffer.from(signature.slice(7), "hex");
  if (!crypto.timingSafeEqual(expected, actual))
    return { ok: false, status: 401, reason: "invalid_webhook_signature" };
  try {
    const body = JSON.parse(raw.toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new Error("invalid_event");
    return {
      ok: true,
      eventId: crypto.createHash("sha256").update(raw).digest("hex"),
    };
  } catch {
    return { ok: false, status: 400, reason: "invalid_webhook_json" };
  }
}
