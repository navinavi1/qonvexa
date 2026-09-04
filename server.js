import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import Stripe from 'stripe';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createAutonomOS } from './src/autonomos/runtime.js';
import { verifyAuth0Bearer } from './src/autonomos/auth0.js';
import { hydrateExternalSecrets } from './src/autonomos/secret-provider.js';

await hydrateExternalSecrets(process.env,{logger:console});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.resolve(__dirname, 'public');
const packageMeta = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
const appVersion = clean(packageMeta.version || 'unknown', 40);
const gitCommit = clean(process.env.RENDER_GIT_COMMIT || '', 64);

const app = express();
const port = safeInteger(process.env.PORT, 3000, 1, 65535);
const isProduction = process.env.NODE_ENV === 'production';
const launchMode = clean(process.env.LAUNCH_MODE || (isProduction ? 'staging' : 'development'), 20).toLowerCase();
const isLiveLaunch = launchMode === 'live';
const siteUrl = normalizeSiteUrl(process.env.SITE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${port}`);
const priceCents = safeInteger(process.env.AUDIT_PRICE_CENTS, 14900, 50, 10000000);
const allowStagingPayments = /^(1|true|yes|on)$/i.test(String(process.env.ALLOW_STAGING_PAYMENTS || 'false'));
const salesEnabled = !isProduction || isLiveLaunch || allowStagingPayments;
const paymentMode = clean(process.env.PAYMENT_MODE || (process.env.STRIPE_SECRET_KEY ? 'stripe' : 'manual'), 20).toLowerCase();
const manualPaymentEnabled = /^(1|true|yes|on)$/i.test(String(process.env.MANUAL_PAYMENT_ENABLED || 'false'));
const storageDir = path.resolve(process.env.STORAGE_DIR || path.join(__dirname, 'data'));
// Live mode requires persistent STORAGE_DIR under /var/lib/qonvexa (deployment invariant).
const contactEmail = clean(process.env.CONTACT_EMAIL || 'hello@qonvexa.co', 320);
const adminUsername = clean(process.env.ADMIN_USERNAME || 'admin', 120);
const adminPassword = String(process.env.ADMIN_PASSWORD || '');
const adminSessionSecret = String(process.env.ADMIN_SESSION_SECRET || '');
const adminSessionTtlMs = 12 * 60 * 60 * 1000;
const adminSessions = new Map();

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

validateProductionConfig();
verifyPublicAssets();
fs.mkdirSync(storageDir, { recursive: true });

// AutonomOS is embedded into the existing QONVEXA service. It stores only
// public wallet information and operational state; private keys are never
// accepted by the browser or persisted by this application.
const autonomos = createAutonomOS({
  storageDir,
  siteUrl,
  ownerWallet: clean(process.env.AUTONOMOS_OWNER_WALLET || '0x1f674bf085f6fed36fa198287d51edf0fe0bb9e2', 80),
  env: process.env,
  logger: console
});

const rateBuckets = new Map();
function rateLimit({ windowMs, max }) {
  return (req, res, next) => {
    const key = `${req.ip}:${req.path}`;
    const now = Date.now();
    let bucket = rateBuckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + windowMs };
      rateBuckets.set(key, bucket);
    }
    bucket.count += 1;
    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, max - bucket.count)));
    if (bucket.count > max) {
      return res.status(429).json({ error: 'Too many requests. Please try again later.' });
    }
    next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets) if (now >= bucket.resetAt) rateBuckets.delete(key);
}, 10 * 60 * 1000).unref();

app.set('trust proxy', 1);
app.disable('x-powered-by');

// Stripe webhook MUST stay before express.json().
app.post('/stripe/webhook', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(503).send('Stripe webhook is not configured.');
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === 'checkout.session.completed' ||
        event.type === 'checkout.session.async_payment_succeeded') {
      const session = event.data.object;
      if (session.payment_status === 'paid') {
        await fulfillPaidSession(session, event.id);
      }
    } else if (event.type === 'checkout.session.async_payment_failed') {
      appendNdjson('payment-failures.ndjson', {
        receivedAt: new Date().toISOString(),
        eventId: event.id,
        sessionId: event.data.object?.id || '',
        paymentStatus: event.data.object?.payment_status || ''
      });
    }
    res.json({ received: true });
  } catch (err) {
    console.error('Webhook processing failed:', err);
    res.status(500).send('Webhook processing failed.');
  }
});

app.use(helmet({
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      formAction: ["'self'", 'https://checkout.stripe.com'],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      objectSrc: ["'none'"],
      ...(isProduction ? { upgradeInsecureRequests: [] } : {})
    }
  }
}));
app.use(express.json({ limit: '50kb' }));
app.use(express.urlencoded({ extended: false, limit: '50kb' }));

app.post('/api/internal/autonomos/temporal/execute', async (req,res)=>{
  res.setHeader('Cache-Control','no-store');
  const expected=String(process.env.AUTONOMOS_TEMPORAL_WORKER_TOKEN||'');
  const supplied=String(req.get('authorization')||'').replace(/^Bearer\s+/i,'');
  if(!expected||!supplied||expected.length!==supplied.length||!crypto.timingSafeEqual(Buffer.from(expected),Buffer.from(supplied))){
    return res.status(401).json({ok:false,error:'unauthorized_temporal_worker'});
  }
  try{return res.json(await autonomos.processDurableOpportunity(req.body?.opportunity));}
  catch(error){return res.status(500).json({ok:false,error:clean(error?.message||error,300)});}
});

function stableJsonForSignature(value){
  if(Array.isArray(value))return `[${value.map(stableJsonForSignature).join(',')}]`;
  if(value&&typeof value==='object')return `{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${stableJsonForSignature(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

app.post('/api/internal/autonomos/trigger/execute', async (req,res)=>{
  res.setHeader('Cache-Control','no-store');
  const secret=String(process.env.TRIGGER_SECRET_KEY||'');
  const issuedAt=Number(req.body?.issuedAt||0);
  const supplied=String(req.body?.signature||'');
  const age=Date.now()-issuedAt;
  const expected=secret&&issuedAt?crypto.createHmac('sha256',secret).update(`${issuedAt}.${stableJsonForSignature(req.body?.opportunity)}`).digest('hex'):'';
  const validTime=Number.isFinite(age)&&age>=-60_000&&age<=15*60_000;
  const validSig=Boolean(expected&&supplied&&expected.length===supplied.length&&crypto.timingSafeEqual(Buffer.from(expected),Buffer.from(supplied)));
  if(!validTime||!validSig)return res.status(401).json({ok:false,error:'unauthorized_trigger_callback'});
  try{return res.json(await autonomos.processDurableOpportunity(req.body?.opportunity));}
  catch(error){return res.status(500).json({ok:false,error:clean(error?.message||error,300)});}
});

// Dynamic HTML routes allow production metadata/legal values to come from environment config.
for (const route of ['/', '/index.html']) {
  app.get(route, (req, res) => {
    if (launchMode !== 'live') console.log(`Homepage request: ${req.method} ${req.originalUrl}`);
    sendHtml(res, 'index.html');
  });
}
app.get('/privacy.html', (_req, res) => sendHtml(res, 'privacy.html'));
app.get('/terms.html', (_req, res) => sendHtml(res, 'terms.html'));
app.get('/refund.html', (_req, res) => sendHtml(res, 'refund.html'));
app.get('/success.html', (_req, res) => sendHtml(res, 'success.html'));

// Public OAuth Client ID Metadata Document used by MCP authorization servers that
// support URL-form client IDs. It contains no secret and intentionally stays public.
app.get('/oauth/t2000-client.json', (_req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.json(autonomos.t2000ClientMetadata());
});

app.use('/api/admin', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

app.get('/admin', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(pubPath(), 'admin.html'));
});

app.post('/api/admin/login',
  requireSameSiteMutation,
  rateLimit({ windowMs: 15 * 60 * 1000, max: 12 }),
  (req, res) => {
    if (!adminPassword || !adminSessionSecret) {
      return res.status(503).json({ error: 'Admin access is not configured.' });
    }
    const username = clean(req.body?.username || '', 120);
    const password = String(req.body?.password || '');
    if (!safeCredentialEqual(username, adminUsername) || !safeCredentialEqual(password, adminPassword)) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    const token = createAdminSession();
    const maxAge = Math.floor(adminSessionTtlMs / 1000);
    res.setHeader('Set-Cookie',
      `qonvexa_admin=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${isProduction ? '; Secure' : ''}`
    );
    logAdminEvent('admin_login', { username: adminUsername });
    res.json({ ok: true, username: adminUsername });
  }
);

app.post('/api/admin/logout', requireSameSiteMutation, (req, res) => {
  const session = getAdminSession(req);
  if (session) adminSessions.delete(session.key);
  res.setHeader('Set-Cookie',
    `qonvexa_admin=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${isProduction ? '; Secure' : ''}`
  );
  logAdminEvent('admin_logout', { username: adminUsername });
  res.json({ ok: true });
});

app.get('/api/admin/session', (req, res) => {
  const session = getAdminSession(req);
  if (!session) return res.status(401).json({ authenticated: false });
  res.json({ authenticated: true, username: adminUsername });
});

app.get('/api/admin/dashboard', requireAdmin, (_req, res) => {
  const previews = withEntityState(readNdjson('preview-requests.ndjson'), 'lead');
  const orders = withEntityState(readNdjson('orders.ndjson'), 'order');
  const clients = buildClients(previews, orders);
  const events = readNdjson('admin-events.ndjson').slice(-300).reverse();
  const settings = readAdminSettings();
  res.json({
    counts: {
      previews: previews.length,
      paidOrders: orders.filter(isOrderPaid).length,
      clients: clients.length,
      openLeads: previews.filter(x => !['closed','won','lost'].includes(x.status)).length,
      activeOrders: orders.filter(x => isOrderPaid(x) && !['delivered','refunded','cancelled'].includes(x.status)).length
    },
    previews: previews.slice(-300).reverse(),
    orders: orders.slice(-300).reverse(),
    clients,
    events,
    settings,
    system: {
      siteUrl,
      contactEmail,
      stripeConfigured: Boolean(stripe),
      manualPaymentConfigured: manualPaymentConfig().enabled,
      paymentMode,
      salesEnabled,
      storageDir,
      persistentStorage: isPersistentStorage(),
      notificationWebhookConfigured: Boolean(process.env.NOTIFICATION_WEBHOOK_URL),
      domainEmailConfigured: isValidEmail(settings.domainEmail || contactEmail)
    }
  });
});

app.patch('/api/admin/leads/:id', requireAdmin, requireSameSiteMutation, (req, res) => {
  const id = clean(req.params.id, 120);
  const allowed = ['new','reviewing','preview_sent','follow_up','won','lost','closed'];
  const status = clean(req.body?.status || '', 40);
  const note = clean(req.body?.adminNote || '', 2000);
  const miniAuditTitle = clean(req.body?.miniAuditTitle || '', 180);
  const miniAuditSummary = clean(req.body?.miniAuditSummary || '', 3000);
  const miniAuditFindings = clean(req.body?.miniAuditFindings || '', 4000);
  const preparedAuditUrl = clean(req.body?.preparedAuditUrl || '', 1000);

  if (status && !allowed.includes(status)) return res.status(400).json({ error: 'Invalid lead status.' });
  if (preparedAuditUrl && !isValidHttpUrl(preparedAuditUrl)) {
    return res.status(400).json({ error: 'Prepared full audit URL must be a valid http(s) URL.' });
  }

  const exists = readNdjson('preview-requests.ndjson').some(item => item.id === id);
  if (!exists) return res.status(404).json({ error: 'Lead not found.' });

  const state = updateEntityState('lead', id, {
    status: status || undefined,
    adminNote: note,
    miniAuditTitle,
    miniAuditSummary,
    miniAuditFindings,
    preparedAuditUrl
  });

  logAdminEvent('lead_updated', {
    entityId:id,
    status:state.status,
    miniAuditReady:Boolean(state.miniAuditSummary),
    preparedFullAudit:Boolean(state.preparedAuditUrl)
  });
  res.json({ ok:true, state });
});

app.patch('/api/admin/orders/:id', requireAdmin, requireSameSiteMutation, (req, res) => {
  const id = clean(req.params.id, 200);
  const allowed = ['awaiting_payment','paid','queued','in_progress','ready','delivered','refunded','cancelled'];
  const status = clean(req.body?.status || '', 40);
  const note = clean(req.body?.adminNote || '', 2000);
  const deliveryUrl = clean(req.body?.deliveryUrl || '', 1000);
  if (status && !allowed.includes(status)) return res.status(400).json({ error: 'Invalid order status.' });
  if (deliveryUrl && !isValidHttpUrl(deliveryUrl)) return res.status(400).json({ error: 'Delivery URL must be a valid http(s) URL.' });
  const exists = readNdjson('orders.ndjson').some(item => item.sessionId === id);
  if (!exists) return res.status(404).json({ error: 'Order not found.' });
  const order = readNdjson('orders.ndjson').find(item => item.sessionId === id);
  const inheritedPreparedAudit = order && ['paid','queued','in_progress','ready','delivered'].includes(status)
    ? preparedAuditForLead(order.sourceLeadId, order.customerEmail)
    : '';
  const state = updateEntityState('order', id, {
    status: inheritedPreparedAudit ? 'ready' : (status || undefined),
    adminNote: note,
    deliveryUrl: deliveryUrl || inheritedPreparedAudit
  });
  logAdminEvent('order_updated', { entityId:id, status:state.status, deliveryConfigured:Boolean(state.deliveryUrl) });
  res.json({ ok:true, state });
});

app.get('/api/admin/clients', requireAdmin, (_req, res) => {
  const previews = withEntityState(readNdjson('preview-requests.ndjson'), 'lead');
  const orders = withEntityState(readNdjson('orders.ndjson'), 'order');
  res.json({ clients: buildClients(previews, orders) });
});

app.get('/api/admin/events', requireAdmin, (_req, res) => {
  res.json({ events: readNdjson('admin-events.ndjson').slice(-500).reverse() });
});

app.get('/api/admin/settings', requireAdmin, (_req, res) => {
  res.json({
    settings: readAdminSettings(),
    system: {
      siteUrl,
      contactEmail,
      stripeConfigured: Boolean(stripe),
      notificationWebhookConfigured: Boolean(process.env.NOTIFICATION_WEBHOOK_URL)
    }
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// AutonomOS owner control plane (same authenticated owner session as QONVEXA).
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/admin/autonomos', requireAdmin, async (_req, res) => {
  res.json(await autonomos.snapshot());
});

app.patch('/api/admin/autonomos/config', requireAdmin, requireSameSiteMutation, (req, res) => {
  try {
    const config = autonomos.updateConfig(req.body || {});
    logAdminEvent('autonomos_config_updated', { heartbeatSeconds:config.heartbeatSeconds, minMarginPercent:config.minMarginPercent });
    res.json({ ok:true, config });
  } catch (error) {
    res.status(400).json({ error:clean(error?.message || 'Invalid AutonomOS configuration.', 400) });
  }
});

app.post('/api/admin/autonomos/start', requireAdmin, requireSameSiteMutation, (_req, res) => {
  const result = autonomos.start();
  logAdminEvent('autonomos_started', {});
  res.json(result);
});

app.post('/api/admin/autonomos/stop', requireAdmin, requireSameSiteMutation, (_req, res) => {
  const result = autonomos.stop();
  logAdminEvent('autonomos_stopped', {});
  res.json(result);
});

app.post('/api/admin/autonomos/emergency-stop', requireAdmin, requireSameSiteMutation, (_req, res) => {
  const result = autonomos.emergencyStop();
  logAdminEvent('autonomos_emergency_stop', {});
  res.json(result);
});

app.post('/api/admin/autonomos/clear-emergency', requireAdmin, requireSameSiteMutation, (_req, res) => {
  const result = autonomos.clearEmergencyStop();
  logAdminEvent('autonomos_emergency_cleared', {});
  res.json(result);
});

app.post('/api/admin/autonomos/cycle', requireAdmin, requireSameSiteMutation, async (_req, res) => {
  res.json(await autonomos.runCycle());
});

app.post('/api/admin/autonomos/reset-claim-history', requireAdmin, requireSameSiteMutation, (_req, res) => {
  res.json(autonomos.resetClaimHistory());
});

app.post('/api/admin/autonomos/retry-transient', requireAdmin, requireSameSiteMutation, (_req, res) => {
  res.json(autonomos.retryTransientFailures());
});

app.post('/api/admin/autonomos/archive-legacy-history', requireAdmin, requireSameSiteMutation, (_req, res) => {
  const result=autonomos.archiveLegacyHistory();
  logAdminEvent('autonomos_legacy_history_archived', { archived:result.archived||[] });
  res.json(result);
});

app.post('/api/admin/autonomos/live-self-test', requireAdmin, requireSameSiteMutation, async (_req, res) => {
  res.json(await autonomos.runLiveSelfTest());
});

app.post('/api/admin/autonomos/reconcile-payments', requireAdmin, requireSameSiteMutation, async (_req, res) => {
  res.json(await autonomos.reconcilePayments());
});

app.post('/api/admin/autonomos/treasury/refresh', requireAdmin, requireSameSiteMutation, async (_req, res) => {
  res.json(await autonomos.refreshTreasury());
});

app.post('/api/admin/autonomos/t2000/connect', requireAdmin, requireSameSiteMutation,
  rateLimit({ windowMs: 5 * 60 * 1000, max: 10 }),
  async (_req, res) => {
    try {
      res.json(await autonomos.beginT2000Connect());
    } catch (error) {
      res.status(Number(error?.status || 502)).json({ error:clean(error?.message || 't2000 OAuth setup failed.', 400) });
    }
  }
);

// OAuth redirects come from Google/t2000, so the SameSite=Strict admin cookie may not be
// present on this cross-site callback. The callback is authenticated by a cryptographically
// random, single-use OAuth state value stored server-side; it does not expose owner data.
app.get('/api/admin/autonomos/t2000/callback',
  rateLimit({ windowMs: 5 * 60 * 1000, max: 20 }),
  async (req, res) => {
    try {
      await autonomos.finishT2000Connect({ code:req.query.code, state:req.query.state, iss:req.query.iss, error:req.query.error, error_description:req.query.error_description });
      logAdminEvent('t2000_oauth_connected', {});
      res.redirect(303, '/admin?t2000=connected#autonomos');
    } catch (error) {
      const detail=clean(error?.message || 't2000 OAuth callback failed.', 240);
      logAdminEvent('t2000_oauth_failed', { error:detail });
      res.redirect(303, `/admin?t2000=error&detail=${encodeURIComponent(detail)}#autonomos`);
    }
  }
);

app.post('/api/admin/autonomos/t2000/refresh', requireAdmin, requireSameSiteMutation,
  rateLimit({ windowMs: 60 * 1000, max: 12 }),
  async (_req, res) => {
    try { res.json(await autonomos.refreshT2000Jobs()); }
    catch (error) { res.status(Number(error?.status || 502)).json({ error:clean(error?.message || 't2000 refresh failed.', 300) }); }
  }
);

app.post('/api/admin/autonomos/t2000/disconnect', requireAdmin, requireSameSiteMutation, (_req, res) => {
  const result=autonomos.disconnectT2000();
  logAdminEvent('t2000_oauth_disconnected', {});
  res.json(result);
});

app.get('/api/admin/autonomos/product-preview/:productId', requireAdmin,
  rateLimit({ windowMs: 5 * 60 * 1000, max: 20 }),
  async (req, res) => {
    try {
      res.json(await autonomos.previewProduct(clean(req.params.productId, 80), { url:clean(req.query.url || '', 1000) }));
    } catch (error) {
      res.status(Number(error?.status || 500)).json({ error:clean(error?.code || error?.message || 'Preview failed.', 300) });
    }
  }
);

app.patch('/api/admin/settings', requireAdmin, requireSameSiteMutation, (req, res) => {
  const current = readAdminSettings();
  const next = {
    ownerDisplayName: clean(req.body?.ownerDisplayName ?? current.ownerDisplayName ?? '', 120),
    domainEmail: clean(req.body?.domainEmail ?? current.domainEmail ?? '', 320),
    notificationEmail: clean(req.body?.notificationEmail ?? current.notificationEmail ?? '', 320),
    defaultLeadStatus: clean(req.body?.defaultLeadStatus ?? current.defaultLeadStatus ?? 'new', 40),
    defaultOrderStatus: clean(req.body?.defaultOrderStatus ?? current.defaultOrderStatus ?? 'paid', 40),
    updatedAt: new Date().toISOString()
  };
  const leadStatuses = ['new','reviewing','preview_sent','follow_up'];
  const orderStatuses = ['paid','queued','in_progress'];
  if (next.domainEmail && !isValidEmail(next.domainEmail)) return res.status(400).json({ error:'Invalid domain email.' });
  if (next.notificationEmail && !isValidEmail(next.notificationEmail)) return res.status(400).json({ error:'Invalid notification email.' });
  if (!leadStatuses.includes(next.defaultLeadStatus)) return res.status(400).json({ error:'Invalid default lead status.' });
  if (!orderStatuses.includes(next.defaultOrderStatus)) return res.status(400).json({ error:'Invalid default order status.' });
  writeJsonAtomic('admin-settings.json', next);
  logAdminEvent('settings_updated', {
    ownerDisplayName: next.ownerDisplayName,
    domainEmail: next.domainEmail,
    notificationEmail: next.notificationEmail
  });
  res.json({ ok:true, settings:next });
});

app.get('/api/admin/export/:type.csv', requireAdmin, (req, res) => {
  const type = clean(req.params.type, 40);
  let rows = [];
  let headers = [];
  if (type === 'leads') {
    rows = withEntityState(readNdjson('preview-requests.ndjson'), 'lead');
    headers = ['id','receivedAt','email','websiteUrl','businessType','note','status','adminNote'];
  } else if (type === 'orders') {
    rows = withEntityState(readNdjson('orders.ndjson'), 'order');
    headers = ['sessionId','receivedAt','customerEmail','websiteUrl','businessType','primaryGoal','primaryService','amountTotal','currency','paymentStatus','status','adminNote'];
  } else if (type === 'clients') {
    rows = buildClients(
      withEntityState(readNdjson('preview-requests.ndjson'), 'lead'),
      withEntityState(readNdjson('orders.ndjson'), 'order')
    );
    headers = ['email','websiteUrl','businessType','firstSeenAt','lastSeenAt','previewCount','orderCount','totalPaidCents','currency','latestLeadStatus','latestOrderStatus'];
  } else {
    return res.status(404).json({ error:'Unknown export type.' });
  }
  const csv = toCsv(headers, rows);
  logAdminEvent('csv_exported', { type, count:rows.length });
  res.setHeader('Content-Type','text/csv; charset=utf-8');
  res.setHeader('Content-Disposition',`attachment; filename="qonvexa-${type}.csv"`);
  res.send('\uFEFF' + csv);
});

app.get('/robots.txt', (_req, res) => {
  const txt = fs.readFileSync(path.join(pubPath(), 'robots.txt'), 'utf8')
    .replaceAll('{{SITE_URL}}', siteUrl);
  res.type('text/plain').send(txt);
});
app.get('/sitemap.xml', (_req, res) => {
  const xml = fs.readFileSync(path.join(pubPath(), 'sitemap.xml'), 'utf8')
    .replaceAll('{{SITE_URL}}', siteUrl);
  res.type('application/xml').send(xml);
});

app.get('/launch-readiness', (_req, res) => {
  const checks = {
    siteUrl: /^https:\/\//i.test(siteUrl),
    contactEmail: isValidEmail(contactEmail),
    legalBusinessName: Boolean(clean(process.env.LEGAL_BUSINESS_NAME || '', 300)),
    legalAddress: Boolean(clean(process.env.LEGAL_ADDRESS || '', 500)),
    legalJurisdiction: Boolean(clean(process.env.LEGAL_JURISDICTION || '', 200)),
    deliveryTimeframe: Boolean(clean(process.env.DELIVERY_TIMEFRAME || '', 300)),
    refundPolicy: Boolean(clean(process.env.REFUND_POLICY_TEXT || '', 2000)),
    paymentProvider: Boolean(stripe) || manualPaymentConfig().enabled,
    notificationWebhook: Boolean(process.env.NOTIFICATION_WEBHOOK_URL),
    persistentStorage: isPersistentStorage(),
    salesEnabled
  };
  res.json({
    launchMode,
    readyForLiveSales: Object.values(checks).every(Boolean),
    checks
  });
});

app.get('/version', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ name:'QONVEXA', version:appVersion, commit:gitCommit || null, launchMode, salesEnabled });
});

app.get('/health', (_req, res) => res.json({
  ok: true,
  environment: isProduction ? 'production' : 'development',
  launchMode,
  stripeConfigured: Boolean(stripe),
  manualPaymentConfigured: manualPaymentConfig().enabled,
  paymentMode,
  salesEnabled,
  storageConfigured: Boolean(storageDir),
  persistentStorage: isPersistentStorage(),
  publicIndexAvailable: fs.existsSync(path.join(publicDir, 'index.html'))
}));

app.post('/api/preview-request',
  rateLimit({ windowMs: 15 * 60 * 1000, max: 10 }),
  async (req, res) => {
    const { websiteUrl, email, businessType = '', note = '', company = '' } = req.body || {};

    // Honeypot. Legitimate browsers leave this hidden field empty.
    if (company) return res.json({ ok: true });

    if (!isValidHttpUrl(websiteUrl) || !isValidEmail(email)) {
      return res.status(400).json({ error: 'Please provide a valid website URL and email.' });
    }

    const lead = {
      id: crypto.randomUUID(),
      receivedAt: new Date().toISOString(),
      websiteUrl: clean(websiteUrl, 500),
      email: clean(email, 320),
      businessType: clean(businessType, 120),
      note: clean(note, 1000),
      ipHash: hashIp(req.ip)
    };
    appendNdjson('preview-requests.ndjson', lead);
    updateEntityState('lead', lead.id, { status: readAdminSettings().defaultLeadStatus || 'new', adminNote:'' });
    logAdminEvent('preview_request_received', { entityId:lead.id, email:lead.email, websiteUrl:lead.websiteUrl });
    await sendOptionalWebhook('preview_request', lead);
    res.json({ ok: true, requestId: lead.id });
  }
);


app.post('/api/find-mini-audit',
  rateLimit({ windowMs: 15 * 60 * 1000, max: 8 }),
  (req, res) => {
    const email = clean(req.body?.email || '', 320).toLowerCase();
    if (!isValidEmail(email)) {
      return res.status(400).json({ error:'Please enter a valid email address.' });
    }

    const matches = withEntityState(readNdjson('preview-requests.ndjson'), 'lead')
      .filter(item => String(item.email || '').trim().toLowerCase() === email)
      .filter(item => Boolean(item.miniAuditSummary))
      .sort((a,b) => String(b.statusUpdatedAt || b.receivedAt || '').localeCompare(String(a.statusUpdatedAt || a.receivedAt || '')));

    const lead = matches[0];
    res.setHeader('Cache-Control', 'no-store');

    if (!lead) {
      return res.json({
        found:false,
        message:'We could not find a ready mini-audit for this email. Use the email from your invitation or contact hello@qonvexa.co.'
      });
    }

    res.json({
      found:true,
      miniAudit:{
        leadId:lead.id,
        email:lead.email,
        websiteUrl:lead.websiteUrl,
        businessType:lead.businessType || '',
        title:lead.miniAuditTitle || 'Your QONVEXA mini-audit',
        summary:lead.miniAuditSummary,
        findings:String(lead.miniAuditFindings || '').split(/\\r?\\n/).map(x=>x.trim()).filter(Boolean).slice(0,5),
        fullAuditPrepared:Boolean(lead.preparedAuditUrl)
      },
      priceCents,
      currency:'USD'
    });
  }
);

app.get('/api/purchase-options',
  rateLimit({ windowMs: 5 * 60 * 1000, max: 60 }),
  (_req, res) => {
    const manual = manualPaymentConfig();
    const stripeAvailable = salesEnabled && Boolean(stripe);
    res.json({
      priceCents,
      currency: 'USD',
      primary: paymentMode,
      methods: {
        card: {
          available: stripeAvailable,
          label: 'Pay securely by card'
        },
        bankTransfer: {
          available: salesEnabled && manual.enabled,
          label: 'Bank transfer',
          details: salesEnabled && manual.enabled ? manual.details : null
        }
      },
      contactEmail
    });
  }
);

app.post('/api/manual-order',
  rateLimit({ windowMs: 15 * 60 * 1000, max: 8 }),
  async (req, res) => {
    if (!salesEnabled) return res.status(503).json({ error: 'Paid checkout is not enabled yet.' });
    const manual = manualPaymentConfig();
    if (!manual.enabled) {
      return res.status(503).json({ error: 'Bank-transfer checkout is not configured.' });
    }

    const {
      websiteUrl,
      businessType = '',
      primaryGoal = '',
      primaryService = '',
      sourceLeadId = '',
      email = ''
    } = req.body || {};

    if (!isValidHttpUrl(websiteUrl) || !isValidEmail(email)) {
      return res.status(400).json({ error: 'Please provide a valid website URL and email.' });
    }

    const orderId = `qvx_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
    const accessToken = crypto.randomBytes(24).toString('hex');
    const order = {
      receivedAt: new Date().toISOString(),
      eventId: '',
      sessionId: orderId,
      paymentMethod: 'bank_transfer',
      paymentStatus: 'pending',
      customerEmail: clean(email, 320),
      websiteUrl: clean(websiteUrl, 500),
      businessType: clean(businessType, 120),
      primaryGoal: clean(primaryGoal, 120),
      primaryService: clean(primaryService, 180),
      sourceLeadId: resolveSourceLeadId(sourceLeadId, email),
      amountTotal: priceCents,
      currency: manual.details.currency.toLowerCase(),
      publicTokenHash: hashOrderToken(accessToken)
    };

    appendNdjson('orders.ndjson', order);
    updateEntityState('order', orderId, { status: 'awaiting_payment', adminNote: '' });
    logAdminEvent('manual_order_created', {
      entityId: orderId,
      email: order.customerEmail,
      websiteUrl: order.websiteUrl
    });
    await sendOptionalWebhook('manual_order_created', {
      ...order,
      publicTokenHash: undefined
    });

    res.status(201).json({
      ok: true,
      orderId,
      accessToken,
      statusUrl: `${siteUrl}/order.html?token=${encodeURIComponent(accessToken)}`,
      amountTotal: priceCents,
      currency: manual.details.currency,
      bankDetails: manual.details
    });
  }
);

app.get('/api/order-status',
  rateLimit({ windowMs: 5 * 60 * 1000, max: 60 }),
  async (req, res) => {
    const token = clean(req.query.token || '', 200);
    const sessionId = clean(req.query.session_id || '', 220);
    if (!/^[a-f0-9]{48}$/i.test(token)) {
      return res.status(400).json({ error: 'Invalid order access token.' });
    }

    let order = getOrderByAccessToken(token);

    if (!order && sessionId && stripe) {
      try {
        const session = await stripe.checkout.sessions.retrieve(sessionId);
        const expectedHash = clean(session.metadata?.publicTokenHash || '', 128);
        if (!expectedHash || !safeCredentialEqual(expectedHash, hashOrderToken(token))) {
          return res.status(404).json({ error: 'Order not found.' });
        }
        if (session.payment_status === 'paid') {
          await fulfillPaidSession(session, `status:${session.id}`);
          order = getOrderByAccessToken(token);
        }
        if (!order) {
          res.setHeader('Cache-Control', 'no-store');
          return res.json(publicStripeSessionPayload(session));
        }
      } catch {
        return res.status(404).json({ error: 'Order not found.' });
      }
    }

    if (!order) return res.status(404).json({ error: 'Order not found.' });
    res.setHeader('Cache-Control', 'no-store');
    res.json(publicOrderPayload(order));
  }
);

app.post('/api/create-checkout-session',
  rateLimit({ windowMs: 15 * 60 * 1000, max: 12 }),
  async (req, res) => {
    if (!salesEnabled) return res.status(503).json({ error: 'Paid checkout is not enabled yet.' });
    if (!stripe) {
      return res.status(503).json({ error: 'Payments are not configured yet.' });
    }

    const {
      websiteUrl,
      businessType = '',
      primaryGoal = '',
      primaryService = '',
      sourceLeadId = '',
      email = ''
    } = req.body || {};

    if (!isValidHttpUrl(websiteUrl) || !isValidEmail(email)) {
      return res.status(400).json({ error: 'Please provide a valid website URL and email.' });
    }

    try {
      const publicAccessToken = crypto.randomBytes(24).toString('hex');
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        customer_email: clean(email, 320),
        line_items: [{
          price_data: {
            currency: 'usd',
            product_data: {
              name: 'QONVEXA Website Conversion Audit',
              description: 'Human-reviewed, prioritized conversion audit for one public website.'
            },
            unit_amount: priceCents
          },
          quantity: 1
        }],
        metadata: {
          websiteUrl: clean(websiteUrl, 500),
          businessType: clean(businessType, 120),
          primaryGoal: clean(primaryGoal, 120),
          primaryService: clean(primaryService, 180),
          sourceLeadId: resolveSourceLeadId(sourceLeadId, email),
          publicTokenHash: hashOrderToken(publicAccessToken)
        },
        success_url: `${siteUrl}/order.html?token=${encodeURIComponent(publicAccessToken)}&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${siteUrl}/?checkout=cancelled#pricing`,
        billing_address_collection: 'auto'
      });

      res.json({ url: session.url });
    } catch (err) {
      console.error('Stripe session creation failed:', err);
      res.status(500).json({ error: 'Could not start secure checkout.' });
    }
  }
);

app.get('/api/checkout-session-status',
  rateLimit({ windowMs: 5 * 60 * 1000, max: 30 }),
  async (req, res) => {
    if (!stripe) return res.status(503).json({ error: 'Payments are not configured.' });

    const sessionId = clean(req.query.session_id || '', 200);
    if (!/^cs_(test_|live_)?[A-Za-z0-9_]+$/.test(sessionId)) {
      return res.status(400).json({ error: 'Invalid checkout session.' });
    }

    try {
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      res.json({
        id: session.id,
        status: session.status,
        paymentStatus: session.payment_status,
        customerEmail: session.customer_details?.email || session.customer_email || '',
        amountTotal: session.amount_total,
        currency: session.currency,
        websiteUrl: session.metadata?.websiteUrl || ''
      });
    } catch (err) {
      res.status(404).json({ error: 'Checkout session not found.' });
    }
  }
);


// ─────────────────────────────────────────────────────────────────────────────
// AutonomOS machine-service surface. Catalog is free; product endpoints are
// payment-gated by x402 when the selected facilitator/network are configured.
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/autonomos/catalog',
  rateLimit({ windowMs: 5 * 60 * 1000, max: 120 }),
  (_req, res) => res.json(autonomos.catalog())
);

app.get('/.well-known/autonomos.json', (_req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.json(autonomos.catalog());
});

for (const product of autonomos.products) {
  app.get(product.path,
    rateLimit({ windowMs: 5 * 60 * 1000, max: 90 }),
    (req, res) => autonomos.handleProductRequest(product.id, req, res)
  );
}

// Do not expose stale deployment/source artifacts that happen to exist under
// /public in older QONVEXA archives. They are not needed by the browser.
app.use((req, res, next) => {
  let pathname = '';
  try { pathname = decodeURIComponent(req.path || '').toLowerCase(); } catch { return res.status(400).send('Bad Request'); }
  if (
    pathname === '/server.js' || pathname === '/package.json' || pathname === '/render.yaml' ||
    pathname === '/procfile' || pathname.endsWith('.md') || pathname.startsWith('/scripts/')
  ) return res.status(404).type('text').send('Not Found');
  next();
});

// Serve public assets only after explicit dynamic/admin/SEO/API routes.
// This prevents /admin, /robots.txt and /sitemap.xml from being intercepted
// by express.static before their dedicated handlers run.
app.use(express.static(publicDir, {
  extensions: ['html'],
  index: false,
  maxAge: isProduction ? '1d' : 0,
  etag: true,
  setHeaders(res, filePath) {
    const base = path.basename(filePath).toLowerCase();
    if (base.startsWith('admin.')) {
      res.setHeader('Cache-Control', 'no-store');
      return;
    }
    if (/\.(css|js)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
      return;
    }
    if (/\.(png|svg|woff2?)$/i.test(filePath)) {
      res.setHeader('Cache-Control', isProduction ? 'public, max-age=86400' : 'no-cache');
    }
  }
}));

// Deliberate final 404: if the homepage ever fails, sendHtml logs the real
// filesystem/template error instead of silently hiding it as a generic 404.
app.use((req, res) => {
  if (req.method === 'GET') return res.status(404).type('text').send('Not Found');
  return res.status(404).json({ error: 'Not found' });
});

async function fulfillPaidSession(session, eventId) {
  const freshSession = stripe ? await stripe.checkout.sessions.retrieve(session.id) : session;
  if (freshSession.payment_status !== 'paid') return;
  session = freshSession;
  const sessionId = clean(session.id, 200);
  const fulfilledFile = path.join(storageDir, 'fulfilled-sessions.json');
  let fulfilled = {};
  try {
    fulfilled = JSON.parse(fs.readFileSync(fulfilledFile, 'utf8'));
  } catch {}

  if (fulfilled[sessionId]) return;

  const order = {
    receivedAt: new Date().toISOString(),
    eventId: clean(eventId, 200),
    sessionId,
    paymentMethod: 'card',
    paymentStatus: session.payment_status,
    publicTokenHash: session.metadata?.publicTokenHash || '',
    customerEmail: session.customer_details?.email || session.customer_email || '',
    websiteUrl: session.metadata?.websiteUrl || '',
    businessType: session.metadata?.businessType || '',
    primaryGoal: session.metadata?.primaryGoal || '',
    primaryService: session.metadata?.primaryService || '',
    sourceLeadId: session.metadata?.sourceLeadId || '',
    amountTotal: session.amount_total,
    currency: session.currency
  };

  appendNdjson('orders.ndjson', order);
  const preparedAuditUrl = preparedAuditForLead(order.sourceLeadId, order.customerEmail);
  updateEntityState('order', order.sessionId, preparedAuditUrl
    ? { status:'ready', deliveryUrl:preparedAuditUrl, adminNote:'' }
    : { status: readAdminSettings().defaultOrderStatus || 'paid', adminNote:'' }
  );
  logAdminEvent('paid_order_received', { entityId:order.sessionId, email:order.customerEmail, websiteUrl:order.websiteUrl, amountTotal:order.amountTotal, currency:order.currency });

  // Mark fulfilled atomically enough for a single-instance MVP.
  fulfilled[sessionId] = { fulfilledAt: order.receivedAt, eventId: order.eventId };
  const tmp = `${fulfilledFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(fulfilled, null, 2), 'utf8');
  fs.renameSync(tmp, fulfilledFile);

  await sendOptionalWebhook('paid_order', order);
}

async function sendOptionalWebhook(type, payload) {
  const url = clean(process.env.NOTIFICATION_WEBHOOK_URL || '', 1000);
  if (!url) return;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'qonvexa', type, payload }),
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) console.error(`Notification webhook returned ${response.status}`);
  } catch (err) {
    console.error('Notification webhook failed:', err.message);
  }
}

function appendNdjson(filename, value) {
  fs.mkdirSync(storageDir, { recursive: true });
  fs.appendFileSync(path.join(storageDir, filename), JSON.stringify(value) + '\n', 'utf8');
}

function sendHtml(res, filename) {
  const candidates = [
    path.join(publicDir, filename),
    path.join(__dirname, filename) // deployment-safe fallback for index.html
  ];
  const file = candidates.find(candidate => fs.existsSync(candidate));

  if (!file) {
    const detail = `HTML file missing: ${filename}; checked ${candidates.join(' | ')}`;
    console.error(detail);
    return res.status(500).type('text').send('QONVEXA deployment error: required page is missing.');
  }

  try {
    const html = fs.readFileSync(file, 'utf8');
    const replacements = {
      '{{SITE_URL}}': escapeHtml(siteUrl),
      '{{CONTACT_EMAIL}}': escapeHtml(contactEmail),
      '{{LEGAL_BUSINESS_NAME}}': escapeHtml(process.env.LEGAL_BUSINESS_NAME || 'QONVEXA — pre-launch'),
      '{{LEGAL_ADDRESS}}': escapeHtml(process.env.LEGAL_ADDRESS || 'Legal operator details will be published before paid checkout is enabled.'),
      '{{LEGAL_JURISDICTION}}': escapeHtml(process.env.LEGAL_JURISDICTION || 'Ukraine'),
      '{{DELIVERY_TIMEFRAME}}': escapeHtml(process.env.DELIVERY_TIMEFRAME || 'Paid checkout is not enabled until a delivery timeframe is published.'),
      '{{REFUND_POLICY_TEXT}}': escapeHtml(process.env.REFUND_POLICY_TEXT || 'Paid checkout is not enabled until final refund and cancellation terms are published. For questions, contact hello@qonvexa.co.'),
      '{{LAST_UPDATED}}': escapeHtml(process.env.LEGAL_LAST_UPDATED || new Date().toISOString().slice(0, 10)),
      '{{LEGAL_ROBOTS}}': escapeHtml(isLiveLaunch ? 'index,follow' : 'noindex,nofollow')
    };
    let output = html;
    for (const [token, value] of Object.entries(replacements)) output = output.split(token).join(value);
    res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    res.setHeader('X-QONVEXA-Version', appVersion);
    res.type('html').send(output);
  } catch (err) {
    console.error(`Failed to render ${filename}:`, err);
    res.status(500).type('text').send('QONVEXA deployment error: page could not be rendered.');
  }
}


function requireSameSiteMutation(req, res, next) {
  const fetchSite = String(req.get('sec-fetch-site') || '').toLowerCase();
  if (fetchSite && !['same-origin','same-site','none'].includes(fetchSite)) {
    return res.status(403).json({ error: 'Cross-site request blocked.' });
  }
  const origin = req.get('origin');
  if (origin) {
    try {
      if (new URL(origin).host !== req.get('host')) {
        return res.status(403).json({ error: 'Origin mismatch.' });
      }
    } catch {
      return res.status(403).json({ error: 'Invalid request origin.' });
    }
  }
  next();
}

setInterval(() => {
  const now = Date.now();
  for (const [key, session] of adminSessions) {
    if (now >= session.expiresAt) adminSessions.delete(key);
  }
}, 30 * 60 * 1000).unref();

function parseCookies(header = '') {
  const result = {};
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) result[key] = decodeURIComponent(value);
  }
  return result;
}

function adminSessionKey(token) {
  return crypto.createHmac('sha256', adminSessionSecret || 'development-admin-secret')
    .update(String(token || ''))
    .digest('hex');
}

function createAdminSession() {
  const token = crypto.randomBytes(32).toString('hex');
  adminSessions.set(adminSessionKey(token), { createdAt: Date.now(), expiresAt: Date.now() + adminSessionTtlMs });
  return token;
}

function getAdminSession(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  const token = cookies.qonvexa_admin || '';
  const key = adminSessionKey(token);
  const session = adminSessions.get(key);
  if (!session) return null;
  if (Date.now() >= session.expiresAt) {
    adminSessions.delete(key);
    return null;
  }
  return { token, key, ...session };
}

function requireAdmin(req, res, next) {
  if (getAdminSession(req)) return next();
  const bearer=String(req.get('authorization')||'').match(/^Bearer\s+(.+)$/i)?.[1]||'';
  if(!bearer||!process.env.AUTH0_DOMAIN||!process.env.AUTH0_AUDIENCE)return res.status(401).json({ error: 'Unauthorized' });
  verifyAuth0Bearer(bearer,process.env).then(result=>{
    if(!result.ok)return res.status(401).json({error:'Unauthorized'});
    const requiredPermission=String(process.env.AUTH0_ADMIN_PERMISSION||'').trim();
    const requiredRole=String(process.env.AUTH0_ADMIN_ROLE||'').trim();
    const scopes=new Set(String(result.scope||'').split(/\s+/).filter(Boolean));
    const permissions=new Set(Array.isArray(result.permissions)?result.permissions.map(String):[]);
    const hasPermission=!requiredPermission||permissions.has(requiredPermission)||scopes.has(requiredPermission);
    const roles=new Set(Array.isArray(result.roles)?result.roles.map(String):[]);
    const hasRole=!requiredRole||roles.has(requiredRole);
    if(!hasPermission||!hasRole)return res.status(403).json({error:'Forbidden'});
    req.auth0=result;next();
  }).catch(()=>res.status(401).json({error:'Unauthorized'}));
}

function safeCredentialEqual(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function readNdjson(filename) {
  const file = path.join(storageDir, filename);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}


function readJson(filename, fallback = {}) {
  const file = path.join(storageDir, filename);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJsonAtomic(filename, value) {
  fs.mkdirSync(storageDir, { recursive:true });
  const file = path.join(storageDir, filename);
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2,10)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function readAdminSettings() {
  return {
    ownerDisplayName: '',
    domainEmail: '',
    notificationEmail: '',
    defaultLeadStatus: 'new',
    defaultOrderStatus: 'paid',
    ...readJson('admin-settings.json', {})
  };
}

function stateFilename(type) {
  return type === 'order' ? 'order-state.json' : 'lead-state.json';
}

function updateEntityState(type, id, patch = {}) {
  if (!id) throw new Error('Entity ID required.');
  const filename = stateFilename(type);
  const all = readJson(filename, {});
  const prev = all[id] || {};
  const next = {
    ...prev,
    ...Object.fromEntries(Object.entries(patch).filter(([,v]) => v !== undefined)),
    updatedAt: new Date().toISOString()
  };
  all[id] = next;
  writeJsonAtomic(filename, all);
  return next;
}

function withEntityState(items, type) {
  const states = readJson(stateFilename(type), {});
  const defaults = readAdminSettings();
  return items.map(item => {
    const id = type === 'order' ? item.sessionId : item.id;
    const state = states[id] || {};
    return {
      ...item,
      status: state.status || (type === 'order'
        ? (item.paymentStatus === 'paid' ? defaults.defaultOrderStatus : 'awaiting_payment')
        : defaults.defaultLeadStatus),
      adminNote: state.adminNote || '',
      miniAuditTitle: type === 'lead' ? (state.miniAuditTitle || '') : undefined,
      miniAuditSummary: type === 'lead' ? (state.miniAuditSummary || '') : undefined,
      miniAuditFindings: type === 'lead' ? (state.miniAuditFindings || '') : undefined,
      preparedAuditUrl: type === 'lead' ? (state.preparedAuditUrl || '') : undefined,
      deliveryUrl: type === 'order' ? (state.deliveryUrl || '') : undefined,
      statusUpdatedAt: state.updatedAt || ''
    };
  });
}

function buildClients(previews, orders) {
  const map = new Map();
  const touch = (email, patch) => {
    const key = String(email || '').trim().toLowerCase();
    if (!key) return;
    const current = map.get(key) || {
      email:key, websiteUrl:'', businessType:'', firstSeenAt:'', lastSeenAt:'',
      previewCount:0, orderCount:0, totalPaidCents:0, currency:'usd',
      latestLeadStatus:'', latestOrderStatus:''
    };
    Object.assign(current, Object.fromEntries(Object.entries(patch).filter(([,v]) => v !== undefined && v !== '')));
    map.set(key, current);
  };
  for (const lead of previews) {
    const email = lead.email;
    const date = lead.receivedAt || '';
    const key = String(email || '').trim().toLowerCase();
    const current = map.get(key);
    touch(email, {
      websiteUrl: lead.websiteUrl,
      businessType: lead.businessType,
      firstSeenAt: current?.firstSeenAt || date,
      lastSeenAt: !current?.lastSeenAt || date > current.lastSeenAt ? date : current.lastSeenAt,
      previewCount: (current?.previewCount || 0) + 1,
      latestLeadStatus: lead.status
    });
  }
  for (const order of orders) {
    const email = order.customerEmail;
    const date = order.receivedAt || '';
    const key = String(email || '').trim().toLowerCase();
    const current = map.get(key);
    touch(email, {
      websiteUrl: order.websiteUrl,
      businessType: order.businessType,
      firstSeenAt: current?.firstSeenAt || date,
      lastSeenAt: !current?.lastSeenAt || date > current.lastSeenAt ? date : current.lastSeenAt,
      orderCount: (current?.orderCount || 0) + 1,
      totalPaidCents: (current?.totalPaidCents || 0) + (isOrderPaid(order) ? Number(order.amountTotal || 0) : 0),
      currency: order.currency || current?.currency || 'usd',
      latestOrderStatus: order.status
    });
  }
  return [...map.values()].sort((a,b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)));
}

function logAdminEvent(type, payload = {}) {
  appendNdjson('admin-events.ndjson', {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    type: clean(type, 80),
    ...payload
  });
}

function csvEscape(value) {
  let s = String(value ?? '');
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) return `"${s.replaceAll('"','""')}"`;
  return s;
}

function toCsv(headers, rows) {
  const lines = [headers.map(csvEscape).join(',')];
  for (const row of rows) lines.push(headers.map(h => csvEscape(row[h])).join(','));
  return lines.join('\r\n');
}


function manualPaymentConfig() {
  const details = {
    beneficiary: clean(process.env.BANK_BENEFICIARY || '', 300),
    bankName: clean(process.env.BANK_NAME || '', 300),
    account: clean(process.env.BANK_ACCOUNT || '', 300),
    iban: clean(process.env.BANK_IBAN || '', 100),
    swift: clean(process.env.BANK_SWIFT || '', 100),
    currency: clean(process.env.BANK_CURRENCY || 'USD', 10).toUpperCase(),
    note: clean(process.env.BANK_PAYMENT_NOTE || 'Use your QONVEXA order reference in the payment memo.', 500)
  };
  const hasDestination = Boolean(details.iban || details.account);
  return {
    enabled: manualPaymentEnabled && Boolean(details.beneficiary) && hasDestination,
    details
  };
}

function hashOrderToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function isOrderPaid(order) {
  if (!order) return false;
  if (order.paymentStatus === 'paid') return true;
  return order.paymentMethod === 'bank_transfer' &&
    ['paid','queued','in_progress','ready','delivered'].includes(order.status);
}

function isPersistentStorage() {
  const normalized = storageDir.replaceAll('\\', '/');
  return normalized === '/var/lib/qonvexa/data' || normalized.startsWith('/var/lib/qonvexa/');
}

function publicStripeSessionPayload(session) {
  const paid = session.payment_status === 'paid';
  return {
    orderId: session.id,
    paymentMethod: 'card',
    paymentStatus: session.payment_status || 'pending',
    status: paid ? 'paid' : 'awaiting_payment',
    websiteUrl: session.metadata?.websiteUrl || '',
    customerEmail: session.customer_details?.email || session.customer_email || '',
    amountTotal: session.amount_total,
    currency: session.currency || 'usd',
    createdAt: session.created ? new Date(session.created * 1000).toISOString() : '',
    delivery: {
      state: paid ? 'preparing' : 'waiting_for_payment',
      url: '',
      message: paid
        ? 'Payment is confirmed. Your personalized audit is now in preparation.'
        : 'We are waiting for payment confirmation.'
    }
  };
}

function readAllOrders() {
  return readNdjson('orders.ndjson');
}

function resolveSourceLeadId(sourceLeadId, email) {
  const id = clean(sourceLeadId || '', 120);
  const normalizedEmail = clean(email || '', 320).toLowerCase();
  if (!id || !normalizedEmail) return '';
  const lead = readNdjson('preview-requests.ndjson').find(item =>
    item.id === id && String(item.email || '').trim().toLowerCase() === normalizedEmail
  );
  return lead ? id : '';
}

function preparedAuditForLead(sourceLeadId, email) {
  const id = resolveSourceLeadId(sourceLeadId, email);
  if (!id) return '';
  const state = readJson('lead-state.json', {})[id] || {};
  const url = clean(state.preparedAuditUrl || '', 1000);
  return isValidHttpUrl(url) ? url : '';
}

function getOrderByAccessToken(token) {
  const tokenHash = hashOrderToken(token);
  return readAllOrders().find(order => order.publicTokenHash === tokenHash) || null;
}

function effectiveOrderState(order) {
  const states = readJson('order-state.json', {});
  const state = states[order.sessionId] || {};
  const operationalStatus = state.status || (order.paymentStatus === 'paid' ? 'paid' : 'awaiting_payment');
  const manualPaid = order.paymentMethod === 'bank_transfer' &&
    ['paid','queued','in_progress','ready','delivered'].includes(operationalStatus);
  return {
    operationalStatus,
    paymentStatus: order.paymentStatus === 'paid' || manualPaid ? 'paid' : order.paymentStatus
  };
}

function publicOrderPayload(order) {
  const state = effectiveOrderState(order);
  const paid = state.paymentStatus === 'paid';
  const states = readJson('order-state.json', {});
  const deliveryUrl = clean(states[order.sessionId]?.deliveryUrl || '', 1000);
  const deliveryAvailable = paid && isValidHttpUrl(deliveryUrl) &&
    ['ready','delivered'].includes(state.operationalStatus);

  return {
    orderId: order.sessionId,
    paymentMethod: order.paymentMethod || 'card',
    paymentStatus: state.paymentStatus,
    status: state.operationalStatus,
    websiteUrl: order.websiteUrl || '',
    customerEmail: order.customerEmail || '',
    amountTotal: order.amountTotal,
    currency: order.currency || 'usd',
    createdAt: order.receivedAt || '',
    delivery: paid ? {
      state: deliveryAvailable ? 'available' : 'preparing',
      url: deliveryAvailable ? deliveryUrl : '',
      message: deliveryAvailable
        ? 'Your full QONVEXA audit is ready. You can open it now.'
        : `Payment is confirmed. Your full audit will be prepared within 1–24 hours and delivered to ${order.customerEmail || 'your email'}.`
    } : {
      state: 'waiting_for_payment',
      url: '',
      message: 'We are waiting for payment confirmation.'
    }
  };
}

function validateProductionConfig() {
  const allowedModes = ['development','staging','live'];
  if (!allowedModes.includes(launchMode)) {
    throw new Error(`Invalid LAUNCH_MODE: ${launchMode}`);
  }
  if (!isProduction) return;

  const requiredForAnyProduction = ['ADMIN_USERNAME','ADMIN_PASSWORD','ADMIN_SESSION_SECRET','IP_HASH_SALT'];
  const missing = requiredForAnyProduction.filter(key => !String(process.env[key] || '').trim());

  if (adminPassword && adminPassword.length < 14) missing.push('ADMIN_PASSWORD must be at least 14 characters');
  if (adminSessionSecret && adminSessionSecret.length < 32) missing.push('ADMIN_SESSION_SECRET must be at least 32 characters');
  if (String(process.env.IP_HASH_SALT || '').length < 24) missing.push('IP_HASH_SALT must be at least 24 characters');

  if (isLiveLaunch) {
    const requiredForLive = [
      'SITE_URL','CONTACT_EMAIL',
      'LEGAL_BUSINESS_NAME','LEGAL_ADDRESS','LEGAL_JURISDICTION',
      'DELIVERY_TIMEFRAME','REFUND_POLICY_TEXT'
    ];
    missing.push(...requiredForLive.filter(key => !String(process.env[key] || '').trim()));
    if (!/^https:\/\//i.test(process.env.SITE_URL || '')) missing.push('SITE_URL must use https:// in live mode');

    if (!isPersistentStorage()) {
      console.warn('WARNING: STORAGE_DIR is not on persistent storage. Orders/leads will be lost on the next deploy or container restart until a persistent disk is attached.');
    }
    const manual = manualPaymentConfig();
    const hasStripe = Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET);
    if (!hasStripe && !manual.enabled) missing.push('At least one live payment method must be configured');
    if (hasStripe && /^sk_test_/i.test(process.env.STRIPE_SECRET_KEY || '')) missing.push('STRIPE_SECRET_KEY must be a live key in live mode');
  }

  if (missing.length) {
    throw new Error(`Production configuration incomplete: ${[...new Set(missing)].join(', ')}`);
  }
}

function verifyPublicAssets() {
  const required = [
    'index.html', 'styles.css', 'app.js',
    'admin.html', 'admin.css', 'admin.js',
    'privacy.html', 'terms.html', 'refund.html',
    'success.html', 'success.js', 'order.html', 'order.js', 'favicon.svg'
  ];
  const missing = required.filter(file => !fs.existsSync(path.join(publicDir, file)));
  if (missing.length) {
    throw new Error(`Deployment package incomplete. Missing public files: ${missing.join(', ')}`);
  }
  console.log(`Public assets verified: ${required.length} required files in ${publicDir}`);
}

function pubPath() { return publicDir; }
function hashIp(ip) {
  return crypto.createHash('sha256')
    .update(`${process.env.IP_HASH_SALT || 'development-salt'}:${ip || ''}`)
    .digest('hex').slice(0, 24);
}
function clean(value, max) { return String(value || '').trim().slice(0, max); }
function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}
function isValidHttpUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    return (url.protocol === 'http:' || url.protocol === 'https:') && Boolean(url.hostname);
  } catch { return false; }
}
function normalizeSiteUrl(value) { return String(value).replace(/\/+$/, ''); }
function safeInteger(value, fallback, min, max) {
  const n = Number(value ?? fallback);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`Invalid integer configuration value: ${value}`);
  }
  return n;
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

app.listen(port, '0.0.0.0', () => {
  console.log(`QONVEXA + AutonomOS running at ${siteUrl}`);
  console.log(`Storage: ${storageDir}`);
});
