/*
 * index.js — PebbleKit JS entry point.
 *
 * Owns ALL networking and parsing (the watch only renders). It fetches the
 * configured ICS feed(s), parses + caches the VEVENTs, and answers the watch's
 * requests: a per-day month summary (dots), a single day's events, and the
 * next/previous day that has events (agenda scrolling). Recurrence is fully
 * expanded here — the watch never sees an RRULE.
 *
 * Calendars are entered on the settings page (config.js) and stored as a JSON
 * array in localStorage('icsUrls'); if none are set we fall back to an embedded
 * SAMPLE so the pipeline is demonstrable offline. PKJS fetch is NOT CORS-bound,
 * so fetching iCloud/Google feeds here is fine.
 */

var ics = require('./ics');
var config = require('./config');
var gcal = require('./gcal');

// Embedded dev fallback (used only when no calendars are configured).
var SAMPLE_ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'UID:sample-standup',
  'SUMMARY:Team standup',
  'DTSTART:20260601T090000',
  'DTEND:20260601T093000',
  'RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR',
  'EXDATE:20260619T090000',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:sample-deadline',
  'SUMMARY:Project deadline',
  'DTSTART;VALUE=DATE:20260603',
  'DTEND;VALUE=DATE:20260604',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:sample-dentist',
  'SUMMARY:Dentist',
  'DTSTART:20260614T160000Z',
  'DTEND:20260614T170000Z',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:sample-payday',
  'SUMMARY:Payday',
  'DTSTART;VALUE=DATE:20260125',
  'RRULE:FREQ=MONTHLY',
  'END:VEVENT',
  'END:VCALENDAR'
].join('\r\n');

var MSG_REQUEST_MONTH = 1;  // watch -> JS
var MSG_MONTH_SUMMARY = 2;  // JS -> watch
var MSG_ERROR = 3;          // JS -> watch
var MSG_REQUEST_DAY = 4;    // watch -> JS
var MSG_DAY_EVENTS = 5;     // JS -> watch
var MSG_SETTINGS = 6;       // JS -> watch (week start)
var MSG_SYNC_INFO = 7;      // JS -> watch (confirmation card)
var MSG_REQUEST_ADJ = 8;    // watch -> JS (next/prev day with events)

var MAX_DAY_EVENTS = 16;
var MAX_TITLE_LEN = 28;     // chars, for the sync-card "next" text
var MAX_TITLE_BYTES = 60;   // UTF-8 bytes, for day-event titles (watch buffer = 64)

// Truncate a string to at most maxBytes of UTF-8 WITHOUT splitting a character —
// a mid-character cut yields invalid UTF-8 that the watch renders as blank.
function truncateUtf8(s, maxBytes) {
  var out = '', bytes = 0;
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i), cp = c, extra = 0;
    if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length) {   // surrogate pair
      var c2 = s.charCodeAt(i + 1);
      if (c2 >= 0xDC00 && c2 <= 0xDFFF) { cp = 0x10000 + ((c - 0xD800) << 10) + (c2 - 0xDC00); extra = 1; }
    }
    var n = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (bytes + n > maxBytes) break;
    out += s.substr(i, 1 + extra);
    bytes += n;
    i += extra;
  }
  return out;
}
var ADJ_HORIZON_DAYS = 365; // how far to look for the next/prev non-empty day

var cachedEvents = null;    // parsed VEVENTs, merged across all feeds

// --- settings access -------------------------------------------------------

// Configured calendar URLs (array). Migrates the legacy single-URL key.
function getIcsUrls() {
  try {
    var raw = localStorage.getItem('icsUrls');
    if (raw) {
      var arr = JSON.parse(raw);
      if (Array.isArray(arr)) return arr.filter(function (u) { return u && u.trim(); });
    }
  } catch (e) { /* ignore */ }
  try {
    var single = localStorage.getItem('icsUrl');
    if (single) return [single];
  } catch (e) { /* ignore */ }
  return [];   // empty -> SAMPLE fallback
}

function getWeekStart() {
  try { return localStorage.getItem('weekStart') === '0' ? 0 : 1; } catch (e) { return 1; }
}

function hasExplicitWeekStart() {
  try { return localStorage.getItem('weekStart') !== null; } catch (e) { return false; }
}

function getAccent() {
  try {
    var v = parseInt(localStorage.getItem('accent'), 10);
    return isNaN(v) ? 0x00AAFF : (v & 0xFFFFFF);
  } catch (e) { return 0x00AAFF; }
}

function hasExplicitAccent() {
  try { return localStorage.getItem('accent') !== null; } catch (e) { return false; }
}

function getLastSync() {
  try { return JSON.parse(localStorage.getItem('lastSync')); } catch (e) { return null; }
}

// --- fetching --------------------------------------------------------------

// Fetch every configured feed in parallel; calls done(results, anyOk) where
// results is [{url, text}, ...] for the feeds that succeeded.
function fetchAll(done) {
  var urls = getIcsUrls();
  if (!urls.length) {
    console.log('No calendars configured; using embedded SAMPLE_ICS.');
    done([{ url: '(sample)', text: SAMPLE_ICS }], true);
    return;
  }
  var results = [], remaining = urls.length, anyOk = false;
  urls.forEach(function (u) {
    var httpUrl = gcal.normalizeCalendarUrl(u);   // webcal/Google cid -> ICS URL
    var xhr = new XMLHttpRequest();
    function finish(text, err) {
      if (text != null) { results.push({ url: u, text: text }); anyOk = true; }
      else console.log('Fetch failed [' + u + ']: ' + err);
      if (--remaining === 0) done(results, anyOk);
    }
    xhr.open('GET', httpUrl, true);
    xhr.timeout = 20000;
    xhr.onload = function () {
      if (xhr.status >= 200 && xhr.status < 300) finish(xhr.responseText, null);
      else finish(null, 'HTTP ' + xhr.status);
    };
    xhr.onerror = function () { finish(null, 'network error'); };
    xhr.ontimeout = function () { finish(null, 'timeout'); };
    console.log('Fetching ICS: ' + httpUrl);
    xhr.send();
  });
}

// Fetch + parse + merge all feeds into cachedEvents. sendCard controls whether
// the on-watch confirmation card fires (only true after a config save).
function loadEvents(callback, sendCard) {
  var configured = getIcsUrls().length;
  fetchAll(function (results, anyOk) {
    if (configured && !anyOk) { callback('All calendar feeds failed'); return; }
    var merged = [];
    results.forEach(function (r) {
      try {
        var evs = ics.parseICS(r.text);
        for (var i = 0; i < evs.length; i++) { evs[i].source = r.url; merged.push(evs[i]); }
      } catch (e) {
        console.log('Parse failed [' + r.url + ']: ' + e.message);
      }
    });
    cachedEvents = merged;
    console.log('Parsed ' + merged.length + ' VEVENT(s) from ' + results.length + ' feed(s).');
    updateLastSync(sendCard);
    callback(null);
  });
}

// --- last-sync summary + confirmation card ---------------------------------

function updateLastSync(sendCard) {
  var now = new Date();
  var monthInst = ics.expandEvents(cachedEvents || [],
    new Date(now.getFullYear(), now.getMonth(), 1),
    new Date(now.getFullYear(), now.getMonth() + 1, 1));
  var count = monthInst.length;

  var upcoming = ics.expandEvents(cachedEvents || [], now, new Date(now.getTime() + 60 * 86400000))
    .filter(function (i) { return i.start >= now; })
    .sort(function (a, b) { return a.start - b.start; });
  var nextTitle = upcoming.length ? upcoming[0].title : '';
  var nextDate = '';
  if (upcoming.length) {
    var d = upcoming[0].start;
    nextDate = (d.getMonth() + 1) + '/' + d.getDate();
  }

  try {
    localStorage.setItem('lastSync', JSON.stringify(
      { count: count, nextTitle: nextTitle, nextDate: nextDate }));
  } catch (e) { /* ignore */ }

  // Only nudge the watch's confirmation card after an explicit config save.
  if (sendCard) {
    Pebble.sendAppMessage({
      MsgType: MSG_SYNC_INFO,
      SyncCount: count,
      SyncNext: (nextTitle ? nextTitle.substr(0, MAX_TITLE_LEN) : '') +
                (nextDate ? ' ' + nextDate : '')
    });
  }
}

function sendSettings() {
  // Push only what the user explicitly chose; leave the watch's own persisted
  // values (e.g. the long-press week-start toggle) alone otherwise.
  var msg = { MsgType: MSG_SETTINGS };
  var any = false;
  if (hasExplicitWeekStart()) { msg.WeekStart = getWeekStart(); any = true; }
  if (hasExplicitAccent()) { msg.AccentColor = getAccent(); any = true; }
  if (!any) return;
  Pebble.sendAppMessage(msg);
}

function sendError(msg) {
  Pebble.sendAppMessage({ MsgType: MSG_ERROR, ErrMsg: String(msg).substr(0, 60) });
}

// --- month summary ---------------------------------------------------------

function sendMonthSummary(year, month0) {
  var winStart = new Date(year, month0 - 1, 1);
  var winEnd = new Date(year, month0 + 2, 1);
  var instances = ics.expandEvents(cachedEvents || [], winStart, winEnd);
  var summary = ics.monthSummary(instances, year, month0);

  console.log('Month summary ' + (month0 + 1) + '/' + year + ': counts=[' +
              summary.counts.join(',') + ']');

  Pebble.sendAppMessage({
    MsgType: MSG_MONTH_SUMMARY,
    Year: year,
    Month: month0,
    DayCounts: summary.counts
  }, function () {}, function (e) {
    console.log('Failed to send month summary: ' + JSON.stringify(e));
  });
}

function respondForMonth(year, month0) {
  if (cachedEvents) { sendMonthSummary(year, month0); return; }
  loadEvents(function (err) {
    if (err) { console.log('Load failed: ' + err); sendError(err); return; }
    sendMonthSummary(year, month0);
  });
}

// --- day detail / agenda ---------------------------------------------------

// True if an instance covers the given calendar day. All-day DTEND is exclusive.
function instanceCoversDay(inst, year, month0, day) {
  var dayStart = new Date(year, month0, day);
  var dayEnd = new Date(year, month0, day + 1);
  var end = inst.end || inst.start;
  if (inst.allDay && end > inst.start) end = new Date(end.getTime() - 1);
  return inst.start < dayEnd && end >= dayStart;
}

function sendDayEvents(year, month0, day) {
  var instances = ics.expandEvents(cachedEvents || [],
    new Date(year, month0, day - 1), new Date(year, month0, day + 2));

  var dayList = instances.filter(function (inst) {
    return instanceCoversDay(inst, year, month0, day);
  });

  dayList.sort(function (a, b) {
    var ra = a.allDay ? -1 : a.start.getHours() * 60 + a.start.getMinutes();
    var rb = b.allDay ? -1 : b.start.getHours() * 60 + b.start.getMinutes();
    return ra - rb;
  });

  // Pack into one cstring: lines "<startMins|-1>\t<endMins|-1>\t<title>".
  var lines = [];
  for (var i = 0; i < dayList.length && i < MAX_DAY_EVENTS; i++) {
    var e = dayList[i];
    var startMins = e.allDay ? -1 : e.start.getHours() * 60 + e.start.getMinutes();
    var endMins = (e.allDay || !e.end) ? -1 : e.end.getHours() * 60 + e.end.getMinutes();
    var title = truncateUtf8((e.title || '(no title)').replace(/[\t\n]/g, ' '), MAX_TITLE_BYTES);
    lines.push(startMins + '\t' + endMins + '\t' + title);
  }

  console.log('Day events ' + (month0 + 1) + '/' + day + '/' + year + ': ' +
              dayList.length + ' event(s)');

  Pebble.sendAppMessage({
    MsgType: MSG_DAY_EVENTS,
    Year: year,
    Month: month0,
    Day: day,
    DayEvents: lines.join('\n')
  }, function () {}, function (err) {
    console.log('Failed to send day events: ' + JSON.stringify(err));
  });
}

function respondForDay(year, month0, day) {
  if (cachedEvents) { sendDayEvents(year, month0, day); return; }
  loadEvents(function (err) {
    if (err) { console.log('Load failed: ' + err); sendError(err); return; }
    sendDayEvents(year, month0, day);
  });
}

// Nearest day strictly in `dir` (+1/-1) from (y,m,d) that has >=1 event, within
// the horizon. Returns a Date or null.
function findAdjacentEventDay(y, m, d, dir) {
  var winStart = new Date(y, m, d - ADJ_HORIZON_DAYS);
  var winEnd = new Date(y, m, d + ADJ_HORIZON_DAYS + 1);
  var inst = ics.expandEvents(cachedEvents || [], winStart, winEnd);
  for (var k = 1; k <= ADJ_HORIZON_DAYS; k++) {
    var cand = new Date(y, m, d + dir * k);
    var cy = cand.getFullYear(), cm = cand.getMonth(), cd = cand.getDate();
    for (var i = 0; i < inst.length; i++) {
      if (instanceCoversDay(inst[i], cy, cm, cd)) return cand;
    }
  }
  return null;
}

function respondForAdj(y, m, d, dir) {
  function go() {
    var cand = findAdjacentEventDay(y, m, d, dir);
    if (!cand) {
      // Sentinel: no more events in this direction.
      Pebble.sendAppMessage({ MsgType: MSG_DAY_EVENTS, Year: y, Month: m, Day: -1, Dir: dir });
      return;
    }
    sendDayEvents(cand.getFullYear(), cand.getMonth(), cand.getDate());
  }
  if (cachedEvents) { go(); return; }
  loadEvents(function (err) {
    if (err) { sendError(err); return; }
    go();
  });
}

// --- events ----------------------------------------------------------------

Pebble.addEventListener('ready', function () {
  console.log('PKJS ready.');
  sendSettings();   // make the watch's week-start match the saved config
  var now = new Date();
  respondForMonth(now.getFullYear(), now.getMonth());
});

Pebble.addEventListener('appmessage', function (e) {
  var p = e.payload || {};
  if (p.MsgType === MSG_REQUEST_MONTH) {
    respondForMonth(p.Year, p.Month);
  } else if (p.MsgType === MSG_REQUEST_DAY) {
    respondForDay(p.Year, p.Month, p.Day);
  } else if (p.MsgType === MSG_REQUEST_ADJ) {
    respondForAdj(p.Year, p.Month, p.Day, p.Dir);
  }
});

// --- settings page (CORS-safe; the page never fetches) ----------------------

Pebble.addEventListener('showConfiguration', function () {
  var settings = { icsUrls: getIcsUrls(), weekStart: getWeekStart(), accentColor: getAccent() };
  var html = config.buildConfigPage(settings, getLastSync());
  console.log('showConfiguration: opening settings page (' + html.length + ' bytes).');
  Pebble.openURL('data:text/html,' + encodeURIComponent(html));
});

Pebble.addEventListener('webviewclosed', function (e) {
  var s = config.parseConfigResponse(e && e.response);
  if (!s) { console.log('Config cancelled.'); return; }

  try {
    localStorage.setItem('icsUrls', JSON.stringify(s.icsUrls));
    localStorage.removeItem('icsUrl');   // superseded by the array
    localStorage.setItem('weekStart', String(s.weekStart));
    localStorage.setItem('accent', String(s.accentColor));
  } catch (err) { /* ignore */ }
  console.log('Config saved. ' + s.icsUrls.length + ' calendar(s), weekStart=' +
              s.weekStart + ', accent=' + s.accentColor);

  sendSettings();        // push the new week start + accent to the watch immediately
  cachedEvents = null;   // force a re-fetch from the (possibly new) URLs
  loadEvents(function (err) {
    if (err) { sendError(err); return; }
    var now = new Date();
    sendMonthSummary(now.getFullYear(), now.getMonth());
  }, true);              // sendCard = true -> show the confirmation card once
});
