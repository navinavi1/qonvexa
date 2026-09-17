// Escaping and formatting shared by every page.
//
// These lived in three files as four separate implementations, and they had already drifted:
// pretty() was made to escape in admin.js after it was found being interpolated straight into
// innerHTML, while the identical copy in order.js -- interpolated the same way, into the order
// status card a customer sees -- was left as it was. That is what duplicated helpers do. One
// implementation, loaded before the page scripts, so a fix reaches every page at once.

// The only escape on the site. Covers the five characters that matter in both element text
// and a quoted attribute value, which is why escAttr is the same function rather than a
// second, subtly different one.
function esc(value = '') {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[character]));
}
// Declared as functions, not const aliases: a classic script's top-level const is visible to
// other classic scripts in a browser but not to an eval'd script, and the difference is only
// ever discovered by something breaking somewhere that does not match the browser.
function escHtml(value = '') { return esc(value); }
function escAttr(value = '') { return esc(value); }

// A status or key turned into words for a person to read. It is interpolated into innerHTML
// at several call sites, so it escapes: a formatter that is also an HTML sink is a trap for
// whoever adds the next field.
function pretty(value = '') {
  return esc(String(value).replaceAll('_', ' ').replace(/\b\w/g, character => character.toUpperCase()));
}

// Amounts arrive from the server in minor units. An unknown currency code makes Intl throw,
// which must not take a whole render down over a formatting detail.
function money(amount, currency = 'USD') {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: String(currency || 'USD').toUpperCase() })
      .format(Number(amount || 0) / 100);
  } catch {
    return `$${(Number(amount || 0) / 100).toFixed(2)}`;
  }
}
// The dashboard's name for the same thing, kept so its call sites read naturally.
function formatMoney(amount, currency = 'usd') {
  return typeof amount === 'number' ? money(amount, currency) : '';
}

function formatDate(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

// A link only when the target is one we would actually follow. Anything else is shown as
// text, so a stored value can never become a javascript: or data: href.
function link(url = '') {
  return /^https?:\/\//i.test(String(url))
    ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>`
    : esc(url);
}
