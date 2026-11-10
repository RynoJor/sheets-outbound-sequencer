/**
 * Setup.gs: the menu, first-run workbook setup and triggers.
 */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Outreach')
    .addItem('1. Set up workbook', 'setupWorkbook')
    .addItem('2. Install triggers', 'installTriggers')
    .addSeparator()
    .addItem('Import leads...', 'showImportDialog')
    .addItem('Write copy for new leads', 'prepareLeads')
    .addItem('Run one send window now', 'sendWindow')
    .addSeparator()
    .addItem('Check replies and bounces', 'checkRepliesAndBounces')
    .addItem('Show status', 'showStatus')
    .addSeparator()
    .addItem('Remove all triggers', 'removeTriggers')
    .addToUi();
}

/** Creates the Leads, Suppression and Log tabs. Safe to run again. */
function setupWorkbook() {
  var book = ss();

  var leads = book.getSheetByName(TAB_LEADS) || book.insertSheet(TAB_LEADS);
  if (leads.getLastRow() === 0) leads.getRange(1, 1, 1, LAST_COL).setValues([LEADS_HEADERS]);
  styleHeader(leads, LAST_COL);
  leads.setFrozenColumns(5);

  var sup = book.getSheetByName(TAB_SUPPRESSION) || book.insertSheet(TAB_SUPPRESSION);
  if (sup.getLastRow() === 0) sup.getRange(1, 1, 1, 3).setValues([['Email', 'Reason', 'Added At']]);
  styleHeader(sup, 3);

  var log = book.getSheetByName(TAB_LOG) || book.insertSheet(TAB_LOG);
  if (log.getLastRow() === 0) {
    log.getRange(1, 1, 1, 5).setValues([['Timestamp', 'Email', 'Step', 'Result', 'Detail']]);
  }
  styleHeader(log, 5);

  getUnsubscribeSecret(); // create the signing key before the first send

  SpreadsheetApp.getUi().alert(
    'Workbook ready.\n\n' +
    'Next:\n' +
    '1. Fill in the YOUR_... values in Config.gs.\n' +
    '2. Deploy the web app and run captureWebAppUrl so unsubscribe links work.\n' +
    '3. Install triggers.\n\n' +
    'DRY_RUN is ' + isTrue(CONFIG.DRY_RUN) + '. Nothing sends while it is true.');
}

function styleHeader(sheet, cols) {
  sheet.getRange(1, 1, 1, cols).setFontWeight('bold')
    .setBackground('#1f2937').setFontColor('#ffffff');
  sheet.setFrozenRows(1);
}

/**
 * One send trigger per hour in SEND_HOURS, so the day's cap goes out in
 * small batches rather than one burst. Replies and bounces are checked
 * hourly, because a follow-up to someone who already replied is the worst
 * thing a sequencer can do.
 */
function installTriggers() {
  removeTriggers();
  ScriptApp.newTrigger('prepareLeads').timeBased().atHour(6).everyDays(1).create();
  CONFIG.SEND_HOURS.forEach(function (hour) {
    ScriptApp.newTrigger('sendWindow').timeBased().atHour(hour).everyDays(1).create();
  });
  ScriptApp.newTrigger('checkRepliesAndBounces').timeBased().everyHours(1).create();

  SpreadsheetApp.getUi().alert(
    'Triggers installed (script timezone ' + Session.getScriptTimeZone() + '):\n' +
    'prepareLeads at 6:00, sendWindow at ' + CONFIG.SEND_HOURS.join(':00, ') + ':00, ' +
    'checkRepliesAndBounces hourly.\n\n' +
    'Apps Script runs each trigger at some point within its hour, not on the minute.');
}

function removeTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
}

function showStatus() {
  var today = todayYmd();
  var week = warmupWeek(CONFIG.RAMP_START_DATE, today);
  var cap = dailyCap(week, CONFIG.DAILY_CAP_MAX, CONFIG.WARMUP_RAMP);
  var counts = {};
  readLeads(leadsSheet()).forEach(function (l) {
    if (l.status) counts[l.status] = (counts[l.status] || 0) + 1;
  });

  var lines = [
    'Mode: ' + (isTrue(CONFIG.DRY_RUN) ? 'DRY RUN (nothing sends)' : 'LIVE'),
    'Today: ' + countSentToday(today) + ' / ' + cap + ' sent (warmup week ' + week + ')',
    'Send day: ' + (isSendDay(new Date().getDay(), CONFIG.SEND_DAYS) ? 'yes' : 'no'),
    '', 'Leads by status:'
  ];
  Object.keys(counts).sort().forEach(function (k) { lines.push('  ' + k + ': ' + counts[k]); });

  var blocker = preflightBlocker();
  if (blocker) lines.push('', 'Live sending blocked: ' + blocker);

  SpreadsheetApp.getUi().alert(lines.join('\n'));
}
