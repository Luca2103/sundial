/*
 * ics.js — iCalendar (RFC 5545) parsing + recurrence expansion.
 *
 * Runs in PebbleKit JS (off-watch). Everything here happens on the phone so the
 * watch only ever receives concrete, resolved event instances / per-day counts —
 * it never sees an RRULE.
 *
 * Also exported as a CommonJS module so it can be unit-tested under plain node
 * (see pkjs-test/test-ics.js).
 *
 * Timezones (M7): VTIMEZONE blocks are parsed for their STANDARD/DAYLIGHT UTC
 * offsets and DST transition rules (FREQ=YEARLY;BYMONTH=..;BYDAY=<ord><day>), so
 * a TZID date-time is resolved to the correct absolute instant. UTC ("Z") is
 * exact; all-day (DATE) is never shifted; a floating time with no resolvable
 * TZID falls back to phone-local. (Known limit: recurrence steps in phone-local
 * wall time, so a cross-timezone series can drift by an hour at the phone's own
 * DST boundary — acceptable for display.)
 */

var MAX_ITERS = 2000;          // safety cap on recurrence generation
var MAX_SPAN_DAYS = 60;        // safety cap when counting multi-day events

// --- line handling ---------------------------------------------------------

// RFC 5545 line folding: a CRLF followed by a space or tab continues the line.
function unfoldLines(text) {
  var raw = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  var out = [];
  for (var i = 0; i < raw.length; i++) {
    var line = raw[i];
    if ((line.charAt(0) === ' ' || line.charAt(0) === '\t') && out.length) {
      out[out.length - 1] += line.substring(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

// Split "NAME;PARAM=x:VALUE" into { name, params:{}, value }.
function parseContentLine(line) {
  var colon = line.indexOf(':');
  if (colon < 0) return null;
  var head = line.substring(0, colon);
  var value = line.substring(colon + 1);
  var parts = head.split(';');
  var name = parts[0].toUpperCase();
  var params = {};
  for (var i = 1; i < parts.length; i++) {
    var eq = parts[i].indexOf('=');
    if (eq > 0) params[parts[i].substring(0, eq).toUpperCase()] = parts[i].substring(eq + 1);
  }
  return { name: name, params: params, value: value };
}

// --- date parsing ----------------------------------------------------------

// Parse an iCal date/date-time value into raw parts (no timezone applied yet).
// Forms: YYYYMMDD (DATE / all-day), YYYYMMDDTHHMMSSZ (UTC), YYYYMMDDTHHMMSS (local/TZID).
function parseDateParts(value, params) {
  var allDay = (params && params.VALUE === 'DATE') || value.length === 8;
  var y = parseInt(value.substr(0, 4), 10);
  var mo = parseInt(value.substr(4, 2), 10) - 1;
  var d = parseInt(value.substr(6, 2), 10);
  if (allDay) return { allDay: true, y: y, mo: mo, d: d, h: 0, mi: 0, s: 0, utc: false };
  var h = parseInt(value.substr(9, 2), 10);
  var mi = parseInt(value.substr(11, 2), 10);
  var s = parseInt(value.substr(13, 2), 10) || 0;
  var utc = value.charAt(value.length - 1) === 'Z';
  return { allDay: false, y: y, mo: mo, d: d, h: h, mi: mi, s: s, utc: utc };
}

var DAY_CODES = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

function parseOffset(str) {           // "+0200" / "-0530" -> minutes
  var sign = str.charAt(0) === '-' ? -1 : 1;
  var hh = parseInt(str.substr(1, 2), 10);
  var mm = parseInt(str.substr(3, 2), 10);
  return sign * (hh * 60 + mm);
}

// --- timezone resolution ---------------------------------------------------

function nthWeekdayOfMonth(year, month0, weekday, ord) {
  if (ord > 0) {
    var firstDow = new Date(year, month0, 1).getDay();
    var day = 1 + ((weekday - firstDow + 7) % 7) + (ord - 1) * 7;
    return new Date(year, month0, day);
  }
  var last = new Date(year, month0 + 1, 0);
  var day = last.getDate() - ((last.getDay() - weekday + 7) % 7);
  return new Date(year, month0, day);
}

function cmpKey(y, mo, d, h, mi) { return ((((y * 12 + mo) * 31 + d) * 24 + h) * 60 + mi); }

// Wall-clock instant (comparable key) at which a STANDARD/DAYLIGHT rule switches
// in the given year.
function transitionKeyForYear(sub, year) {
  var r = sub.rule;
  var hh = sub.start ? sub.start.h : 0, mi = sub.start ? sub.start.mi : 0;
  if (r && r.byday && r.byday.length && r.bymonth) {
    var code = r.byday[0];
    var ord = parseInt(code, 10);
    if (!ord) ord = code.charAt(0) === '-' ? -1 : 1;
    var wd = DAY_CODES[code.replace(/^[+-]?\d+/, '')];
    var dt = nthWeekdayOfMonth(year, r.bymonth - 1, wd, ord);
    return cmpKey(year, dt.getMonth(), dt.getDate(), hh, mi);
  }
  if (sub.start) return cmpKey(year, sub.start.mo, sub.start.d, hh, mi);
  return cmpKey(year, 0, 1, 0, 0);
}

// Offset (minutes) in effect at the given wall-clock parts for a VTIMEZONE.
function tzOffsetForDate(subs, raw) {
  if (subs.length === 1) return subs[0].offsetTo;
  var target = cmpKey(raw.y, raw.mo, raw.d, raw.h, raw.mi);
  var bestLE = null, bestLEk = -Infinity, maxSub = null, maxK = -Infinity;
  for (var i = 0; i < subs.length; i++) {
    var k = transitionKeyForYear(subs[i], raw.y);
    if (k > maxK) { maxK = k; maxSub = subs[i]; }
    if (k <= target && k > bestLEk) { bestLEk = k; bestLE = subs[i]; }
  }
  // Before the year's first transition -> the rule that took effect last (carries over).
  return (bestLE || maxSub).offsetTo;
}

// Resolve raw date parts (+ optional TZID) to an absolute JS Date.
function resolveDate(raw, tzid, tzmap) {
  if (raw.allDay) return new Date(raw.y, raw.mo, raw.d);                 // never shift
  if (raw.utc) return new Date(Date.UTC(raw.y, raw.mo, raw.d, raw.h, raw.mi, raw.s));
  if (tzid && tzmap[tzid]) {
    var off = tzOffsetForDate(tzmap[tzid], raw);                        // minutes
    return new Date(Date.UTC(raw.y, raw.mo, raw.d, raw.h, raw.mi, raw.s) - off * 60000);
  }
  return new Date(raw.y, raw.mo, raw.d, raw.h, raw.mi, raw.s);          // floating -> local
}

// --- RRULE -----------------------------------------------------------------

function parseRRule(value) {
  var rule = { freq: null, interval: 1, count: null, until: null, byday: [], bymonth: null };
  var parts = value.split(';');
  for (var i = 0; i < parts.length; i++) {
    var kv = parts[i].split('=');
    var k = kv[0].toUpperCase(), v = kv[1] || '';
    if (k === 'FREQ') rule.freq = v.toUpperCase();
    else if (k === 'INTERVAL') rule.interval = parseInt(v, 10) || 1;
    else if (k === 'COUNT') rule.count = parseInt(v, 10);
    else if (k === 'UNTIL') rule.until = resolveDate(parseDateParts(v, {}), null, {});
    else if (k === 'BYDAY') rule.byday = v.toUpperCase().split(',');
    else if (k === 'BYMONTH') rule.bymonth = parseInt(v, 10);
  }
  return rule;
}

// --- VEVENT / VTIMEZONE parsing --------------------------------------------

function parseICS(text) {
  var lines = unfoldLines(text);
  var events = [];
  var tzmap = {};

  var cur = null;     // current VEVENT
  var tzid = null;    // current VTIMEZONE id
  var subs = null;    // current VTIMEZONE subcomponents
  var sub = null;     // current STANDARD/DAYLIGHT

  for (var i = 0; i < lines.length; i++) {
    var cl = parseContentLine(lines[i]);
    if (!cl) continue;
    var n = cl.name, v = cl.value;

    if (n === 'BEGIN') {
      if (v === 'VEVENT') cur = { uid: '', summary: '', allDay: false, rrule: null,
                                  startRaw: null, startTz: null, endRaw: null, endTz: null, exRaw: [] };
      else if (v === 'VTIMEZONE') { tzid = null; subs = []; }
      else if ((v === 'STANDARD' || v === 'DAYLIGHT') && subs) sub = { offsetTo: 0, start: null, rule: null };
      continue;
    }
    if (n === 'END') {
      if (v === 'VEVENT') { if (cur && cur.startRaw) events.push(cur); cur = null; }
      else if (v === 'VTIMEZONE') { if (tzid) tzmap[tzid] = subs; tzid = null; subs = null; }
      else if (v === 'STANDARD' || v === 'DAYLIGHT') { if (sub && subs) subs.push(sub); sub = null; }
      continue;
    }

    if (sub) {                                  // inside a VTIMEZONE subcomponent
      if (n === 'TZOFFSETTO') sub.offsetTo = parseOffset(v);
      else if (n === 'DTSTART') sub.start = parseDateParts(v, cl.params);
      else if (n === 'RRULE') sub.rule = parseRRule(v);
      continue;
    }
    if (subs !== null && n === 'TZID') { tzid = v; continue; }   // VTIMEZONE id line
    if (!cur) continue;

    switch (n) {
      case 'UID':     cur.uid = v; break;
      case 'SUMMARY': cur.summary = v.replace(/\\,/g, ',').replace(/\\n/gi, ' '); break;
      case 'DTSTART':
        cur.startRaw = parseDateParts(v, cl.params);
        cur.startTz = cl.params.TZID;
        cur.allDay = cur.startRaw.allDay;
        break;
      case 'DTEND':
        cur.endRaw = parseDateParts(v, cl.params);
        cur.endTz = cl.params.TZID;
        break;
      case 'RRULE': cur.rrule = parseRRule(v); break;
      case 'EXDATE': {
        var pieces = v.split(',');
        for (var p = 0; p < pieces.length; p++) {
          cur.exRaw.push({ raw: parseDateParts(pieces[p], cl.params), tz: cl.params.TZID });
        }
        break;
      }
      default: break;
    }
  }

  // Resolve all raw date parts to absolute instants now that the tz map is built.
  for (var e = 0; e < events.length; e++) {
    var ev = events[e];
    ev.title = ev.summary;
    ev.start = resolveDate(ev.startRaw, ev.startTz, tzmap);
    ev.end = ev.endRaw ? resolveDate(ev.endRaw, ev.endTz, tzmap)
                       : new Date(ev.start.getTime() + (ev.allDay ? 86400000 : 0));
    ev.exdates = [];
    for (var x = 0; x < ev.exRaw.length; x++) {
      ev.exdates.push(resolveDate(ev.exRaw[x].raw, ev.exRaw[x].tz, tzmap));
    }
  }
  return events;
}

// --- date arithmetic helpers ----------------------------------------------

function addDays(d, n)   { var x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x; }
function addMonths(d, n) { var x = new Date(d.getTime()); x.setMonth(x.getMonth() + n); return x; }
function addYears(d, n)  { var x = new Date(d.getTime()); x.setFullYear(x.getFullYear() + n); return x; }
function startOfDay(d)   { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function dayKey(d)       { return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate(); }

function stepOccurrence(d, freq, interval) {
  switch (freq) {
    case 'DAILY':   return addDays(d, interval);
    case 'WEEKLY':  return addDays(d, 7 * interval);
    case 'MONTHLY': return addMonths(d, interval);
    case 'YEARLY':  return addYears(d, interval);
    default:        return addDays(d, 1);
  }
}

function withTimeOf(dateOnly, ref) {
  return new Date(dateOnly.getFullYear(), dateOnly.getMonth(), dateOnly.getDate(),
                  ref.getHours(), ref.getMinutes(), ref.getSeconds());
}

// --- expansion -------------------------------------------------------------

function buildExdateSet(ev) {
  var set = {};
  for (var i = 0; i < ev.exdates.length; i++) {
    set[ev.allDay ? dayKey(ev.exdates[i]) : ev.exdates[i].getTime()] = true;
  }
  return set;
}

function isExcluded(ev, set, occ) {
  return set[ev.allDay ? dayKey(occ) : occ.getTime()] === true;
}

function pushInstance(out, ev, occStart) {
  var dur = ev.end ? (ev.end.getTime() - ev.start.getTime()) : 0;
  out.push({
    uid: ev.uid,
    title: ev.title,
    start: occStart,
    end: new Date(occStart.getTime() + dur),
    allDay: ev.allDay,
    source: ev.source
  });
}

function expandEvents(events, winStart, winEnd) {
  var out = [];
  for (var i = 0; i < events.length; i++) expandOne(events[i], winStart, winEnd, out);
  return out;
}

function expandOne(ev, winStart, winEnd, out) {
  if (!ev.rrule || !ev.rrule.freq) {
    if (ev.start < winEnd && (!ev.end || ev.end > winStart)) pushInstance(out, ev, ev.start);
    return;
  }

  var r = ev.rrule;
  var exset = buildExdateSet(ev);

  if (r.freq === 'WEEKLY' && r.byday.length) {
    var codes = [];
    for (var c = 0; c < r.byday.length; c++) {
      var code = r.byday[c].replace(/^[+-]?\d+/, '');
      if (code in DAY_CODES) codes.push(DAY_CODES[code]);
    }
    codes.sort(function (a, b) { return a - b; });

    var weekBase = addDays(ev.start, -ev.start.getDay());
    var emitted = 0, iters = 0;
    while (iters++ < MAX_ITERS) {
      if (weekBase > winEnd) break;
      for (var j = 0; j < codes.length; j++) {
        var occ = withTimeOf(addDays(weekBase, codes[j]), ev.start);
        if (occ < ev.start) continue;
        if (r.until && occ > r.until) return;
        if (r.count !== null && emitted >= r.count) return;
        emitted++;
        if (occ >= winStart && occ < winEnd && !isExcluded(ev, exset, occ)) pushInstance(out, ev, occ);
      }
      weekBase = addDays(weekBase, 7 * r.interval);
    }
    return;
  }

  var cur = ev.start, n = 0, it = 0;
  while (it++ < MAX_ITERS) {
    if (r.until && cur > r.until) break;
    if (r.count !== null && n >= r.count) break;
    if (cur > winEnd) break;
    if (cur >= winStart && !isExcluded(ev, exset, cur)) pushInstance(out, ev, cur);
    n++;
    cur = stepOccurrence(cur, r.freq, r.interval);
  }
}

// --- month summary ---------------------------------------------------------

function monthSummary(instances, year, month0) {
  var dim = new Date(year, month0 + 1, 0).getDate();
  var counts = [];
  for (var i = 0; i < dim; i++) counts.push(0);

  for (var k = 0; k < instances.length; k++) {
    var inst = instances[k];
    var first = startOfDay(inst.start);
    var lastRef = inst.end ? new Date(inst.end.getTime()) : inst.start;
    if (inst.allDay && lastRef > inst.start) lastRef = addDays(lastRef, -1);
    var last = startOfDay(lastRef);
    if (last < first) last = first;

    var day = first, span = 0;
    while (day <= last && span++ < MAX_SPAN_DAYS) {
      if (day.getFullYear() === year && day.getMonth() === month0) counts[day.getDate() - 1]++;
      day = addDays(day, 1);
    }
  }
  return { year: year, month: month0, counts: counts };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    unfoldLines: unfoldLines,
    parseICS: parseICS,
    parseRRule: parseRRule,
    expandEvents: expandEvents,
    monthSummary: monthSummary
  };
}
