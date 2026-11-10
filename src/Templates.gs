/**
 * Templates.gs: the three emails.
 *
 * The copy below is example text for a fictional B2B SaaS that sends
 * invoice reminders for small finance teams. Replace it with your own.
 *
 * Placeholders:
 *   {{field}}            must have a value, or the lead is not prepared
 *   {{field|fallback}}   uses the fallback text when the field is empty
 *
 * Fields: firstName, lastName, company, website, city, industry,
 *         personalLine, fromName, senderCompany
 *
 * prepareLeads() fills these into each lead's row on the Leads tab, so you
 * can read and edit every email before it goes out. The sender uses
 * whatever is in the row, not this file.
 *
 * Emails 2 and 3 are sent as replies on the email 1 thread, so their subject
 * is only used if that thread can no longer be found.
 */

var TEMPLATES = [
  {
    step: 1,
    subject: 'late invoices at {{company}}',
    body:
      'Hi {{firstName|there}},\n\n' +
      '{{personalLine|Most finance teams I talk to spend a few hours a week chasing late invoices by hand.}}\n\n' +
      'We built a small tool that sends polite, well-timed payment reminders ' +
      'from your own inbox and stops the moment a customer pays or replies.\n\n' +
      'Is chasing payments something your team still does by hand?'
  },
  {
    step: 2,
    subject: 'Re: late invoices at {{company}}',
    body:
      'Hi {{firstName|there}},\n\n' +
      'One thing teams tell us: the hard part is not writing the reminder, ' +
      'it is remembering which invoices are overdue and who already got a nudge.\n\n' +
      'The tool keeps that list for you and shows what was sent and when.\n\n' +
      'Worth a 15-minute look?'
  },
  {
    step: 3,
    subject: 'Re: late invoices at {{company}}',
    body:
      'Hi {{firstName|there}},\n\n' +
      'I will leave it here. If late payments become a priority at ' +
      '{{company}} later on, reply to this email and I will send a short demo.\n\n' +
      'Thanks for reading.'
  }
];

/**
 * Renders all three emails for a lead.
 * Returns { emails: [{subject, body}, ...], missing: [...] }.
 */
function renderSequence(lead) {
  var fields = personalisationFields(lead, senderSettings());
  var missing = [];
  var emails = TEMPLATES.map(function (t) {
    var subject = fillTemplate(t.subject, fields);
    var body = fillTemplate(t.body, fields);
    subject.missing.concat(body.missing).forEach(function (m) {
      if (missing.indexOf(m) === -1) missing.push(m);
    });
    return { subject: subject.text, body: body.text };
  });
  return { emails: emails, missing: missing };
}
