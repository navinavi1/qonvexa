const navToggle = document.querySelector('.nav-toggle');
const primaryNav = document.querySelector('#primary-nav');

function setMobileNav(open) {
  if (!navToggle || !primaryNav) return;
  navToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  navToggle.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
  primaryNav.classList.toggle('open', open);
  document.body.classList.toggle('nav-open', open);
}
navToggle?.addEventListener('click', () => setMobileNav(navToggle.getAttribute('aria-expanded') !== 'true'));
primaryNav?.querySelectorAll('a').forEach(link => link.addEventListener('click', () => setMobileNav(false)));
document.addEventListener('keydown', event => { if (event.key === 'Escape') setMobileNav(false); });
window.addEventListener('resize', () => { if (window.innerWidth > 900) setMobileNav(false); });

const industryData = {
  dental: {
    title: 'Dental practices',
    copy: 'Find where potential patients may drop out before booking — from treatment-page clarity to mobile appointment paths, trust, insurance information and new-patient flow.',
    pills: ['Appointment journey','Mobile booking','Treatment pages','Trust signals','New-patient flow']
  },
  legal: {
    title: 'Law firms',
    copy: 'Find the friction between a potential client needing help and contacting your firm — including consultation CTAs, attorney credibility, intake flow and practice-area clarity.',
    pills: ['Consultation CTA','Mobile calling','Attorney credibility','Intake friction','Practice areas']
  },
  medical: {
    title: 'Medical clinics',
    copy: 'Make it easier for high-intent patients to go from searching to booking through clearer services, provider trust, appointment paths and patient information.',
    pills: ['Appointment flow','Provider trust','Service clarity','Insurance info','Contact friction']
  },
  aesthetics: {
    title: 'Plastic surgery & aesthetics',
    copy: 'Identify what may stop a high-value prospect from requesting a consultation — with special attention to trust, financing clarity, proof and treatment journeys.',
    pills: ['Consultation funnel','Provider credibility','Before & after','Financing clarity','Lead forms']
  },
  hvac: {
    title: 'HVAC & home services',
    copy: 'Reduce the distance between “I need help” and “Call / Book / Request Service” by reviewing urgency, mobile click-to-call, quote paths and local trust.',
    pills: ['Call-now flow','Emergency CTA','Quote form','Service areas','Local trust']
  },
  financial: {
    title: 'Financial advisors',
    copy: 'Identify the trust, positioning and first-contact friction that may prevent a qualified prospect from scheduling an initial conversation.',
    pills: ['Advisor credibility','Offer clarity','Consultation funnel','Differentiation','Lead forms']
  }
};

const tabs = [...document.querySelectorAll('.tab')];
const industryPanel = document.querySelector('#industry-panel');
tabs.forEach((btn, index) => {
  btn.setAttribute('aria-selected', btn.classList.contains('active') ? 'true' : 'false');
  btn.setAttribute('tabindex', btn.classList.contains('active') ? '0' : '-1');
  btn.setAttribute('aria-controls', 'industry-panel');
  btn.addEventListener('click', () => activateIndustryTab(btn));
  btn.addEventListener('keydown', (event) => {
    if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
    event.preventDefault();
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = tabs.length - 1;
    tabs[next].focus();
    activateIndustryTab(tabs[next]);
  });
});
if (industryPanel) {
  industryPanel.setAttribute('role', 'tabpanel');
  industryPanel.setAttribute('aria-live', 'polite');
}
function activateIndustryTab(btn) {
  tabs.forEach(x => {
    const active = x === btn;
    x.classList.toggle('active', active);
    x.setAttribute('aria-selected', active ? 'true' : 'false');
    x.setAttribute('tabindex', active ? '0' : '-1');
  });
  const item = industryData[btn.dataset.target];
  document.querySelector('#industry-title').textContent = item.title;
  document.querySelector('#industry-copy').textContent = item.copy;
  document.querySelector('#industry-pills').innerHTML = item.pills.map(p => `<span>${p}</span>`).join('');
}


const previewForm = document.querySelector('#preview-form');
const previewStatus = document.querySelector('#preview-status');

previewForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  previewStatus.textContent = 'Submitting…';
  const payload = Object.fromEntries(new FormData(previewForm).entries());

  try {
    const r = await fetch('/api/preview-request', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify(payload)
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Could not submit request.');
    previewStatus.textContent = 'Request received. Your preview can now be prepared for this website.';
    previewForm.reset();
  } catch (err) {
    previewStatus.textContent = err.message;
  }
});

const dialog = document.querySelector('#checkout-dialog');
const checkoutForm = document.querySelector('#checkout-form');
const checkoutStatus = document.querySelector('#checkout-status');
const paymentOptions = document.querySelector('#payment-options');
const confirmation = document.querySelector('#purchase-confirmation');

let purchaseOptions = null;
let currentPurchaseStep = 1;
const purchaseDraftKey = 'qonvexa_purchase_draft_v1';

document.querySelector('#open-checkout')?.addEventListener('click', async () => {
  restorePurchaseDraft();
  showPurchaseStep(1);
  dialog?.showModal();
  await loadPurchaseOptions();
});
document.querySelector('#close-checkout')?.addEventListener('click', () => dialog?.close());
document.querySelector('#finish-purchase')?.addEventListener('click', () => dialog?.close());

dialog?.addEventListener('click', (event) => {
  if (event.target === dialog) dialog.close();
});

checkoutForm?.addEventListener('input', savePurchaseDraft);

document.querySelectorAll('[data-next]').forEach(button => button.addEventListener('click', async () => {
  const next = Number(button.dataset.next || 1);
  if (currentPurchaseStep === 1 && !validatePurchaseDetails()) return;
  if (next === 2) renderPurchaseReview();
  if (next === 3) await loadPurchaseOptions();
  showPurchaseStep(next);
}));

document.querySelectorAll('[data-prev]').forEach(button => button.addEventListener('click', () => {
  showPurchaseStep(Number(button.dataset.prev || 1));
}));

function showPurchaseStep(step) {
  currentPurchaseStep = step;
  document.querySelectorAll('.purchase-step').forEach(section => {
    const active = Number(section.dataset.step) === step;
    section.hidden = !active;
    section.classList.toggle('active', active);
  });
  document.querySelectorAll('[data-progress]').forEach(item => {
    const n = Number(item.dataset.progress);
    const active = n === step;
    item.classList.toggle('active', active);
    item.classList.toggle('done', n < step);
    if (active) item.setAttribute('aria-current', 'step');
    else item.removeAttribute('aria-current');
  });
  const activeSection = dialog?.querySelector('.purchase-step.active');
  activeSection?.scrollIntoView({ block:'nearest' });
  const heading = activeSection?.querySelector('h3');
  if (heading && step > 1) {
    heading.setAttribute('tabindex', '-1');
    requestAnimationFrame(() => heading.focus({ preventScroll:true }));
  }
}

function validatePurchaseDetails() {
  const fields = [...checkoutForm.querySelectorAll('[data-step="1"] input[required], [data-step="1"] select[required]')];
  let valid = true;
  fields.forEach(field => {
    if (!field.reportValidity()) valid = false;
  });
  return valid;
}

function purchasePayload() {
  const data = Object.fromEntries(new FormData(checkoutForm).entries());
  return {
    websiteUrl: data.websiteUrl || '',
    email: data.email || '',
    businessType: data.businessType || '',
    primaryGoal: data.primaryGoal || '',
    primaryService: data.primaryService || ''
  };
}

function renderPurchaseReview() {
  const p = purchasePayload();
  const review = document.querySelector('#purchase-review');
  if (!review) return;
  review.innerHTML = `
    <div><span>Website</span><b>${escHtml(p.websiteUrl)}</b></div>
    <div><span>Delivery email</span><b>${escHtml(p.email)}</b></div>
    <div><span>Business</span><b>${escHtml(p.businessType || 'Not specified')}</b></div>
    <div><span>Primary goal</span><b>${escHtml(p.primaryGoal || 'Not specified')}</b></div>
    <div><span>Primary service</span><b>${escHtml(p.primaryService || 'Not specified')}</b></div>
    <div class="review-total"><span>Total</span><b>$149 one-time</b></div>
  `;
}

async function loadPurchaseOptions() {
  if (!paymentOptions) return;
  paymentOptions.innerHTML = '<div class="payment-loading">Checking available payment methods…</div>';
  checkoutStatus.textContent = '';
  try {
    const response = await fetch('/api/purchase-options', { headers:{accept:'application/json'}, cache:'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not load payment methods.');
    purchaseOptions = data;
    renderPaymentOptions(data);
  } catch (err) {
    paymentOptions.innerHTML = `<div class="payment-unavailable"><b>Payment setup is being finalized.</b><span>${escHtml(err.message)}</span><a href="mailto:hello@qonvexa.co">Contact hello@qonvexa.co</a></div>`;
  }
}

function renderPaymentOptions(options) {
  const methods = [];
  if (options.methods?.card?.available) {
    methods.push(`
      <button type="button" class="payment-method" data-pay="card">
        <span class="payment-icon">↗</span>
        <span><b>Pay securely by card</b><small>Continue to the secure hosted checkout.</small></span>
        <strong>${money(options.priceCents, options.currency)}</strong>
      </button>`);
  }
  if (options.methods?.bankTransfer?.available) {
    methods.push(`
      <button type="button" class="payment-method" data-pay="bank">
        <span class="payment-icon">⌁</span>
        <span><b>Bank transfer</b><small>Create an order reference and receive payment instructions.</small></span>
        <strong>${money(options.priceCents, options.currency)}</strong>
      </button>`);
  }
  if (!methods.length) {
    paymentOptions.innerHTML = `
      <div class="payment-unavailable">
        <b>Online payment activation is in progress.</b>
        <span>Your order details are safe. Contact us if you want to continue manually.</span>
        <a href="mailto:${escAttr(options.contactEmail || 'hello@qonvexa.co')}">${escHtml(options.contactEmail || 'hello@qonvexa.co')}</a>
      </div>`;
    return;
  }
  paymentOptions.innerHTML = methods.join('');
  paymentOptions.querySelector('[data-pay="card"]')?.addEventListener('click', startCardCheckout);
  paymentOptions.querySelector('[data-pay="bank"]')?.addEventListener('click', startBankTransfer);
}

async function startCardCheckout() {
  if (!validatePurchaseDetails()) { showPurchaseStep(1); return; }
  checkoutStatus.textContent = 'Opening secure checkout…';
  setPaymentButtonsDisabled(true);
  try {
    const response = await fetch('/api/create-checkout-session', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify(purchasePayload())
    });
    const data = await response.json();
    if (!response.ok || !data.url) throw new Error(data.error || 'Could not start secure checkout.');
    sessionStorage.removeItem(purchaseDraftKey);
    location.href = data.url;
  } catch (err) {
    checkoutStatus.textContent = err.message;
  } finally {
    setPaymentButtonsDisabled(false);
  }
}

async function startBankTransfer() {
  if (!validatePurchaseDetails()) { showPurchaseStep(1); return; }
  checkoutStatus.textContent = 'Creating your order reference…';
  setPaymentButtonsDisabled(true);
  try {
    const response = await fetch('/api/manual-order', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify(purchasePayload())
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not create bank-transfer order.');
    sessionStorage.removeItem(purchaseDraftKey);
    renderPurchaseConfirmation(data);
    showPurchaseStep(4);
  } catch (err) {
    checkoutStatus.textContent = err.message;
  } finally {
    setPaymentButtonsDisabled(false);
  }
}

function renderPurchaseConfirmation(data) {
  const d = data.bankDetails || {};
  confirmation.innerHTML = `
    <div class="confirmation-order">
      <span>Order reference</span>
      <b>${escHtml(data.orderId)}</b>
      <button type="button" class="copy-button" data-copy="${escAttr(data.orderId)}">Copy reference</button>
    </div>
    <div class="bank-details">
      <div><span>Amount</span><b>${money(data.amountTotal,data.currency)}</b></div>
      ${d.beneficiary ? `<div><span>Beneficiary</span><b>${escHtml(d.beneficiary)}</b></div>` : ''}
      ${d.bankName ? `<div><span>Bank</span><b>${escHtml(d.bankName)}</b></div>` : ''}
      ${d.iban ? `<div><span>IBAN</span><b>${escHtml(d.iban)}</b></div>` : ''}
      ${d.account ? `<div><span>Account</span><b>${escHtml(d.account)}</b></div>` : ''}
      ${d.swift ? `<div><span>SWIFT / BIC</span><b>${escHtml(d.swift)}</b></div>` : ''}
      ${d.note ? `<div class="bank-note"><span>Payment memo</span><b>${escHtml(data.orderId)}</b><small>${escHtml(d.note)}</small></div>` : ''}
    </div>
    <a class="button full" href="${escAttr(data.statusUrl)}">Open order status</a>
    <p class="fine">Keep this private status link. It updates after payment confirmation.</p>
  `;
  confirmation.querySelector('[data-copy]')?.addEventListener('click', async (e) => {
    try {
      await navigator.clipboard.writeText(e.currentTarget.dataset.copy || '');
      e.currentTarget.textContent = 'Copied';
    } catch {}
  });
}

function setPaymentButtonsDisabled(disabled) {
  paymentOptions?.querySelectorAll('button').forEach(button => button.disabled = disabled);
}

function savePurchaseDraft() {
  try { sessionStorage.setItem(purchaseDraftKey, JSON.stringify(purchasePayload())); } catch {}
}
function restorePurchaseDraft() {
  try {
    const draft = JSON.parse(sessionStorage.getItem(purchaseDraftKey) || '{}');
    Object.entries(draft).forEach(([key,value]) => {
      const field = checkoutForm?.elements?.[key];
      if (field && value) field.value = value;
    });
  } catch {}
}
function money(amount,currency='USD') {
  try { return new Intl.NumberFormat('en-US',{style:'currency',currency:String(currency).toUpperCase()}).format(Number(amount||0)/100); }
  catch { return `$${(Number(amount||0)/100).toFixed(2)}`; }
}
function escHtml(value='') {
  return String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function escAttr(value='') { return escHtml(value); }


const yearEl = document.querySelector('#year'); if (yearEl) yearEl.textContent = new Date().getFullYear();

const revealItems = document.querySelectorAll('.reveal');
const revealObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.classList.add('is-visible');
      revealObserver.unobserve(entry.target);
    }
  });
}, { threshold: 0.15, rootMargin: '0px 0px -40px 0px' });
revealItems.forEach(el => revealObserver.observe(el));

function animateCount(el, target, duration = 1300) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    el.textContent = target;
    return;
  }
  const startValue = Number(el.textContent || 0);
  if (startValue === target) return;
  const start = performance.now();
  function tick(now) {
    const progress = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - progress, 3);
    el.textContent = Math.round(startValue + (target - startValue) * eased);
    if (progress < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

document.querySelectorAll('.hero-card, .price-card').forEach(card => {
  const countEls = card.querySelectorAll('.count-up');
  const meter = card.querySelector('.meter i');
  const cardObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      countEls.forEach(el => animateCount(el, Number(el.dataset.count || 0)));
      if (meter) meter.style.width = `${meter.dataset.fill || 0}%`;
      cardObserver.unobserve(entry.target);
    });
  }, { threshold: 0.4 });
  cardObserver.observe(card);
});
