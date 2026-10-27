/*
 * config.js — self-contained settings page (no Clay, no hosting).
 *
 * PKJS generates this HTML and opens it as a data: URI in showConfiguration.
 * CORS-safe by construction: the page NEVER fetches calendar data. PKJS bakes
 * the last-sync summary directly into the HTML, so the page only displays it.
 * On save the page hands settings back via the pebblejs://close#<json> scheme.
 *
 * Supports MULTIPLE calendars via add/remove URL rows.
 *
 * Exported as CommonJS so the pure builder/parser can be unit-tested under node.
 */

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Curated accent palette: [name, 0xRRGGBB]. First is the default.
var ACCENTS = [
  ["Blue", 0x00aaff],
  ["Red", 0xff0000],
  ["Green", 0x00aa00],
  ["Orange", 0xff8800],
  ["Purple", 0xaa00ff],
  ["Pink", 0xff0099],
  ["Cyan", 0x00aaaa],
  ["Yellow", 0xffcc00],
];
var DEFAULT_ACCENT = 0x00aaff;

function hex6(n) {
  var s = (n & 0xffffff).toString(16);
  while (s.length < 6) s = "0" + s;
  return "#" + s;
}

// settings: { usePhoneCal: bool, icsUrls: [string], weekStart: 1=Monday|0=Sunday, accentColor: 0xRRGGBB }
// lastSync: { count: Number, nextTitle: string, nextDate: string } | null
function buildConfigPage(settings, lastSync) {
  settings = settings || {};
  var usePhoneCal = !!settings.usePhoneCal;
  var urls =
    settings.icsUrls && settings.icsUrls.length ? settings.icsUrls : [""];
  var monSel = settings.weekStart === 0 ? "" : " selected";
  var sunSel = settings.weekStart === 0 ? " selected" : "";
  var accent =
    typeof settings.accentColor === "number"
      ? settings.accentColor
      : DEFAULT_ACCENT;

  var swatches = "";
  for (var a = 0; a < ACCENTS.length; a++) {
    var rgb = ACCENTS[a][1];
    var sel = rgb === accent ? " sel" : "";
    swatches +=
      '<button type="button" class="sw' +
      sel +
      '" style="background:' +
      hex6(rgb) +
      '" data-rgb="' +
      rgb +
      '" title="' +
      ACCENTS[a][0] +
      '" onclick="pickAccent(this)"></button>';
  }

  var preview;
  if (lastSync && typeof lastSync.count === "number") {
    var next = lastSync.nextTitle
      ? esc(lastSync.nextTitle) +
        (lastSync.nextDate ? " (" + esc(lastSync.nextDate) + ")" : "")
      : "none";
    preview =
      "Last sync: <b>" +
      lastSync.count +
      "</b> event" +
      (lastSync.count === 1 ? "" : "s") +
      ", next: " +
      next;
  } else {
    preview =
      "Not synced yet. Choose a source and Save, then reopen to see your last sync here.";
  }

  var rows = "";
  for (var i = 0; i < urls.length; i++) {
    rows +=
      '<div class="row">' +
      '<input class="ics" type="url" placeholder="webcal://..." value="' +
      esc(urls[i]) +
      '">' +
      '<button class="rm" onclick="removeRow(this)">&#10005;</button></div>';
  }

  var phoneSel = usePhoneCal ? " checked" : "";
  var icsSel = usePhoneCal ? "" : " checked";
  var icsDisp = usePhoneCal ? "none" : "block";

  return (
    '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    "<title>Sundial Settings</title><style>" +
    "body{font-family:-apple-system,Helvetica,Arial,sans-serif;margin:0;padding:16px;" +
    "background:#f4f4f4;color:#222}h1{font-size:20px}label{display:block;margin:18px 0 6px;" +
    "font-weight:600}input,select{box-sizing:border-box;padding:10px;font-size:16px;" +
    "border:1px solid #ccc;border-radius:6px;background:#fff}select{width:100%}" +
    ".row{display:flex;gap:8px;margin-bottom:8px}.row .ics{flex:1}" +
    ".rm{width:44px;border:0;border-radius:6px;background:#e44;color:#fff;font-size:16px}" +
    ".add{margin-top:4px;padding:10px;border:1px dashed #0aacf0;background:#fff;color:#0aacf0;" +
    "border-radius:6px;font-size:15px;width:100%}" +
    ".sw{width:40px;height:40px;border:3px solid #fff;border-radius:50%;margin:4px;" +
    "box-shadow:0 0 0 1px #ccc;cursor:pointer}.sw.sel{border-color:#222;box-shadow:0 0 0 2px #222}" +
    ".hint{font-size:13px;color:#666;margin-top:6px}" +
    ".preview{background:#fff;border:1px solid #ddd;border-radius:6px;padding:12px;margin:14px 0;font-size:14px}" +
    ".actions{display:flex;gap:10px;margin-top:24px}.actions button{flex:1;padding:14px;font-size:16px;" +
    "border:0;border-radius:6px;color:#fff}.save{background:#0aacf0}.cancel{background:#999}" +
    ".srclbl{display:flex;align-items:flex-start;gap:10px;padding:12px;border:1px solid #ddd;" +
    "border-radius:8px;margin:6px 0;background:#fff;cursor:pointer;-webkit-tap-highlight-color:transparent}" +
    ".srclbl input[type=radio]{margin-top:2px;flex-shrink:0;width:18px;height:18px}" +
    ".srcname{font-weight:600;display:block;margin-bottom:2px}.srcdesc{font-size:12px;color:#666}" +
    "</style></head><body>" +
    "<h1>Sundial</h1>" +
    '<div class="preview">' +
    preview +
    "</div>" +
    "<label>Calendar source</label>" +
    "<div>" +
    '<label class="srclbl"><input type="radio" name="src" id="src_phone" value="phone"' +
    phoneSel +
    ">" +
    '<div><span class="srcname">&#128242; Phone calendar</span>' +
    '<span class="srcdesc">Uses events from your device\'s calendar app. No link needed &mdash; grant access once in the Pebble app.</span></div></label>' +
    '<label class="srclbl"><input type="radio" name="src" id="src_ics" value="ics"' +
    icsSel +
    ">" +
    '<div><span class="srcname">&#128279; iCloud / ICS links</span>' +
    '<span class="srcdesc">Paste a webcal or ICS URL. Works with iCloud, Google Calendar and any public ICS feed.</span></div></label>' +
    "</div>" +
    '<div id="icssec" style="display:' +
    icsDisp +
    '">' +
    "<label>iCloud / ICS calendar URLs</label>" +
    '<div id="cals">' +
    rows +
    "</div>" +
    '<button class="add" onclick="addRow()">+ Add calendar</button>' +
    '<div class="hint"><b>iCloud:</b> share a calendar as a <b>Public Calendar</b> and paste its link. ' +
    "<b>Google:</b> make the calendar public and paste its share link, or paste its <b>Secret address " +
    "in iCal format</b>. Read-only, no password. Add more than one to merge them.</div>" +
    "</div>" +
    '<label for="ws">Week starts on</label>' +
    '<select id="ws"><option value="1"' +
    monSel +
    ">Monday</option>" +
    '<option value="0"' +
    sunSel +
    ">Sunday</option></select>" +
    "<label>Accent colour</label>" +
    '<div id="accents">' +
    swatches +
    "</div>" +
    '<div class="actions"><button class="cancel" onclick="cancel()">Cancel</button>' +
    '<button class="save" onclick="save()">Save</button></div>' +
    "<script>" +
    'function addRow(){var d=document.createElement("div");d.className="row";' +
    'd.innerHTML=\'<input class="ics" type="url" placeholder="webcal://...">\'+' +
    '\'<button class="rm" onclick="removeRow(this)">\\u2715</button>\';' +
    'document.getElementById("cals").appendChild(d);}' +
    "function removeRow(b){b.parentNode.parentNode.removeChild(b.parentNode);}" +
    'function syncSrc(){var p=document.getElementById("src_phone").checked;' +
    'document.getElementById("icssec").style.display=p?"none":"block";}' +
    'document.getElementById("src_phone").addEventListener("change",syncSrc);' +
    'document.getElementById("src_ics").addEventListener("change",syncSrc);' +
    "var accent=" +
    accent +
    ";" +
    'function pickAccent(b){accent=parseInt(b.getAttribute("data-rgb"),10);' +
    'var sw=document.querySelectorAll("#accents .sw");' +
    'for(var i=0;i<sw.length;i++)sw[i].className="sw";b.className="sw sel";}' +
    'function close(d){location.href="pebblejs://close#"+encodeURIComponent(d);}' +
    'function save(){var isPhone=document.getElementById("src_phone").checked;' +
    'var icsUrls=[];if(!isPhone){var ins=document.querySelectorAll("#cals .ics");' +
    "for(var i=0;i<ins.length;i++){var v=ins[i].value.trim();if(v)icsUrls.push(v);}}" +
    "var s={usePhoneCal:isPhone,icsUrls:icsUrls," +
    'weekStart:parseInt(document.getElementById("ws").value,10),accentColor:accent};' +
    "close(JSON.stringify(s));}" +
    'function cancel(){close("");}' +
    "</script></body></html>"
  );
}

// Returns parsed settings or null if the user cancelled / sent nothing.
function parseConfigResponse(response) {
  if (!response) return null;
  var raw = response;
  try {
    raw = decodeURIComponent(response);
  } catch (e) {
    /* already decoded */
  }
  if (!raw) return null;
  try {
    var s = JSON.parse(raw);
    var urls = [];
    if (Array.isArray(s.icsUrls)) urls = s.icsUrls;
    else if (typeof s.icsUrl === "string" && s.icsUrl) urls = [s.icsUrl]; // legacy
    urls = urls.filter(function (u) {
      return u && String(u).trim();
    });
    var accent =
      typeof s.accentColor === "number"
        ? s.accentColor & 0xffffff
        : DEFAULT_ACCENT;
    return {
      usePhoneCal: !!s.usePhoneCal,
      icsUrls: urls,
      weekStart: s.weekStart === 0 ? 0 : 1,
      accentColor: accent,
    };
  } catch (e) {
    return null;
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    buildConfigPage: buildConfigPage,
    parseConfigResponse: parseConfigResponse,
  };
}
