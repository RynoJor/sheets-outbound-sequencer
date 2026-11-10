/**
 * Monitor.gs: replies, bounces and the suppression list.
 *
 * This file exists to stop sending. Emailing someone who already replied,
 * or hitting an address that hard-bounced, does more harm than anything
 * the sequencer does well.
 */

/** Hourly trigger entry point. */
function checkRepliesAndBounces() {
  detectReplies();
  detectBounces();
  syncSuppressionToLeads();
}

// ---------------------------------------------------------------------------
// Replies
// ---------------------------------------------------------------------------

/**
 * Marks a lead 'replied' when its thread holds a message from someone other
 * than us that is not a bounce or an out-of-office. Reading the thread
 * (rather than searching the inbox) also catches replies that were filtered
 * or archived.
 *
 * A reply that asks to be removed also goes on the suppression list.
 */
function detectReplies() {
  var sheet = leadsSheet();
  var ours = getOurAddresses();
  var found = 0;

  readLeads(sheet).forEach(function (lead) {
    if (!lead.threadId) return;
    if (lead.status !== STATUS.IN_SEQUENCE && lead.status !== STATUS.COMPLETED) return;

    var reply = findHumanReply(lead.threadId, ours);
    if (!reply) return;

    markReplied(sheet, lead);
    found++;

    if (isOptOutReply(reply.body)) {
      addToSuppression(lead.email, 'Asked to be removed (reply)');
    }
  });

  if (found) logEvent('', 'reply', 'done', found + ' replies detected.');
}

/** The first human reply in a thread as { from, body }, or null. */
function findHumanReply(threadId, ours) {
  if (!threadId) return null;
  var thread;
  try {
    thread = GmailApp.getThreadById(threadId);
  } catch (err) {
    return null; // deleted or not accessible
  }
  if (!thread) return null;

  var messages = thread.getMessages();
  for (var m = 0; m < messages.length; m++) {
    var from = messages[m].getFrom();
    if (isHumanReply(from, ours) && !isAutoReply(messages[m].getSubject())) {
      return { from: from, body: messages[m].getPlainBody() };
    }
  }
  return null;
}

function threadHasReply(threadId, ours) {
  return !!findHumanReply(threadId, ours);
}

function markReplied(sheet, lead) {
  sheet.getRange(lead.row, COL.status).setValue(STATUS.REPLIED);
  sheet.getRange(lead.row, COL.repliedAt).setValue(new Date());
  logEvent(lead.email, 'reply', 'detected', 'Sequence stopped.');
}

/** Every address that counts as "us". */
function getOurAddresses() {
  var addresses = [];
  if (!isPlaceholder(CONFIG.REPLY_TO)) addresses.push(normalizeEmail(CONFIG.REPLY_TO));
  try {
    addresses.push(normalizeEmail(Session.getEffectiveUser().getEmail()));
    GmailApp.getAliases().forEach(function (a) { addresses.push(normalizeEmail(a)); });
  } catch (err) {
    // Some account setups block these calls. REPLY_TO is enough on its own.
  }
  return addresses.filter(function (a) { return !!a; });
}

// ---------------------------------------------------------------------------
// Bounces
// ---------------------------------------------------------------------------

/**
 * Reads the last three days of delivery-failure notices and marks the leads
 * they name as bounced. Soft bounces (mailbox full, try again later) are
 * ignored: the address is still good.
 *
 * Bounce rate is what gets a sending inbox throttled fastest. If the Log
 * shows more than a few percent, stop and clean the list.
 */
function detectBounces() {
  var query = 'newer_than:3d (from:mailer-daemon OR from:postmaster OR ' +
              'subject:"Delivery Status Notification" OR ' +
              'subject:"Undelivered Mail Returned to Sender")';
  var threads;
  try {
    threads = GmailApp.search(query, 0, 50);
  } catch (err) {
    logEvent('', 'bounce', 'error', err.message);
    return;
  }
  if (!threads.length) return;

  var sheet = leadsSheet();
  var sentLeads = readLeads(sheet).filter(function (lead) {
    return lead.sent1 && lead.status !== STATUS.BOUNCED;
  });
  if (!sentLeads.length) return;

  var candidates = sentLeads.map(function (l) { return l.email; });
  var bounced = {};

  threads.forEach(function (thread) {
    thread.getMessages().forEach(function (message) {
      if (!isBounceSender(message.getFrom()) &&
          !/delivery status notification|undelivered mail/i.test(message.getSubject())) {
        return;
      }
      bouncedAddresses(message.getPlainBody(), candidates).forEach(function (email) {
        bounced[email] = true;
      });
    });
  });

  var count = 0;
  sentLeads.forEach(function (lead) {
    if (!bounced[lead.email]) return;
    sheet.getRange(lead.row, COL.status).setValue(STATUS.BOUNCED);
    sheet.getRange(lead.row, COL.bouncedAt).setValue(new Date());
    addToSuppression(lead.email, 'Hard bounce');
    count++;
  });

  if (count) logEvent('', 'bounce', 'done', count + ' hard bounces suppressed.');
}

// ---------------------------------------------------------------------------
// Suppression list
// ---------------------------------------------------------------------------

/** The suppression list as { email: true }. */
function getSuppressionSet() {
  var sheet = ss().getSheetByName(TAB_SUPPRESSION);
  var set = {};
  if (!sheet || sheet.getLastRow() < 2) return set;
  sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues().forEach(function (row) {
    var email = normalizeEmail(row[0]);
    if (email) set[email] = true;
  });
  return set;
}

/** Adds an address to the suppression list. Safe to call twice. */
function addToSuppression(email, reason) {
  email = normalizeEmail(email);
  if (!email || getSuppressionSet()[email]) return;
  var sheet = ss().getSheetByName(TAB_SUPPRESSION);
  if (!sheet) return;
  sheet.appendRow([email, reason || 'Manual', new Date()]);
  logEvent(email, 'suppression', 'added', reason);
}

/**
 * Copies the suppression list onto the Leads tab, so suppressed leads are
 * visibly out of the pipeline. Addresses you add to the Suppression tab by
 * hand are picked up here too.
 */
function syncSuppressionToLeads() {
  var suppressed = getSuppressionSet();
  if (!Object.keys(suppressed).length) return;

  var sheet = leadsSheet();
  var updated = 0;
  readLeads(sheet).forEach(function (lead) {
    if (!suppressed[lead.email]) return;
    if (lead.status === STATUS.UNSUBSCRIBED || lead.status === STATUS.BOUNCED) return;
    sheet.getRange(lead.row, COL.status).setValue(STATUS.UNSUBSCRIBED);
    sheet.getRange(lead.row, COL.unsubscribedAt).setValue(new Date());
    updated++;
  });
  if (updated) logEvent('', 'suppression', 'synced', updated + ' leads removed.');
}
