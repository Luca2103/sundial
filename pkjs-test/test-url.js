/* node pkjs-test/test-url.js — calendar URL normalization, no Pebble needed. */
var gcal = require('../src/pkjs/gcal.js');

var failures = 0;
function assert(c, m) { console.log((c ? '  ok   - ' : '  FAIL - ') + m); if (!c) failures++; }

// base64 sanity: the user's cid decodes to their email.
assert(gcal.base64Decode('YWxleDUyM2FwQGdtYWlsLmNvbQ') === 'alex523ap@gmail.com',
       'base64 cid -> alex523ap@gmail.com');

// Google cid share link -> public ICS feed.
var cidLink = 'https://calendar.google.com/calendar/u/0?cid=YWxleDUyM2FwQGdtYWlsLmNvbQ';
assert(gcal.normalizeCalendarUrl(cidLink) ===
       'https://calendar.google.com/calendar/ical/alex523ap%40gmail.com/public/basic.ics',
       'cid link -> public basic.ics');

// Group calendar id (contains @group.calendar.google.com).
var groupId = 'abc123@group.calendar.google.com';
var groupCid = Buffer.from(groupId).toString('base64');
assert(gcal.normalizeCalendarUrl('https://calendar.google.com/calendar/r?cid=' + groupCid) ===
       'https://calendar.google.com/calendar/ical/' + encodeURIComponent(groupId) + '/public/basic.ics',
       'group cid link -> public basic.ics');

// webcal -> https.
assert(gcal.normalizeCalendarUrl('webcal://p1.icloud.com/x/y.ics') === 'https://p1.icloud.com/x/y.ics',
       'webcal -> https');

// Passthrough: an already-ICS public URL.
var pub = 'https://calendar.google.com/calendar/ical/foo%40gmail.com/public/basic.ics';
assert(gcal.normalizeCalendarUrl(pub) === pub, 'public basic.ics passthrough');

// Passthrough: a Google secret (private) iCal address.
var secret = 'https://calendar.google.com/calendar/ical/foo%40gmail.com/private-abcdef/basic.ics';
assert(gcal.normalizeCalendarUrl(secret) === secret, 'secret iCal address passthrough');

// Passthrough: a plain iCloud ICS https URL.
var icloud = 'https://p1-caldav.icloud.com/published/2/TOKEN';
assert(gcal.normalizeCalendarUrl(icloud) === icloud, 'plain https ICS passthrough');

console.log(failures === 0 ? '\nALL PASSED' : '\n' + failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);
