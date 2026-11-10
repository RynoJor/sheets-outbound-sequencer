/**
 * Config.gs: every setting you need to change lives here.
 *
 * Replace each YOUR_... placeholder before you turn off DRY_RUN.
 * The script refuses to send live while any required value is still a
 * placeholder (see preflightBlocker in Sequencer.gs).
 *
 * Secrets do not go in this file. The unsubscribe signing key is generated
 * on first run and kept in Script Properties, which are not shared when the
 * spreadsheet is.
 */

var CONFIG = {
  // --- Where the data lives -------------------------------------------------
  // ID of the Google Sheet (the long string in its address bar). Leave as the
  // placeholder if the script is bound to the sheet (Extensions > Apps Script):
  // the active spreadsheet is used instead.
  SHEET_ID: 'YOUR_SHEET_ID',

  // --- Who the email is from --------------------------------------------------
  FROM_NAME:        'YOUR_NAME',
  SENDER_COMPANY:   'YOUR_COMPANY',
  // The inbox replies should go to. Normally the Gmail account running the script.
  REPLY_TO:         'YOUR_SENDING_ADDRESS',
  // A real postal address. Most cold email laws require one in every message.
  PHYSICAL_ADDRESS: 'YOUR_POSTAL_ADDRESS',

  // --- Safety switch ----------------------------------------------------------
  // TRUE: write copy, log what would send, send nothing.
  // Set to false only after you have read the generated copy in the sheet.
  DRY_RUN: true,

  // --- Caps and pacing --------------------------------------------------------
  // First day of sending, 'yyyy-MM-dd'. Drives the warmup ramp below.
  RAMP_START_DATE: '',
  // Daily cap for weeks 1-4. Week 5 on uses DAILY_CAP_MAX.
  WARMUP_RAMP: [10, 20, 30, 40],
  // Ceiling on all emails per day (new + follow-ups) from one inbox.
  DAILY_CAP_MAX: 50,
  // Days sending is allowed.
  SEND_DAYS: 'Mon,Tue,Wed,Thu',
  // Hours (spreadsheet timezone) the send trigger runs. The daily cap is
  // spread across these windows.
  SEND_HOURS: [9, 11, 13, 15],
  // Random pause between two sends in one window, in seconds. Keep the
  // window's sends inside the ~6 minute Apps Script run limit.
  PAUSE_MIN_SECONDS: 5,
  PAUSE_MAX_SECONDS: 20,

  // --- Cadence: day 0, +3, +6 ---------------------------------------------------
  STEP2_AFTER_DAYS: 3,
  STEP3_AFTER_DAYS: 3
};

// ---------------------------------------------------------------------------
// Sheet layout
// ---------------------------------------------------------------------------

var TAB_LEADS       = 'Leads';
var TAB_SUPPRESSION = 'Suppression';
var TAB_LOG         = 'Log';

/** Leads tab columns, 1-indexed to match getRange(row, col). */
var COL = {
  id:             1,
  status:         2,
  firstName:      3,
  lastName:       4,
  email:          5,
  company:        6,
  website:        7,
  city:           8,
  industry:       9,
  personalLine:  10,
  source:        11,
  dateAdded:     12,
  email1Subject: 13,
  email1Body:    14,
  email2Subject: 15,
  email2Body:    16,
  email3Subject: 17,
  email3Body:    18,
  email1SentAt:  19,
  email2SentAt:  20,
  email3SentAt:  21,
  threadId:      22,
  repliedAt:     23,
  bouncedAt:     24,
  unsubscribedAt: 25,
  notes:         26
};

var LEADS_HEADERS = [
  'ID', 'Status', 'First Name', 'Last Name', 'Email', 'Company', 'Website',
  'City', 'Industry', 'Personal Line', 'Source', 'Date Added',
  'Email 1 Subject', 'Email 1 Body', 'Email 2 Subject', 'Email 2 Body',
  'Email 3 Subject', 'Email 3 Body', 'Email 1 Sent', 'Email 2 Sent',
  'Email 3 Sent', 'Thread ID', 'Replied', 'Bounced', 'Unsubscribed', 'Notes'
];

var LAST_COL = LEADS_HEADERS.length;

// ---------------------------------------------------------------------------
// Accessors
// ---------------------------------------------------------------------------

function isPlaceholder(value) {
  return !value || /^YOUR_/.test(String(value));
}

function ss() {
  return isPlaceholder(CONFIG.SHEET_ID)
    ? SpreadsheetApp.getActiveSpreadsheet()
    : SpreadsheetApp.openById(CONFIG.SHEET_ID);
}

function sheetTz() {
  return ss().getSpreadsheetTimeZone();
}

function leadsSheet() {
  var s = ss().getSheetByName(TAB_LEADS);
  if (!s) throw new Error('Leads tab is missing. Run setupWorkbook() first.');
  return s;
}

function senderSettings() {
  return {
    fromName:        CONFIG.FROM_NAME,
    senderCompany:   CONFIG.SENDER_COMPANY,
    physicalAddress: CONFIG.PHYSICAL_ADDRESS
  };
}

function cadenceSettings() {
  return { step2AfterDays: CONFIG.STEP2_AFTER_DAYS, step3AfterDays: CONFIG.STEP3_AFTER_DAYS };
}

/** A Date (or empty cell) as 'yyyy-MM-dd' in the sheet's timezone, or ''. */
function ymd(value) {
  return value instanceof Date ? Utilities.formatDate(value, sheetTz(), 'yyyy-MM-dd') : '';
}

function todayYmd() {
  return ymd(new Date());
}

/**
 * Signing key for unsubscribe links, so the endpoint cannot be used to
 * opt out addresses by guessing URLs. Generated once.
 */
function getUnsubscribeSecret() {
  var props = PropertiesService.getScriptProperties();
  var secret = props.getProperty('UNSUBSCRIBE_SECRET');
  if (!secret) {
    secret = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty('UNSUBSCRIBE_SECRET', secret);
  }
  return secret;
}

/** Appends a row to the Log tab. Never throws: logging must not break a send. */
function logEvent(email, step, result, detail) {
  try {
    var sheet = ss().getSheetByName(TAB_LOG);
    if (!sheet) return;
    sheet.appendRow([new Date(), email || '', step || '', result || '',
                     String(detail || '').slice(0, 500)]);
  } catch (err) {
    // A failed log write must not abort the caller.
  }
}
