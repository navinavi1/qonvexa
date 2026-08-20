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
document.querySelector('#open-checkout')?.addEventListener('click', () => dialog?.showModal());
document.querySelector('#close-checkout')?.addEventListener('click', () => dialog?.close());

const checkoutForm = document.querySelector('#checkout-form');
const checkoutStatus = document.querySelector('#checkout-status');

checkoutForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  checkoutStatus.textContent = 'Opening secure checkout…';
  const button = checkoutForm.querySelector('button[type="submit"]');
  button.disabled = true;

  try {
    const payload = Object.fromEntries(new FormData(checkoutForm).entries());
    const r = await fetch('/api/create-checkout-session', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify(payload)
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Could not start checkout.');
    window.location.assign(data.url);
  } catch (err) {
    checkoutStatus.textContent = err.message;
    button.disabled = false;
  }
});

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
