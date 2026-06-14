/*
 * Plain-node unit test for src/pkjs/ics.js — no Pebble/network needed.
 * Run: node pkjs-test/test-ics.js
 */
var ics = require('../src/pkjs/ics.js');

var SAMPLE = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'UID:single-1',
  'SUMMARY:One-off meeting',
  'DTSTART:20260605T100000Z',
  'DTEND:20260605T110000Z',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:allday-1',
  'SUMMARY:Holiday',
  'DTSTART;VALUE=DATE:20260612',
  'DTEND;VALUE=DATE:20260613',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:weekly-1',
  'SUMMARY:Monday standup with a very long folded title that contin',
  ' ues onto the next line',
  'DTSTART:20260601T090000',
  'DTEND:20260601T093000',
  'RRULE:FREQ=WEEKLY;BYDAY=MO',
  'EXDATE:20260615T090000',
  'END:VEVENT',
  'END:VCALENDAR'
].join('\r\n');

var failures = 0;
function assert(cond, msg) {
  if (cond) { console.log('  ok   - ' + msg); }
  else { console.log('  FAIL - ' + msg); failures++; }
}

var events = ics.parseICS(SAMPLE);
assert(events.length === 3, 'parsed 3 VEVENTs (got ' + events.length + ')');
assert(events[1].allDay === true, 'all-day event detected');
assert(/continues onto/.test(events[2].title || events[2].summary),
       'folded SUMMARY line unfolded');

// Visible window: all of June 2026 (+ a day of buffer).
var winStart = new Date(2026, 5, 1);
var winEnd = new Date(2026, 6, 1);
var instances = ics.expandEvents(events, winStart, winEnd);

// Mondays in June 2026: 1, 8, 15, 22, 29. EXDATE removes the 15th -> 1,8,22,29.
var mondayInstances = instances.filter(function (i) { return i.uid === 'weekly-1'; })
  .map(function (i) { return i.start.getDate(); }).sort(function (a, b) { return a - b; });
assert(JSON.stringify(mondayInstances) === JSON.stringify([1, 8, 22, 29]),
       'weekly RRULE expanded with EXDATE (got [' + mondayInstances + '])');

var sum = ics.monthSummary(instances, 2026, 5);
var nonZero = {};
sum.counts.forEach(function (c, i) { if (c) nonZero[i + 1] = c; });
var expected = { 1: 1, 5: 1, 8: 1, 12: 1, 22: 1, 29: 1 };
assert(JSON.stringify(nonZero) === JSON.stringify(expected),
       'month summary counts correct (got ' + JSON.stringify(nonZero) + ')');

// COUNT + INTERVAL daily expansion sanity.
var daily = ics.parseICS([
  'BEGIN:VEVENT', 'UID:d', 'SUMMARY:Every other day x3',
  'DTSTART:20260601T080000', 'RRULE:FREQ=DAILY;INTERVAL=2;COUNT=3',
  'END:VEVENT'
].join('\r\n'));
var dinst = ics.expandEvents(daily, winStart, winEnd)
  .map(function (i) { return i.start.getDate(); }).sort(function (a, b) { return a - b; });
assert(JSON.stringify(dinst) === JSON.stringify([1, 3, 5]),
       'DAILY INTERVAL=2 COUNT=3 -> [1,3,5] (got [' + dinst + '])');

console.log(failures === 0 ? '\nALL PASSED' : '\n' + failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);
