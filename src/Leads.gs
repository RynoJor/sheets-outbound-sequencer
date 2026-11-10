/**
 * Leads.gs: importing leads into the Leads tab.
 *
 * Paste CSV or rows copied out of a spreadsheet (tab-separated), including
 * the header row. Columns are matched by header name, not position (see
 * HEADER_ALIASES in Core.js). Duplicates, suppressed addresses and rows
 * without a usable email are dropped and reported.
 */

function showImportDialog() {
  var html = HtmlService.createHtmlOutput(importDialogHtml()).setWidth(640).setHeight(480);
  SpreadsheetApp.getUi().showModalDialog(html, 'Import leads');
}

/** Called from the dialog. Returns a summary rather than throwing. */
function importPastedLeads(text) {
  if (!text || !text.trim()) return 'Nothing to import.';

  var rows = parseDelimited(text);
  if (rows.length < 2) return 'Need a header row and at least one data row.';

  var mapping = mapHeaders(rows[0]);
  if (mapping.email === undefined) {
    return 'No Email column found. Accepted headers: ' + HEADER_ALIASES.email.join(', ');
  }

  var sheet = leadsSheet();
  var existing = {};
  readLeads(sheet).forEach(function (l) { existing[l.email] = true; });
  var suppressed = getSuppressionSet();

  var toAppend = [];
  var dupes = 0, onList = 0, noEmail = 0;

  for (var i = 1; i < rows.length; i++) {
    var row = rows[i];
    if (!row.join('').trim()) continue;

    var email = normalizeEmail(row[mapping.email]);
    if (!looksLikeEmail(email)) { noEmail++; continue; }
    if (existing[email]) { dupes++; continue; }
    if (suppressed[email]) { onList++; continue; }
    existing[email] = true;

    var record = new Array(LAST_COL).fill('');
    record[COL.id - 1] = 'L' + Utilities.getUuid().slice(0, 8);
    record[COL.status - 1] = STATUS.NEW;
    record[COL.email - 1] = email;
    record[COL.dateAdded - 1] = new Date();
    ['firstName', 'lastName', 'company', 'website', 'city', 'industry',
     'personalLine', 'source'].forEach(function (field) {
      if (mapping[field] !== undefined) {
        record[COL[field] - 1] = String(row[mapping[field]] || '').trim();
      }
    });
    toAppend.push(record);
  }

  if (toAppend.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, toAppend.length, LAST_COL).setValues(toAppend);
  }
  logEvent('', 'import', 'done', toAppend.length + ' imported.');

  var out = ['Imported ' + toAppend.length + ' leads.'];
  if (dupes) out.push(dupes + ' already in the sheet.');
  if (onList) out.push(onList + ' on the suppression list.');
  if (noEmail) out.push(noEmail + ' had no usable email.');
  out.push('', 'Next: Outreach > Write copy for new leads.');
  return out.join('\n');
}

/** Tab in the header row means a spreadsheet paste; otherwise CSV. */
function parseDelimited(text) {
  var normalized = text.replace(/\r\n/g, '\n').trim();
  if (normalized.split('\n')[0].indexOf('\t') !== -1) {
    return normalized.split('\n').map(function (line) { return line.split('\t'); });
  }
  return Utilities.parseCsv(normalized);
}

function importDialogHtml() {
  return '' +
    '<!DOCTYPE html><html><head><base target="_top"><style>' +
    'body{font-family:system-ui,sans-serif;margin:0;padding:1rem;font-size:13px;color:#1f2937}' +
    'p{margin:0 0 .75rem;color:#4b5563}' +
    'textarea{width:100%;height:240px;font-family:monospace;font-size:11px;box-sizing:border-box}' +
    'button{margin-top:.75rem;padding:.5rem 1rem}' +
    '#out{margin-top:.75rem;white-space:pre-wrap}' +
    '</style></head><body>' +
    '<p>Paste rows <b>including the header row</b>. CSV or a copy from a spreadsheet both work.</p>' +
    '<p>Headers: First Name, Last Name, Email, Company, Website, City, Industry, ' +
    'Personal Line, Source. Only Email is required.</p>' +
    '<textarea id="data"></textarea><br>' +
    '<button id="go" onclick="go()">Import</button><div id="out"></div>' +
    '<script>function go(){var b=document.getElementById("go");b.disabled=true;' +
    'google.script.run.withSuccessHandler(function(m){' +
    'document.getElementById("out").textContent=m;b.disabled=false;})' +
    '.withFailureHandler(function(e){' +
    'document.getElementById("out").textContent=e.message;b.disabled=false;})' +
    '.importPastedLeads(document.getElementById("data").value);}</script>' +
    '</body></html>';
}
