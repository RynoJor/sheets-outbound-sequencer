/**
 * Sequencer.gs: writes the copy and sends what is due.
 *
 * Two entry points:
 *   prepareLeads()  fills the templates into each new lead's row
 *   sendWindow()    run by a trigger a few times a day; sends what is due
 *
 * Copy is written into the sheet before anything sends, so every email can
 * be read and edited first.
 */

var RUN_BUDGET_MS = 4.5 * 60 * 1000; // Apps Script stops a run at 6 minutes.

// ---------------------------------------------------------------------------
// Prepare
// ---------------------------------------------------------------------------

function prepareLeads() {
  var sheet = leadsSheet();
  if (sheet.getLastRow() < 2) return;

  var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, LAST_COL).getValues();
  var suppressed = getSuppressionSet();
  var prepared = 0, skipped = 0;

  for (var i = 0; i < rows.length; i++) {
    var lead = rowToLead(rows[i], i + 2);
    if (lead.status !== STATUS.NEW) continue;

    if (!looksLikeEmail(lead.email)) {
      setStatus(sheet, lead.row, STATUS.INVALID, 'Missing or malformed email address.');
      continue;
    }
    if (suppressed[lead.email]) {
      setStatus(sheet, lead.row, STATUS.UNSUBSCRIBED, 'On the suppression list.');
      continue;
    }

    var result = renderSequence(lead);
    if (result.missing.length) {
      // Stays 'new' so it is picked up again once the field is filled in.
      sheet.getRange(lead.row, COL.notes)
        .setValue('Not prepared. Empty field(s): ' + result.missing.join(', '));
      skipped++;
      continue;
    }

    var e = result.emails;
    sheet.getRange(lead.row, COL.email1Subject, 1, 6).setValues([[
      e[0].subject, e[0].body, e[1].subject, e[1].body, e[2].subject, e[2].body
    ]]);
    sheet.getRange(lead.row, COL.status).setValue(STATUS.READY);
    prepared++;
  }

  logEvent('', 'prepare', 'done', prepared + ' prepared, ' + skipped + ' missing fields.');
}

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

/**
 * Sends one window's share of today's cap.
 *
 * In dry-run mode it logs every email it would send and changes nothing on
 * the Leads tab, so a dry run can be repeated safely.
 */
function sendWindow() {
  var started = Date.now();
  var today = todayYmd();

  if (!isSendDay(new Date().getDay(), CONFIG.SEND_DAYS)) {
    logEvent('', 'send', 'skipped', 'Not a send day.');
    return;
  }

  var blocker = preflightBlocker();
  if (blocker) {
    logEvent('', 'send', 'blocked', blocker);
    return;
  }

  var week = warmupWeek(CONFIG.RAMP_START_DATE, today);
  var cap = dailyCap(week, CONFIG.DAILY_CAP_MAX, CONFIG.WARMUP_RAMP);
  var sentToday = countSentToday(today);
  var slots = slotsForWindow(cap, sentToday, CONFIG.SEND_HOURS.length);

  if (slots === 0) {
    logEvent('', 'send', 'skipped',
             'Cap reached or ramp not started: ' + sentToday + '/' + cap + ' today.');
    return;
  }

  var sheet = leadsSheet();
  var leads = readLeads(sheet);
  var queue = buildSendQueue(leads, today, slots, cadenceSettings(), getSuppressionSet());
  var dryRun = isTrue(CONFIG.DRY_RUN);
  var ours = getOurAddresses();
  var sent = 0;

  for (var i = 0; i < queue.length; i++) {
    if (Date.now() - started > RUN_BUDGET_MS) {
      logEvent('', 'send', 'paused', 'Run time budget reached after ' + sent + ' sends.');
      break;
    }

    var lead = queue[i].lead;
    var step = queue[i].step;

    if (dryRun) {
      logEvent(lead.email, 'send', 'dry_run',
               'Would send email ' + step + ': ' + lead['email' + step + 'Subject']);
      sent++;
      continue;
    }

    try {
      // Last check before a follow-up: the hourly reply check may not have
      // run since they answered.
      if (step > 1 && threadHasReply(lead.threadId, ours)) {
        markReplied(sheet, lead);
        continue;
      }

      var threadId = sendOne(lead, step);
      var now = new Date();
      sheet.getRange(lead.row, COL['email' + step + 'SentAt']).setValue(now);
      if (step === 1 || threadId !== lead.threadId) {
        sheet.getRange(lead.row, COL.threadId).setValue(threadId);
      }
      sheet.getRange(lead.row, COL.status)
        .setValue(step === 3 ? STATUS.COMPLETED : STATUS.IN_SEQUENCE);
      sent++;
      logEvent(lead.email, 'send', 'sent', 'Email ' + step);

      if (i < queue.length - 1) {
        Utilities.sleep(jitterMs(CONFIG.PAUSE_MIN_SECONDS * 1000,
                                 CONFIG.PAUSE_MAX_SECONDS * 1000));
      }
    } catch (err) {
      sheet.getRange(lead.row, COL.notes).setValue('Send failed: ' + err.message);
      logEvent(lead.email, 'send', 'error', err.message);
    }
  }

  logEvent('', 'send', dryRun ? 'dry_run_done' : 'done',
           sent + ' this window. Day total ' + (dryRun ? sentToday : sentToday + sent) +
           '/' + cap + ' (warmup week ' + week + ').');
}

/**
 * A reason to refuse to send live, or null. Hard stops, not warnings:
 * a half-configured system should fail closed.
 */
function preflightBlocker() {
  if (isTrue(CONFIG.DRY_RUN)) return null; // a dry run emails nobody

  var required = ['FROM_NAME', 'SENDER_COMPANY', 'REPLY_TO', 'PHYSICAL_ADDRESS'];
  for (var i = 0; i < required.length; i++) {
    if (isPlaceholder(CONFIG[required[i]])) {
      return 'CONFIG.' + required[i] + ' is still a placeholder in Config.gs.';
    }
  }
  if (!CONFIG.RAMP_START_DATE) {
    return 'RAMP_START_DATE is empty in Config.gs. Set it to your first send day.';
  }
  if (!getUnsubscribeBaseUrl()) {
    return 'No unsubscribe URL. Deploy the web app and run captureWebAppUrl().';
  }
  return null;
}

/**
 * Sends one email and returns its Gmail thread ID.
 * Follow-ups reply on the first email's thread, so the prospect sees one
 * conversation, not three cold emails.
 */
function sendOne(lead, step) {
  var subject = lead['email' + step + 'Subject'];
  var body = lead['email' + step + 'Body'];
  if (!body) throw new Error('No body for email ' + step + '. Run prepareLeads().');

  var fullBody = withFooter(body, senderSettings(), unsubscribeUrlFor(lead.email));
  var options = { name: CONFIG.FROM_NAME, replyTo: CONFIG.REPLY_TO };

  if (step > 1 && lead.threadId) {
    var thread = GmailApp.getThreadById(lead.threadId);
    if (thread) {
      thread.reply(fullBody, options);
      return lead.threadId;
    }
    // Thread deleted: send as a new email rather than drop the follow-up.
  }

  // createDraft().send() returns the message, which gives us the thread ID.
  // GmailApp.sendEmail() returns nothing we can use.
  var message = GmailApp.createDraft(lead.email, subject, fullBody, options).send();
  return message.getThread().getId();
}

/** Emails already sent today, across all three steps. */
function countSentToday(today) {
  var sheet = leadsSheet();
  if (sheet.getLastRow() < 2) return 0;
  var values = sheet.getRange(2, COL.email1SentAt, sheet.getLastRow() - 1, 3).getValues();
  var count = 0;
  values.forEach(function (row) {
    row.forEach(function (cell) { if (ymd(cell) === today) count++; });
  });
  return count;
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

function readLeads(sheet) {
  if (sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, LAST_COL).getValues()
    .map(function (values, i) { return rowToLead(values, i + 2); });
}

/** Turns a sheet row into the lead object Core.js expects. */
function rowToLead(values, row) {
  function at(col) { return String(values[col - 1] === undefined ? '' : values[col - 1]).trim(); }
  return {
    row:           row,
    id:            at(COL.id),
    status:        at(COL.status),
    firstName:     at(COL.firstName),
    lastName:      at(COL.lastName),
    email:         normalizeEmail(at(COL.email)),
    company:       at(COL.company),
    website:       at(COL.website),
    city:          at(COL.city),
    industry:      at(COL.industry),
    personalLine:  at(COL.personalLine),
    email1Subject: at(COL.email1Subject),
    email1Body:    at(COL.email1Body),
    email2Subject: at(COL.email2Subject),
    email2Body:    at(COL.email2Body),
    email3Subject: at(COL.email3Subject),
    email3Body:    at(COL.email3Body),
    sent1:         ymd(values[COL.email1SentAt - 1]),
    sent2:         ymd(values[COL.email2SentAt - 1]),
    sent3:         ymd(values[COL.email3SentAt - 1]),
    threadId:      at(COL.threadId)
  };
}

function setStatus(sheet, row, status, note) {
  sheet.getRange(row, COL.status).setValue(status);
  if (note) sheet.getRange(row, COL.notes).setValue(note);
}
