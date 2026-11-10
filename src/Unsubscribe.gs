/**
 * Unsubscribe.gs: the opt-out web app.
 *
 * Deploy as a web app (execute as you, access: anyone). Every email footer
 * links here with the recipient's address and a signature. The signature
 * stops anyone from opting out other people by guessing links.
 */

function doGet(e) {
  var params = (e && e.parameter) || {};
  var email = normalizeEmail(params.e);
  var token = String(params.t || '');

  if (!email || !token || token !== signEmail(email)) {
    return renderPage('This link could not be verified',
      'Reply to any of our emails with "unsubscribe" and we will remove you by hand.');
  }

  try {
    addToSuppression(email, 'Unsubscribed via link');
    syncSuppressionToLeads();
  } catch (err) {
    logEvent(email, 'unsubscribe', 'error', err.message);
    return renderPage('Something went wrong',
      'Reply to any of our emails with "unsubscribe" and we will remove you by hand.');
  }

  return renderPage('You are unsubscribed',
    email + ' has been removed. You will not get any more emails from us.');
}

/** HMAC-SHA256 of the address with the script's secret, first 32 hex chars. */
function signEmail(email) {
  var bytes = Utilities.computeHmacSha256Signature(normalizeEmail(email),
                                                   getUnsubscribeSecret());
  return bytes.map(function (b) {
    return ('0' + (b & 0xFF).toString(16)).slice(-2); // signed byte to hex
  }).join('').slice(0, 32);
}

/** Base URL of the deployed web app, or '' if it has not been captured. */
function getUnsubscribeBaseUrl() {
  return PropertiesService.getScriptProperties().getProperty('UNSUBSCRIBE_URL') || '';
}

/** The signed opt-out link for one recipient, or '' if not deployed yet. */
function unsubscribeUrlFor(email) {
  var base = getUnsubscribeBaseUrl();
  if (!base) return '';
  return base + '?e=' + encodeURIComponent(normalizeEmail(email)) + '&t=' + signEmail(email);
}

/**
 * Run once from the editor after Deploy > New deployment > Web app.
 * Stores the deployment URL so footers can link to it.
 */
function captureWebAppUrl() {
  var url = ScriptApp.getService().getUrl();
  if (!url) throw new Error('No web app deployment found. Deploy first, then run this.');
  PropertiesService.getScriptProperties().setProperty('UNSUBSCRIBE_URL', url);
  logEvent('', 'setup', 'ok', 'Unsubscribe URL saved.');
  return url;
}

function renderPage(heading, message) {
  var html =
    '<!DOCTYPE html><html><head>' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<style>body{font-family:system-ui,sans-serif;max-width:34rem;margin:12vh auto;' +
    'padding:0 1.5rem;color:#1f2937;line-height:1.6}h1{font-size:1.4rem}</style>' +
    '</head><body><h1>' + escapeHtml(heading) + '</h1><p>' + escapeHtml(message) +
    '</p></body></html>';
  return HtmlService.createHtmlOutput(html).setTitle(heading);
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
