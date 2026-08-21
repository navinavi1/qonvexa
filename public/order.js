const token = new URLSearchParams(location.search).get('token') || '';
const title = document.querySelector('#order-title');
const message = document.querySelector('#order-message');
const card = document.querySelector('#order-card');
const refresh = document.querySelector('#refresh-order');
let autoRefreshTimer = null;

async function loadOrder() {
  if (!token) {
    title.textContent = 'Order link is incomplete';
    message.textContent = 'This status page needs the secure order token from your checkout confirmation.';
    return;
  }
  refresh.disabled = true;
  try {
    const response = await fetch(`/api/order-status?token=${encodeURIComponent(token)}`, {
      headers: { accept:'application/json' },
      cache:'no-store'
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not load order.');

    const paid = data.paymentStatus === 'paid';
    title.textContent = paid ? 'Payment confirmed' : 'Waiting for payment confirmation';
    message.textContent = data.delivery?.message || '';
    card.hidden = false;
    card.innerHTML = `
      <div class="order-status-line"><span>Order</span><b>${esc(data.orderId)}</b></div>
      <div class="order-status-line"><span>Website</span><b>${esc(data.websiteUrl)}</b></div>
      <div class="order-status-line"><span>Email</span><b>${esc(data.customerEmail)}</b></div>
      <div class="order-status-line"><span>Payment</span><b class="${paid?'status-paid':'status-pending'}">${paid?'Confirmed':'Pending'}</b></div>
      <div class="order-status-line"><span>Order status</span><b>${pretty(data.status)}</b></div>
      <div class="order-status-line"><span>Total</span><b>${money(data.amountTotal,data.currency)}</b></div>
      ${data.delivery?.url ? `<a class="button full" href="${escAttr(data.delivery.url)}" rel="noopener">Open delivery area</a>` : ''}
    `;
    if (paid) {
      if (autoRefreshTimer) clearTimeout(autoRefreshTimer);
      autoRefreshTimer = null;
    } else if (!autoRefreshTimer) {
      autoRefreshTimer = setTimeout(() => {
        autoRefreshTimer = null;
        loadOrder();
      }, 15000);
    }
  } catch (err) {
    title.textContent = 'Could not load this order';
    message.textContent = err.message;
    card.hidden = true;
  } finally {
    refresh.disabled = false;
  }
}
function pretty(v=''){ return String(v).replaceAll('_',' ').replace(/\b\w/g,c=>c.toUpperCase()); }
function money(amount,currency='usd'){ try{return new Intl.NumberFormat('en-US',{style:'currency',currency:String(currency).toUpperCase()}).format(Number(amount||0)/100)}catch{return `$${Number(amount||0)/100}`}}
function esc(v=''){return String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function escAttr(v=''){return esc(v)}
refresh?.addEventListener('click',loadOrder);
loadOrder();