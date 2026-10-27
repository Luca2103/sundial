/* node pkjs-test/test-config.js — pure builder/parser tests, no Pebble needed. */
var cfg = require("../src/pkjs/config.js");

var failures = 0;
function assert(c, m) {
  console.log((c ? "  ok   - " : "  FAIL - ") + m);
  if (!c) failures++;
}

// Builder with multiple URLs + accent + last-sync present.
var html = cfg.buildConfigPage(
  {
    icsUrls: ["webcal://example.com/a.ics", "https://example.com/b.ics"],
    weekStart: 0,
    accentColor: 0xff0000,
  },
  { count: 12, nextTitle: "Dentist", nextDate: "6/16" },
);
assert(/Sundial Settings/.test(html), "builds an HTML document");
assert(
  html.indexOf('value="webcal://example.com/a.ics"') >= 0,
  "renders first URL row",
);
assert(
  html.indexOf('value="https://example.com/b.ics"') >= 0,
  "renders second URL row",
);
var rowRe = /placeholder="webcal:\/\/\.\.\." value="/g;
assert((html.match(rowRe) || []).length === 2, "renders one row per URL (2)");
assert(html.indexOf("+ Add calendar") >= 0, "has an Add calendar button");
assert(
  /<option value="0" selected>Sunday/.test(html),
  "selects Sunday when weekStart=0",
);
assert(
  html.indexOf("Last sync: <b>12</b> events, next: Dentist (6/16)") >= 0,
  "renders preview",
);
assert(
  (html.match(/class="sw/g) || []).length === 8,
  "renders 8 accent swatches",
);
assert(
  /class="sw sel" style="background:#ff0000"/.test(html),
  "marks the chosen accent (red) selected",
);

// Builder with no URLs -> one empty row, Monday default.
var html2 = cfg.buildConfigPage({ icsUrls: [], weekStart: 1 }, null);
assert((html2.match(rowRe) || []).length === 1, "no URLs -> one empty row");
assert(/Not synced yet/.test(html2), "shows not-synced message");
assert(
  /<option value="1" selected>Monday/.test(html2),
  "defaults to Monday selected",
);

// Escapes hostile next-event title.
var html3 = cfg.buildConfigPage(
  { icsUrls: [] },
  { count: 1, nextTitle: "<script>x</script>", nextDate: "" },
);
assert(
  html3.indexOf("<script>x</script>") < 0 &&
    html3.indexOf("&lt;script&gt;") >= 0,
  "escapes the next-event title",
);

// Parser: multi-URL round-trip.
var r = cfg.parseConfigResponse(
  encodeURIComponent(
    JSON.stringify({
      icsUrls: ["A", "", "B"],
      weekStart: 0,
      accentColor: 0xaa00ff,
    }),
  ),
);
assert(
  r &&
    JSON.stringify(r.icsUrls) === JSON.stringify(["A", "B"]) &&
    r.weekStart === 0,
  "parses multi-URL response, drops blanks",
);
assert(r.accentColor === 0xaa00ff, "parses accentColor");
var rDef = cfg.parseConfigResponse(JSON.stringify({ icsUrls: ["A"] }));
assert(
  rDef.accentColor === 0x00aaff,
  "accentColor defaults to blue when absent",
);
assert(cfg.parseConfigResponse("") === null, "cancel (empty) -> null");

// Parser: legacy single-URL response still works.
var r2 = cfg.parseConfigResponse(JSON.stringify({ icsUrl: "X" }));
assert(
  r2 &&
    JSON.stringify(r2.icsUrls) === JSON.stringify(["X"]) &&
    r2.weekStart === 1,
  "legacy single icsUrl -> array, default Monday",
);

// Phone-calendar mode: builder shows source picker with phone option selected.
var htmlPhone = cfg.buildConfigPage(
  { usePhoneCal: true, icsUrls: [], weekStart: 1 },
  null,
);
assert(
  /id="src_phone" value="phone" checked/.test(htmlPhone),
  "phone mode: phone radio is checked",
);
assert(
  /id="src_ics" value="ics">/.test(htmlPhone),
  "phone mode: ics radio is unchecked",
);
assert(/display:none/.test(htmlPhone), "phone mode: ICS section is hidden");
assert(
  /Phone calendar/.test(htmlPhone),
  "phone mode: shows Phone calendar label",
);

// Phone-calendar mode: ICS mode shows ICS section.
var htmlIcs = cfg.buildConfigPage(
  { usePhoneCal: false, icsUrls: ["webcal://x"], weekStart: 1 },
  null,
);
assert(
  /id="src_ics" value="ics" checked/.test(htmlIcs),
  "ics mode: ics radio is checked",
);
assert(/display:block/.test(htmlIcs), "ics mode: ICS section is visible");

// Parser: usePhoneCal round-trip.
var rPhone = cfg.parseConfigResponse(
  JSON.stringify({ usePhoneCal: true, icsUrls: [], weekStart: 1 }),
);
assert(
  rPhone && rPhone.usePhoneCal === true,
  "parseConfigResponse: usePhoneCal=true round-trips",
);
var rIcs = cfg.parseConfigResponse(
  JSON.stringify({ usePhoneCal: false, icsUrls: ["A"], weekStart: 1 }),
);
assert(
  rIcs && rIcs.usePhoneCal === false && rIcs.icsUrls[0] === "A",
  "parseConfigResponse: usePhoneCal=false, ICS URLs preserved",
);
// Parser: absent usePhoneCal defaults to false (backward compat).
var rLegacy = cfg.parseConfigResponse(JSON.stringify({ icsUrls: ["A"] }));
assert(
  rLegacy && rLegacy.usePhoneCal === false,
  "parseConfigResponse: missing usePhoneCal defaults to false",
);

console.log(failures === 0 ? "\nALL PASSED" : "\n" + failures + " FAILURE(S)");
process.exit(failures === 0 ? 0 : 1);
