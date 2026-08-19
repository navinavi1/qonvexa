import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import Stripe from 'stripe';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = safeInteger(process.env.PORT, 3000, 1, 65535);
const isProduction = process.env.NODE_ENV === 'production';
const launchMode = clean(process.env.LAUNCH_MODE || (isProduction ? 'staging' : 'development'), 20).toLowerCase();
const isLiveLaunch = launchMode === 'live';
const siteUrl = normalizeSiteUrl(process.env.SITE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${port}`);
const priceCents = safeInteger(process.env.AUDIT_PRICE_CENTS, 14900, 50, 10000000);
const storageDir = path.resolve(process.env.STORAGE_DIR || path.join(__dirname, 'data'));
const contactEmail = clean(process.env.CONTACT_EMAIL || '', 320);
const adminUsername = clean(process.env.ADMIN_USERNAME || 'admin', 120);
const adminPassword = String(process.env.ADMIN_PASSWORD || '');
const adminSessionSecret = String(process.env.ADMIN_SESSION_SECRET || '');
const adminSessionTtlMs = 12 * 60 * 60 * 1000;
const adminSessions = new Map();

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

validateProductionConfig();
fs.mkdirSync(storageDir, { recursive: true });

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

// Dynamic HTML routes allow production metadata/legal values to come from environment config.
for (const route of ['/', '/index.html']) {
  app.get(route, (_req, res) => sendHtml(res, 'index.html'));
}
app.get('/privacy.html', (_req, res) => sendHtml(res, 'privacy.html'));
app.get('/terms.html', (_req, res) => sendHtml(res, 'terms.html'));
app.get('/refund.html', (_req, res) => sendHtml(res, 'refund.html'));
app.get('/success.html', (_req, res) => sendHtml(res, 'success.html'));

app.use(express.static(pubPath(), {
  extensions: ['html'],
  maxAge: isProduction ? '1d' : 0,
  etag: true,
  setHeaders(res, filePath) {
    if (/\.(css|js|png|svg|woff2?)$/i.test(filePath)) {
      res.setHeader('Cache-Control', isProduction ? 'public, max-age=86400' : 'no-cache');
    }
  }
}));



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
      paidOrders: orders.length,
      clients: clients.length,
      openLeads: previews.filter(x => !['closed','won','lost'].includes(x.status)).length,
      activeOrders: orders.filter(x => !['delivered','refunded','cancelled'].includes(x.status)).length
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
      storageDir,
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
  if (status && !allowed.includes(status)) return res.status(400).json({ error: 'Invalid lead status.' });
  const exists = readNdjson('preview-requests.ndjson').some(item => item.id === id);
  if (!exists) return res.status(404).json({ error: 'Lead not found.' });
  const state = updateEntityState('lead', id, { status: status || undefined, adminNote: note });
  logAdminEvent('lead_updated', { entityId:id, status:state.status });
  res.json({ ok:true, state });
});

app.patch('/api/admin/orders/:id', requireAdmin, requireSameSiteMutation, (req, res) => {
  const id = clean(req.params.id, 200);
  const allowed = ['paid','queued','in_progress','ready','delivered','refunded','cancelled'];
  const status = clean(req.body?.status || '', 40);
  const note = clean(req.body?.adminNote || '', 2000);
  if (status && !allowed.includes(status)) return res.status(400).json({ error: 'Invalid order status.' });
  const exists = readNdjson('orders.ndjson').some(item => item.sessionId === id);
  if (!exists) return res.status(404).json({ error: 'Order not found.' });
  const state = updateEntityState('order', id, { status: status || undefined, adminNote: note });
  logAdminEvent('order_updated', { entityId:id, status:state.status });
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

app.get('/health', (_req, res) => res.json({
  ok: true,
  environment: isProduction ? 'production' : 'development',
  launchMode,
  stripeConfigured: Boolean(stripe),
  storageConfigured: Boolean(storageDir)
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

app.post('/api/create-checkout-session',
  rateLimit({ windowMs: 15 * 60 * 1000, max: 12 }),
  async (req, res) => {
    if (!stripe) {
      return res.status(503).json({ error: 'Payments are not configured yet.' });
    }

    const {
      websiteUrl,
      businessType = '',
      primaryGoal = '',
      primaryService = '',
      email = ''
    } = req.body || {};

    if (!isValidHttpUrl(websiteUrl) || !isValidEmail(email)) {
      return res.status(400).json({ error: 'Please provide a valid website URL and email.' });
    }

    try {
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
          primaryService: clean(primaryService, 180)
        },
        success_url: `${siteUrl}/success.html?session_id={CHECKOUT_SESSION_ID}`,
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
    paymentStatus: session.payment_status,
    customerEmail: session.customer_details?.email || session.customer_email || '',
    websiteUrl: session.metadata?.websiteUrl || '',
    businessType: session.metadata?.businessType || '',
    primaryGoal: session.metadata?.primaryGoal || '',
    primaryService: session.metadata?.primaryService || '',
    amountTotal: session.amount_total,
    currency: session.currency
  };

  appendNdjson('orders.ndjson', order);
  updateEntityState('order', order.sessionId, { status: readAdminSettings().defaultOrderStatus || 'paid', adminNote:'' });
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
  try {
    const html = fs.readFileSync(path.join(pubPath(), filename), 'utf8');
    const replacements = {
      '{{SITE_URL}}': escapeHtml(siteUrl),
      '{{CONTACT_EMAIL}}': escapeHtml(contactEmail || 'CONTACT_EMAIL_NOT_CONFIGURED'),
      '{{LEGAL_BUSINESS_NAME}}': escapeHtml(process.env.LEGAL_BUSINESS_NAME || 'LEGAL_BUSINESS_NAME_NOT_CONFIGURED'),
      '{{LEGAL_ADDRESS}}': escapeHtml(process.env.LEGAL_ADDRESS || 'LEGAL_ADDRESS_NOT_CONFIGURED'),
      '{{LEGAL_JURISDICTION}}': escapeHtml(process.env.LEGAL_JURISDICTION || 'LEGAL_JURISDICTION_NOT_CONFIGURED'),
      '{{DELIVERY_TIMEFRAME}}': escapeHtml(process.env.DELIVERY_TIMEFRAME || 'DELIVERY_TIMEFRAME_NOT_CONFIGURED'),
      '{{REFUND_POLICY_TEXT}}': escapeHtml(process.env.REFUND_POLICY_TEXT || 'REFUND_POLICY_NOT_CONFIGURED'),
      '{{LAST_UPDATED}}': escapeHtml(process.env.LEGAL_LAST_UPDATED || new Date().toISOString().slice(0, 10))
    };
    let output = html;
    for (const [token, value] of Object.entries(replacements)) output = output.split(token).join(value);
    res.type('html').send(output);
  } catch {
    res.status(404).send('Not found');
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
  if (!getAdminSession(req)) return res.status(401).json({ error: 'Unauthorized' });
  next();
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
  const tmp = `${file}.tmp`;
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
      status: state.status || (type === 'order' ? defaults.defaultOrderStatus : defaults.defaultLeadStatus),
      adminNote: state.adminNote || '',
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
      totalPaidCents: (current?.totalPaidCents || 0) + Number(order.amountTotal || 0),
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
      'SITE_URL','STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET','CONTACT_EMAIL',
      'LEGAL_BUSINESS_NAME','LEGAL_ADDRESS','LEGAL_JURISDICTION',
      'DELIVERY_TIMEFRAME','REFUND_POLICY_TEXT'
    ];
    missing.push(...requiredForLive.filter(key => !String(process.env[key] || '').trim()));
    if (!/^https:\/\//i.test(process.env.SITE_URL || '')) missing.push('SITE_URL must use https:// in live mode');
    if (/^sk_test_/i.test(process.env.STRIPE_SECRET_KEY || '')) missing.push('STRIPE_SECRET_KEY must be a live key in live mode');
    if (/replace/i.test(process.env.STRIPE_WEBHOOK_SECRET || '')) missing.push('STRIPE_WEBHOOK_SECRET must be configured');
  }

  if (missing.length) {
    throw new Error(`Production configuration incomplete: ${[...new Set(missing)].join(', ')}`);
  }
}

function pubPath() { return path.join(__dirname, 'public'); }
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

app.listen(port, () => {
  console.log(`QONVEXA running at ${siteUrl}`);
  console.log(`Storage: ${storageDir}`);
});
