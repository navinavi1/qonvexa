const title = document.querySelector('#success-title');
const message = document.querySelector('#success-message');
const details = document.querySelector('#order-details');
const sessionId = new URLSearchParams(location.search).get('session_id');

async function verify() {
  if (!sessionId) {
    title.textContent = 'Payment not verified';
    message.textContent = 'This page needs a valid Checkout Session ID.';
    return;
  }
  try {
    const response = await fetch(`/api/checkout-session-status?session_id=${encodeURIComponent(sessionId)}`, {
      headers: { 'accept': 'application/json' }
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not verify payment.');

    if (data.paymentStatus === 'paid') {
      title.textContent = 'Payment received. Thank you.';
      message.textContent = `Your QONVEXA audit order is confirmed. Your delivery timeframe is shown in the Refund & Delivery policy.`;
      details.hidden = false;
      const amount = typeof data.amountTotal === 'number'
        ? new Intl.NumberFormat('en-US', { style:'currency', currency:(data.currency || 'usd').toUpperCase() }).format(data.amountTotal / 100)
        : '';
      details.textContent = [data.websiteUrl, data.customerEmail, amount].filter(Boolean).join(' · ');
    } else {
      title.textContent = 'Payment is still processing';
      message.textContent = 'Your Checkout session exists, but Stripe has not marked the payment as paid yet. Please check again shortly.';
    }
  } catch (err) {
    title.textContent = 'We could not verify this payment';
    message.textContent = err.message;
  }
}
verify();