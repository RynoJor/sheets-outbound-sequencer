// Tests for src/Core.js, the pure logic the Apps Script files call.
// Run with: npm test   (or: node --test test/)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../src/Core.js');

const { STATUS } = core;

function lead(overrides) {
  return Object.assign({
    status: STATUS.READY, email: 'pat@example.com', sent1: '', sent2: '', sent3: ''
  }, overrides);
}

// ---------------------------------------------------------------------------
// Cadence: day 0, +3, +6
// ---------------------------------------------------------------------------

test('a ready lead is due for email 1', () => {
  assert.equal(core.dueStep(lead(), '2026-03-02'), 1);
});

test('a new lead (no copy yet) is not due', () => {
  assert.equal(core.dueStep(lead({ status: STATUS.NEW }), '2026-03-02'), 0);
});

test('email 2 is due 3 calendar days after email 1, not before', () => {
  const l = lead({ status: STATUS.IN_SEQUENCE, sent1: '2026-03-02' });
  assert.equal(core.dueStep(l, '2026-03-04'), 0);
  assert.equal(core.dueStep(l, '2026-03-05'), 2);
});

test('email 3 is due 3 days after email 2 (day +6 overall)', () => {
  const l = lead({ status: STATUS.IN_SEQUENCE, sent1: '2026-03-02', sent2: '2026-03-05' });
  assert.equal(core.dueStep(l, '2026-03-07'), 0);
  assert.equal(core.dueStep(l, '2026-03-08'), 3);
});

test('a late email 2 pushes email 3 back too', () => {
  // Email 2 slipped to day +5 (say, a weekend); email 3 waits until +8.
  const l = lead({ status: STATUS.IN_SEQUENCE, sent1: '2026-03-02', sent2: '2026-03-07' });
  assert.equal(core.dueStep(l, '2026-03-08'), 0);
  assert.equal(core.dueStep(l, '2026-03-10'), 3);
});

test('nothing is due after email 3', () => {
  const l = lead({ status: STATUS.IN_SEQUENCE, sent1: '2026-03-02', sent2: '2026-03-05',
                   sent3: '2026-03-08' });
  assert.equal(core.dueStep(l, '2026-04-01'), 0);
});

test('replied, bounced and unsubscribed leads are never due', () => {
  for (const status of [STATUS.REPLIED, STATUS.BOUNCED, STATUS.UNSUBSCRIBED,
                        STATUS.COMPLETED, STATUS.INVALID]) {
    const l = lead({ status, sent1: '2026-03-02' });
    assert.equal(core.dueStep(l, '2026-03-20'), 0, status);
  }
});

test('a suppressed address is never due, whatever its status says', () => {
  const l = lead({ email: 'Pat@Example.com ' });
  assert.equal(core.dueStep(l, '2026-03-02', null, { 'pat@example.com': true }), 0);
});

test('calendar days ignore the time of day and cross month ends', () => {
  assert.equal(core.calendarDaysBetween('2026-02-27', '2026-03-02'), 3);
  assert.equal(core.calendarDaysBetween('2026-03-02', '2026-03-02'), 0);
  assert.equal(core.calendarDaysBetween('bad', '2026-03-02'), null);
});

test('the queue puts follow-ups before new sends and respects slots', () => {
  const today = '2026-03-10';
  const leads = [
    lead({ email: 'new1@example.com' }),
    lead({ email: 'step2@example.com', status: STATUS.IN_SEQUENCE, sent1: '2026-03-06' }),
    lead({ email: 'new2@example.com' }),
    lead({ email: 'step3@example.com', status: STATUS.IN_SEQUENCE,
           sent1: '2026-03-01', sent2: '2026-03-05' }),
    lead({ email: 'replied@example.com', status: STATUS.REPLIED, sent1: '2026-03-01' })
  ];
  const q = core.buildSendQueue(leads, today, 3);
  assert.deepEqual(q.map((i) => [i.lead.email, i.step]), [
    ['step3@example.com', 3], ['step2@example.com', 2], ['new1@example.com', 1]
  ]);
  assert.equal(core.buildSendQueue(leads, today, 0).length, 0);
});

// ---------------------------------------------------------------------------
// Caps and pacing
// ---------------------------------------------------------------------------

test('warmup week counts from the ramp start date', () => {
  assert.equal(core.warmupWeek('2026-03-02', '2026-03-01'), 0); // not started
  assert.equal(core.warmupWeek('2026-03-02', '2026-03-02'), 1);
  assert.equal(core.warmupWeek('2026-03-02', '2026-03-08'), 1);
  assert.equal(core.warmupWeek('2026-03-02', '2026-03-09'), 2);
  assert.equal(core.warmupWeek('2026-03-02', '2026-04-20'), 8);
});

test('daily cap follows the ramp, then the max, and never exceeds the max', () => {
  assert.equal(core.dailyCap(0, 50), 0);
  assert.equal(core.dailyCap(1, 50), 10);
  assert.equal(core.dailyCap(4, 50), 40);
  assert.equal(core.dailyCap(9, 50), 50);
  assert.equal(core.dailyCap(3, 25), 25); // ramp says 30, max wins
  assert.equal(core.dailyCap(2, 50, [5, 5]), 5);
});

test('each window gets its share of the cap, never more than what is left', () => {
  assert.equal(core.slotsForWindow(50, 0, 4), 13);
  assert.equal(core.slotsForWindow(50, 45, 4), 5);
  assert.equal(core.slotsForWindow(50, 50, 4), 0);
  assert.equal(core.slotsForWindow(50, 60, 4), 0);
  assert.equal(core.slotsForWindow(10, 0, 4), 3);
  assert.equal(core.slotsForWindow(0, 0, 4), 0);
});

test('four windows at 13 slots cannot pass a cap of 50', () => {
  let sent = 0;
  for (let w = 0; w < 4; w++) sent += core.slotsForWindow(50, sent, 4);
  assert.equal(sent, 50);
});

test('send days', () => {
  // 2026-03-02 is a Monday.
  const mon = new Date(2026, 2, 2).getDay();
  const fri = new Date(2026, 2, 6).getDay();
  assert.equal(core.isSendDay(mon, 'Mon,Tue,Wed,Thu'), true);
  assert.equal(core.isSendDay(fri, 'Mon,Tue,Wed,Thu'), false);
  assert.equal(core.isSendDay(fri, 'monday, friday'), true);
});

test('jitter stays inside its bounds', () => {
  assert.equal(core.jitterMs(5000, 20000, () => 0), 5000);
  assert.equal(core.jitterMs(5000, 20000, () => 0.999999), 20000);
});

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

test('fills fields and uses fallbacks for empty ones', () => {
  const r = core.fillTemplate('Hi {{firstName|there}}, {{ company }} {{personalLine|-}}',
                              { firstName: 'Pat', company: 'Sample Co', personalLine: '  ' });
  assert.equal(r.text, 'Hi Pat, Sample Co -');
  assert.deepEqual(r.missing, []);
});

test('reports fields with no value and no fallback, once each', () => {
  const r = core.fillTemplate('{{company}} and {{company}} for {{firstName}}', { firstName: 'Pat' });
  assert.deepEqual(r.missing, ['company']);
  assert.match(r.text, /\{\{company\}\}/); // left visible, never silently blank
});

test('an empty fallback is allowed', () => {
  assert.equal(core.fillTemplate('a{{x|}}b', {}).text, 'ab');
});

test('the shipped templates fill cleanly from every sample lead', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'Templates.gs'), 'utf8');
  const templates = new Function(src + '; return TEMPLATES;')();
  const sample = parseCsv(fs.readFileSync(path.join(__dirname, '..', 'sample-sheet.csv'), 'utf8'));
  const map = core.mapHeaders(sample[0]);
  assert.ok(map.email !== undefined, 'sample CSV needs an Email column');
  for (const row of sample.slice(1)) {
    const l = {};
    for (const [field, idx] of Object.entries(map)) l[field] = row[idx];
    assert.ok(core.looksLikeEmail(l.email), l.email);
    const fields = core.personalisationFields(l, { fromName: 'Sam', senderCompany: 'Example SaaS Co' });
    for (const t of templates) {
      assert.deepEqual(core.fillTemplate(t.subject, fields).missing, [], l.email);
      assert.deepEqual(core.fillTemplate(t.body, fields).missing, [], l.email);
    }
  }
});

test('the footer always carries an address and a way out', () => {
  const sender = { fromName: 'Sam', senderCompany: 'Example SaaS Co', physicalAddress: '1 Sample St' };
  const withLink = core.withFooter('Body', sender, 'SIGNED_LINK');
  assert.match(withLink, /1 Sample St/);
  assert.match(withLink, /Unsubscribe here: SIGNED_LINK/);
  assert.match(core.withFooter('Body', sender, ''), /Reply "unsubscribe"/);
});

// ---------------------------------------------------------------------------
// Replies, bounces, opt-outs
// ---------------------------------------------------------------------------

test('a reply from someone else counts; ours, bounces do not', () => {
  const ours = ['me@sender.example'];
  assert.equal(core.isHumanReply('Pat <pat@example.com>', ours), true);
  assert.equal(core.isHumanReply('Me <ME@sender.example>', ours), false);
  assert.equal(core.isHumanReply('Mail Delivery Subsystem <mailer-daemon@mail.example>', ours), false);
});

test('out-of-office subjects are not replies', () => {
  assert.equal(core.isAutoReply('Automatic reply: late invoices'), true);
  assert.equal(core.isAutoReply('Out of Office: back Monday'), true);
  assert.equal(core.isAutoReply('Re: late invoices at Sample Co'), false);
});

test('hard bounces name whole addresses only; soft bounces name none', () => {
  const candidates = ['jo@example.com', 'anjo@example.com', 'pat@example.com'];
  const hard = 'Delivery to the following recipient failed permanently:\n\n    jo@example.com.\n';
  assert.deepEqual(core.bouncedAddresses(hard, candidates), ['jo@example.com']);
  const soft = "Message to pat@example.com delayed: mailbox is full, we'll try again later.";
  assert.deepEqual(core.bouncedAddresses(soft, candidates), []);
});

test('opt-out replies are recognised', () => {
  assert.equal(core.isOptOutReply('Please remove me from your list.'), true);
  assert.equal(core.isOptOutReply('UNSUBSCRIBE'), true);
  assert.equal(core.isOptOutReply('Not now, try me in June.'), false);
});

// ---------------------------------------------------------------------------
// Minimal CSV reader for the sample file (quoted fields, commas inside quotes).
// ---------------------------------------------------------------------------

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.join('') !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}
