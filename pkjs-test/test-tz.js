/* node pkjs-test/test-tz.js — VTIMEZONE / TZID resolution + all-day no-shift. */
var ics = require('../src/pkjs/ics.js');

var failures = 0;
function assert(c, m) { console.log((c ? '  ok   - ' : '  FAIL - ') + m); if (!c) failures++; }

var ICS = [
  'BEGIN:VCALENDAR',
  'BEGIN:VTIMEZONE',
  'TZID:America/New_York',
  'BEGIN:DAYLIGHT',
  'TZOFFSETFROM:-0500',
  'TZOFFSETTO:-0400',
  'DTSTART:20070311T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU',
  'END:DAYLIGHT',
  'BEGIN:STANDARD',
  'TZOFFSETFROM:-0400',
  'TZOFFSETTO:-0500',
  'DTSTART:20071104T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU',
  'END:STANDARD',
  'END:VTIMEZONE',
  'BEGIN:VEVENT',
  'UID:ny-summer',
  'SUMMARY:NY summer',
  'DTSTART;TZID=America/New_York:20260615T090000',  // June -> EDT (-0400)
  'DTEND;TZID=America/New_York:20260615T100000',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:ny-winter',
  'SUMMARY:NY winter',
  'DTSTART;TZID=America/New_York:20260115T090000',  // Jan -> EST (-0500)
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:utc-ev',
  'SUMMARY:UTC event',
  'DTSTART:20260615T120000Z',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:allday',
  'SUMMARY:All day',
  'DTSTART;VALUE=DATE:20260615',
  'END:VEVENT',
  'END:VCALENDAR'
].join('\r\n');

var evs = ics.parseICS(ICS);
function byUid(u) { return evs.filter(function (e) { return e.uid === u; })[0]; }

// 09:00 EDT (June) == 13:00 UTC
assert(byUid('ny-summer').start.getTime() === Date.UTC(2026, 5, 15, 13, 0, 0),
       'TZID summer (EDT -0400): 09:00 -> 13:00Z');
// 09:00 EST (January) == 14:00 UTC
assert(byUid('ny-winter').start.getTime() === Date.UTC(2026, 0, 15, 14, 0, 0),
       'TZID winter (EST -0500): 09:00 -> 14:00Z');
// UTC stays exact
assert(byUid('utc-ev').start.getTime() === Date.UTC(2026, 5, 15, 12, 0, 0),
       'UTC (Z) stays exact');
// All-day = local midnight on that date, never shifted by tz
var ad = byUid('allday').start;
assert(ad.getFullYear() === 2026 && ad.getMonth() === 5 && ad.getDate() === 15 &&
       ad.getHours() === 0 && ad.getMinutes() === 0,
       'all-day is local midnight, no shift');
// Duration preserved (1h) for the summer event
assert(byUid('ny-summer').end.getTime() - byUid('ny-summer').start.getTime() === 3600000,
       'TZID event duration preserved (1h)');

console.log(failures === 0 ? '\nALL PASSED' : '\n' + failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);
