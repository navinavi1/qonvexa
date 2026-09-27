const title = document.querySelector('#success-title');
const message = document.querySelector('#success-message');
const details = document.querySelector('#order-details');
const token = new URLSearchParams(location.search).get('token');

async function verify() {
  if (!token) {
    title.textContent = 'Payment not verified';
    message.textContent = 'Use the private order link supplied with your bank-transfer instructions.';
    return;
  }
  try {
    const response = await fetch(`/api/order-status?token=${encodeURIComponent(token)}`, {
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
      message.textContent = 'Your bank transfer has not been confirmed yet. We verify receipt before releasing the paid audit.';
    }
  } catch (err) {
    title.textContent = 'We could not verify this payment';
    message.textContent = err.message;
  }
}
verify();