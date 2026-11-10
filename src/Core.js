/**
 * Core.js: the pure logic of the sequencer.
 *
 * Nothing in this file touches SpreadsheetApp, GmailApp or any other Apps
 * Script service. Dates and settings are passed in. That keeps the rules
 * that matter (who is due, how many may go out, what the email says)
 * testable with plain Node: see test/core.test.js.
 *
 * Apps Script loads this file into the same global scope as the .gs files,
 * so they call these functions directly. Node loads it through the
 * module.exports block at the bottom, which Apps Script ignores.
 */

// ---------------------------------------------------------------------------
// Lead status values
// ---------------------------------------------------------------------------

var STATUS = {
  NEW:          'new',          // imported, copy not written yet
  READY:        'ready',        // copy written, waiting for a send slot
  IN_SEQUENCE:  'in_sequence',  // at least one email sent, more to go
  COMPLETED:    'completed',    // all three sent, no reply
  REPLIED:      'replied',      // stop: they answered
  BOUNCED:      'bounced',      // stop: hard bounce
  UNSUBSCRIBED: 'unsubscribed', // stop: opted out or on the suppression list
  INVALID:      'invalid'       // missing or malformed email
};

/** Statuses that take a lead out of the sending pool for good. */
var TERMINAL_STATUSES = [
  STATUS.COMPLETED, STATUS.REPLIED, STATUS.BOUNCED,
  STATUS.UNSUBSCRIBED, STATUS.INVALID
];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

/**
 * Deliberately loose. It catches empty cells and typos, not every invalid
 * address. Bounce handling catches the rest.
 */
function looksLikeEmail(email) {
  return /^[^@\s]+@[^@\s.]+(\.[^@\s.]+)+$/.test(normalizeEmail(email));
}

function isTrue(value) {
  return value === true || String(value).trim().toUpperCase() === 'TRUE';
}

/**
 * Whole calendar days from one 'yyyy-MM-dd' string to another.
 *
 * Calendar days, not 24-hour blocks. An email sent at 11:00 on Monday is due
 * again at the first window on Thursday, not at 11:00 on Thursday.
 * The caller formats both dates in the spreadsheet's timezone first.
 */
function calendarDaysBetween(fromYmd, toYmd) {
  var a = ymdToUtc(fromYmd);
  var b = ymdToUtc(toYmd);
  if (a === null || b === null) return null;
  return Math.round((b - a) / 86400000);
}

function ymdToUtc(ymd) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || '').trim());
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3]);
}

// ---------------------------------------------------------------------------
// Caps and pacing
// ---------------------------------------------------------------------------

/** Default warmup ramp: daily cap for weeks 1 to 4. Week 5 on uses the max. */
var DEFAULT_RAMP = [10, 20, 30, 40];

/**
 * 1-based week number since the ramp started. 0 means the start date is in
 * the future, so nothing may send yet.
 */
function warmupWeek(rampStartYmd, todayYmd) {
  if (!rampStartYmd) return 1;
  var elapsed = calendarDaysBetween(rampStartYmd, todayYmd);
  if (elapsed === null) return 1;
  if (elapsed < 0) return 0;
  return Math.floor(elapsed / 7) + 1;
}

/**
 * Total emails allowed today: new sends and follow-ups together.
 * Never above `max`, whatever the ramp says.
 */
function dailyCap(week, max, ramp) {
  ramp = ramp || DEFAULT_RAMP;
  max = Math.max(0, parseInt(max, 10) || 0);
  if (week < 1) return 0;
  var cap = week <= ramp.length ? ramp[week - 1] : max;
  return Math.min(cap, max);
}

/**
 * How many emails this run may send.
 *
 * The day's cap is spread across the send windows so one inbox never fires
 * its whole day in a single burst. What is left of the day is a hard limit.
 */
function slotsForWindow(cap, sentToday, windows) {
  windows = Math.max(1, parseInt(windows, 10) || 1);
  var remaining = cap - sentToday;
  if (remaining <= 0) return 0;
  return Math.min(remaining, Math.ceil(cap / windows));
}

var DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** dayIndex is Date.getDay(): 0 = Sunday. sendDays is like 'Mon,Tue,Wed'. */
function isSendDay(dayIndex, sendDays) {
  var allowed = String(sendDays || '').split(',').map(function (d) {
    return d.trim().toLowerCase().slice(0, 3);
  });
  return allowed.indexOf(DAY_NAMES[dayIndex]) !== -1;
}

/** Random pause between sends, in ms, so sends are not evenly spaced. */
function jitterMs(minMs, maxMs, random) {
  random = random || Math.random;
  return minMs + Math.floor(random() * (maxMs - minMs + 1));
}

// ---------------------------------------------------------------------------
// Cadence
// ---------------------------------------------------------------------------

/** Day 0, day +3, day +6: each gap is counted from the previous send. */
var DEFAULT_CADENCE = { step2AfterDays: 3, step3AfterDays: 3 };

/**
 * Which email (1, 2 or 3) a lead is due for today, or 0 if none.
 *
 * `lead` needs: status, email, sent1, sent2, sent3 (sent dates as
 * 'yyyy-MM-dd' strings, or '' when not sent).
 */
function dueStep(lead, todayYmd, cadence, suppressed) {
  cadence = cadence || DEFAULT_CADENCE;
  suppressed = suppressed || {};

  if (TERMINAL_STATUSES.indexOf(lead.status) !== -1) return 0;
  if (!looksLikeEmail(lead.email)) return 0;
  if (suppressed[normalizeEmail(lead.email)]) return 0;
  if (lead.sent3) return 0;

  if (lead.sent2) {
    return calendarDaysBetween(lead.sent2, todayYmd) >= cadence.step3AfterDays ? 3 : 0;
  }
  if (lead.sent1) {
    return calendarDaysBetween(lead.sent1, todayYmd) >= cadence.step2AfterDays ? 2 : 0;
  }
  return lead.status === STATUS.READY ? 1 : 0;
}

/**
 * Builds today's send queue, at most `slots` long.
 *
 * Follow-ups go first. If the cap forces a choice, dropping a follow-up
 * wastes the touch before it, while a new lead loses nothing by waiting a
 * day. Within a step, sheet order is kept.
 */
function buildSendQueue(leads, todayYmd, slots, cadence, suppressed) {
  var byStep = { 1: [], 2: [], 3: [] };
  leads.forEach(function (lead) {
    var step = dueStep(lead, todayYmd, cadence, suppressed);
    if (step) byStep[step].push({ lead: lead, step: step });
  });
  return byStep[3].concat(byStep[2]).concat(byStep[1]).slice(0, Math.max(0, slots));
}

// ---------------------------------------------------------------------------
// Templates and personalisation
// ---------------------------------------------------------------------------

/**
 * Fills {{field}} and {{field|fallback}} placeholders.
 *
 * Returns { text, missing }. `missing` lists fields that had no value and no
 * fallback. The caller refuses to send an email with anything missing,
 * because "Hi {{firstName}}," in a real inbox is worse than not sending.
 */
function fillTemplate(template, fields) {
  var missing = [];
  var text = String(template || '').replace(
    /\{\{\s*([a-zA-Z0-9_]+)\s*(?:\|([^}]*))?\}\}/g,
    function (whole, name, fallback) {
      var value = fields && fields[name] !== undefined && fields[name] !== null
        ? String(fields[name]).trim() : '';
      if (value) return value;
      if (fallback !== undefined) return fallback;
      if (missing.indexOf(name) === -1) missing.push(name);
      return whole;
    });
  return { text: text, missing: missing };
}

/** The fields a template may use, built from a lead and the sender settings. */
function personalisationFields(lead, sender) {
  sender = sender || {};
  return {
    firstName:     lead.firstName,
    lastName:      lead.lastName,
    company:       lead.company,
    website:       lead.website,
    city:          lead.city,
    industry:      lead.industry,
    personalLine:  lead.personalLine,
    fromName:      sender.fromName,
    senderCompany: sender.senderCompany
  };
}

/**
 * Appends the footer every commercial email needs: who sent it, a postal
 * address, and a way out.
 */
function withFooter(body, sender, unsubscribeUrl) {
  var lines = [String(body).trim(), '', sender.fromName, sender.senderCompany, '', '--',
               sender.physicalAddress];
  lines.push(unsubscribeUrl
    ? 'Not interested? Unsubscribe here: ' + unsubscribeUrl
    : 'Not interested? Reply "unsubscribe" and you will not hear from me again.');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Replies and bounces
// ---------------------------------------------------------------------------

var BOUNCE_SENDERS = ['mailer-daemon', 'postmaster'];

function isBounceSender(from) {
  from = String(from || '').toLowerCase();
  return BOUNCE_SENDERS.some(function (s) { return from.indexOf(s) !== -1; });
}

/**
 * True if a thread message counts as a human reply: not from us, and not a
 * delivery-failure notice. Gmail often files a bounce in the same thread as
 * the original, and counting it as a reply would hide the bounce.
 */
function isHumanReply(from, ourAddresses) {
  from = String(from || '').toLowerCase();
  if (!from) return false;
  if (isBounceSender(from)) return false;
  return !ourAddresses.some(function (addr) {
    return addr && from.indexOf(normalizeEmail(addr)) !== -1;
  });
}

/**
 * Out-of-office and other auto-replies, judged by subject. These should not
 * stop the sequence: the person has not read the email yet.
 */
function isAutoReply(subject) {
  return /^\s*(automatic reply|auto[- ]?reply|autoreply|out of (the )?office|ooo\b)/i
    .test(String(subject || ''));
}

var SOFT_BOUNCE_SIGNALS = [
  'out of office', 'automatic reply', 'auto-reply', 'autoreply',
  'mailbox is full', 'mailbox full', 'quota exceeded', 'over quota',
  'try again later', 'temporarily deferred', 'temporary failure',
  'greylist', 'on vacation', 'currently away'
];

/** Temporary failures. The address is still good, so do not suppress it. */
function isSoftBounce(body) {
  body = String(body || '').toLowerCase();
  return SOFT_BOUNCE_SIGNALS.some(function (s) { return body.indexOf(s) !== -1; });
}

/**
 * Which of `candidates` a hard-bounce notice names.
 *
 * Matches whole addresses only, so a bounce for "jo@x.example" does not
 * also suppress "anjo@x.example".
 */
function bouncedAddresses(body, candidates) {
  body = String(body || '').toLowerCase();
  if (isSoftBounce(body)) return [];
  return candidates.filter(function (email) {
    email = normalizeEmail(email);
    if (!email) return false;
    var escaped = email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Not preceded by an address character, not followed by one either
    // (a trailing full stop is fine: "...failed for jo@x.example.").
    return new RegExp('(^|[^a-z0-9._%+-])' + escaped + '(?![a-z0-9-]|\\.[a-z0-9])')
      .test(body);
  });
}

var OPT_OUT_PATTERNS = [
  /\bunsubscribe\b/, /\bremove me\b/, /\btake me off\b/,
  /\bstop (emailing|contacting|sending)\b/, /\bdo not (email|contact)\b/,
  /\bopt[ -]?out\b/
];

/**
 * True if a reply reads as an opt-out ("please remove me"). The sequence
 * stops on any reply; this also puts the address on the suppression list so
 * a later import cannot bring it back.
 */
function isOptOutReply(text) {
  text = String(text || '').toLowerCase();
  return OPT_OUT_PATTERNS.some(function (re) { return re.test(text); });
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/** Accepted header names per lead field, lowercased. */
var HEADER_ALIASES = {
  firstName:    ['first name', 'firstname', 'first', 'given name'],
  lastName:     ['last name', 'lastname', 'last', 'surname', 'family name'],
  email:        ['email', 'email address', 'work email', 'e-mail'],
  company:      ['company', 'company name', 'organization', 'organisation', 'account'],
  website:      ['website', 'url', 'domain', 'company website'],
  city:         ['city', 'location', 'city, state', 'town'],
  industry:     ['industry', 'sector', 'vertical'],
  personalLine: ['personal line', 'personalisation', 'personalization', 'research notes',
                 'notes', 'opener'],
  source:       ['source', 'lead source']
};

/** Maps a header row to { field: columnIndex }. First match wins. */
function mapHeaders(headerRow) {
  var mapping = {};
  headerRow.forEach(function (raw, index) {
    var header = String(raw || '').trim().toLowerCase();
    if (!header) return;
    Object.keys(HEADER_ALIASES).forEach(function (field) {
      if (mapping[field] === undefined && HEADER_ALIASES[field].indexOf(header) !== -1) {
        mapping[field] = index;
      }
    });
  });
  return mapping;
}

// ---------------------------------------------------------------------------
// Node export. Apps Script has no `module`, so this block is skipped there.
// ---------------------------------------------------------------------------

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    STATUS: STATUS, TERMINAL_STATUSES: TERMINAL_STATUSES,
    DEFAULT_RAMP: DEFAULT_RAMP, DEFAULT_CADENCE: DEFAULT_CADENCE,
    normalizeEmail: normalizeEmail, looksLikeEmail: looksLikeEmail, isTrue: isTrue,
    calendarDaysBetween: calendarDaysBetween,
    warmupWeek: warmupWeek, dailyCap: dailyCap, slotsForWindow: slotsForWindow,
    isSendDay: isSendDay, jitterMs: jitterMs,
    dueStep: dueStep, buildSendQueue: buildSendQueue,
    fillTemplate: fillTemplate, personalisationFields: personalisationFields,
    withFooter: withFooter,
    isBounceSender: isBounceSender, isHumanReply: isHumanReply, isAutoReply: isAutoReply,
    isSoftBounce: isSoftBounce, bouncedAddresses: bouncedAddresses,
    isOptOutReply: isOptOutReply,
    HEADER_ALIASES: HEADER_ALIASES, mapHeaders: mapHeaders
  };
}
