/*
 * gcal.js — calendar URL normalization (PebbleKit JS).
 *
 * Lets the user paste a Google Calendar share link instead of dealing with
 * OAuth: a Google "cid" link carries the calendar id as base64, and a PUBLIC
 * Google calendar is served as ICS at
 *   https://calendar.google.com/calendar/ical/<calId>/public/basic.ics
 * So we decode the cid and rewrite to that ICS URL — then it flows through the
 * exact same ICS pipeline as iCloud.
 *
 * Also handles webcal:// (-> https://) and passes anything else through
 * unchanged (an already-ICS URL, or a Google "secret address" .../private-.../
 * basic.ics, which works without making the calendar public).
 *
 * Exported as CommonJS so it can be unit-tested under plain node.
 */

// Minimal base64 decoder (don't assume atob exists in PKJS). Tolerates
// url-safe alphabet and missing padding.
function base64Decode(input) {
  var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  var s = String(input).replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+/]/g, '');
  var out = '';
  for (var i = 0; i < s.length; i += 4) {
    // Past-the-end chars are absent (not padding) — track that explicitly so we
    // don't emit phantom bytes for the final partial group.
    var has2 = i + 2 < s.length, has3 = i + 3 < s.length;
    var e0 = chars.indexOf(s.charAt(i));
    var e1 = chars.indexOf(s.charAt(i + 1));
    var e2 = has2 ? chars.indexOf(s.charAt(i + 2)) : 0;
    var e3 = has3 ? chars.indexOf(s.charAt(i + 3)) : 0;
    var n = (e0 << 18) | (e1 << 12) | (e2 << 6) | e3;
    out += String.fromCharCode((n >> 16) & 255);
    if (has2) out += String.fromCharCode((n >> 8) & 255);
    if (has3) out += String.fromCharCode(n & 255);
  }
  return out;
}

function googlePublicIcs(calId) {
  return 'https://calendar.google.com/calendar/ical/' +
         encodeURIComponent(calId) + '/public/basic.ics';
}

// Turn whatever the user pasted into a fetchable ICS URL.
function normalizeCalendarUrl(url) {
  if (!url) return url;
  var u = String(url).trim();

  if (/^webcal:\/\//i.test(u)) return u.replace(/^webcal:\/\//i, 'https://');

  // Google share / embed link with a base64 cid -> public ICS feed.
  if (/calendar\.google\.com/i.test(u)) {
    var m = u.match(/[?&]cid=([^&#]+)/i);
    if (m) {
      var calId = base64Decode(decodeURIComponent(m[1]));
      // A valid calendar id looks like an email / ...@group.calendar.google.com
      if (calId && calId.indexOf('@') > 0) return googlePublicIcs(calId);
    }
    // Otherwise it's already an ical/basic.ics (public or secret) URL — leave it.
  }

  return u;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    base64Decode: base64Decode,
    normalizeCalendarUrl: normalizeCalendarUrl
  };
}
