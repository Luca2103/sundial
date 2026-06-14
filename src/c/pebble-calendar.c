#include <pebble.h>

// ---------------------------------------------------------------------------
// Pebble Touch Calendar — Milestone 2
//
// Month grid + touch/button navigation:
//   - tap a day  -> day-detail event list (back button returns)
//   - swipe / UP / DOWN -> previous / next month
//   - SELECT -> open today's detail; long-SELECT -> toggle week start (Mon/Sun)
//
// Data is still HARDCODED (SeedEvent[]). Per-day dot counts are DERIVED from the
// same seed list so the grid dots and the detail list always agree. PebbleKit JS
// replaces this seed data in milestones 3-4 with the same per-day-count shape.
//
// Two deliberate layouts, selected at compile time:
//   - PBL_RECT  (emery / Pebble Time 2)   : full-screen rectangular grid
//   - PBL_ROUND (gabbro / Pebble Round 2) : grid fitted inside the disc
// ---------------------------------------------------------------------------

#define PERSIST_WEEK_START 1   // persisted setting key
#define PERSIST_ACCENT     2   // persisted accent colour (0xRRGGBB)
#define DEFAULT_ACCENT_RGB 0x00AAFF   // Vivid Cerulean

// Tap vs. swipe thresholds (the Touch API gives raw events, no gestures).
#define TAP_MAX_PX    15
#define SWIPE_MIN_PX  40

#define MAX_TITLE_LEN       64
#define MAX_EVENTS_PER_DAY  10
#define MAX_AGENDA_DAYS     31

static const char *WEEKDAY_INITIALS[7] = {"S", "M", "T", "W", "T", "F", "S"};
static const char *WEEKDAY_ABBR[7] = {"Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"};
static const char *MONTH_NAMES[12] = {
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
};
static const char *MONTH_ABBR[12] = {
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"
};

// A resolved event for the agenda, parsed from the PKJS payload.
typedef struct {
  bool all_day;
  int start_hour, start_min;
  int end_hour, end_min;   // valid unless all_day; end == start means no duration
  char title[MAX_TITLE_LEN];
} DetailEvent;

// One day of the agenda (a date + its events).
typedef struct {
  int year, mon0, day;
  DetailEvent events[MAX_EVENTS_PER_DAY];
  int count;
} AgendaDay;

// Per-day event counts for the displayed month, pushed by PKJS (index = day-1).
static uint8_t s_day_counts[31];

// AppMessage protocol (mirrors src/pkjs/index.js).
#define MSG_REQUEST_MONTH 1   // watch -> JS
#define MSG_MONTH_SUMMARY 2   // JS -> watch
#define MSG_ERROR         3   // JS -> watch
#define MSG_REQUEST_DAY   4   // watch -> JS
#define MSG_DAY_EVENTS    5   // JS -> watch
#define MSG_SETTINGS      6   // JS -> watch (week start)
#define MSG_SYNC_INFO     7   // JS -> watch (confirmation card)
#define MSG_REQUEST_ADJ   8   // watch -> JS (next/prev day with events)

// --- state -----------------------------------------------------------------

static int s_cur_year, s_cur_mon0, s_cur_today;   // real "now"
static int s_view_year, s_view_mon0;              // displayed month
static int s_week_start;                          // 1 = Monday (default), 0 = Sunday

// Accent colour (title bar, today highlight, event dots), user-selectable.
static int    s_accent_rgb = DEFAULT_ACCENT_RGB;
static GColor s_accent;

// Latest month summary received from PKJS (dots are drawn only when it matches
// the displayed month).
static bool s_have_summary;
static int  s_summary_year, s_summary_mon0;

// Last sync error (empty = none); shown as a banner on the month view.
static char s_error[48];

static Window *s_month_window;
static Layer  *s_grid_layer;

static Window    *s_detail_window;
static MenuLayer *s_detail_menu;

// Agenda: a date-sorted, bounded window of days the user is scrolling through.
static AgendaDay s_agenda[MAX_AGENDA_DAYS];
static int       s_agenda_len;
static bool      s_agenda_active;       // detail window is open
static bool      s_agenda_loading;      // a day request is in flight
static int       s_agenda_pending_dir;  // 0 = anchor, +1 = down, -1 = up
static bool      s_agenda_end_up, s_agenda_end_down;

// "Synced" confirmation card (shown after a config save).
static Window    *s_sync_window;
static TextLayer *s_sync_text;
static char       s_sync_msg[96];

// Touch tracking.
static bool s_touch_down;
static int  s_down_x, s_down_y;

// --- date helpers ----------------------------------------------------------

static int iabs(int v) { return v < 0 ? -v : v; }

static int days_in_month(int year, int mon0 /* 0-11 */) {
  static const int dim[12] = {31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
  if (mon0 == 1) {
    bool leap = (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0);
    return leap ? 29 : 28;
  }
  return dim[mon0];
}

// Sakamoto's algorithm: weekday of a date, 0 = Sunday .. 6 = Saturday.
// Avoids any dependency on mktime/localtime for arbitrary months.
static int day_of_week(int year, int mon1 /* 1-12 */, int day) {
  static const int t[12] = {0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4};
  if (mon1 < 3) year -= 1;
  return (year + year / 4 - year / 100 + year / 400 + t[mon1 - 1] + day) % 7;
}

typedef struct {
  int year, mon0;
  int dim;           // days in month
  int first_offset;  // column (0-6) of the 1st, honouring week-start
  int weeks;         // week rows needed
  int today;         // day to highlight, 0 = none (not the current month)
} MonthInfo;

static MonthInfo month_info(int year, int mon0) {
  MonthInfo m;
  m.year = year;
  m.mon0 = mon0;
  m.dim = days_in_month(year, mon0);
  int wd1 = day_of_week(year, mon0 + 1, 1);          // 0 = Sunday
  m.first_offset = (wd1 - s_week_start + 7) % 7;
  m.weeks = (m.first_offset + m.dim + 6) / 7;
  bool is_current = (year == s_cur_year && mon0 == s_cur_mon0);
  m.today = is_current ? s_cur_today : 0;
  return m;
}

// --- layout (shared by renderer and hit-test) ------------------------------

typedef struct {
  GRect area;
  int cw, ch;
  int header_y, grid_top;
  int title_h, header_h;
  GFont num_font, small_font;
} Layout;

static Layout compute_layout(GRect bounds, const MonthInfo *m) {
  Layout L;
#if defined(PBL_ROUND)
  // Fit a centred square inside the disc (inscribed square ~ diameter/sqrt(2))
  // so no cell ever clips off-screen — a deliberate round layout.
  const int side = bounds.size.w * 70 / 100;
  L.area = GRect((bounds.size.w - side) / 2, (bounds.size.h - side) / 2, side, side);
  L.title_h = 20;
  L.header_h = 16;
  L.num_font = fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD);
  L.small_font = fonts_get_system_font(FONT_KEY_GOTHIC_14);
#else
  L.area = grect_inset(bounds, GEdgeInsets(2));
  L.title_h = 26;
  L.header_h = 18;
  L.num_font = fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD);
  L.small_font = fonts_get_system_font(FONT_KEY_GOTHIC_18);
#endif
  L.cw = L.area.size.w / 7;
  L.header_y = L.area.origin.y + L.title_h;
  L.grid_top = L.header_y + L.header_h;
  int grid_h = (L.area.origin.y + L.area.size.h) - L.grid_top;
  L.ch = grid_h / m->weeks;
  return L;
}

// --- rendering -------------------------------------------------------------

static void grid_update_proc(Layer *layer, GContext *ctx) {
  const GRect bounds = layer_get_bounds(layer);
  const MonthInfo m = month_info(s_view_year, s_view_mon0);
  const Layout L = compute_layout(bounds, &m);

  // Draw dots only when the cached summary is for the month on screen.
  const bool show_dots = s_have_summary &&
                         s_summary_year == m.year && s_summary_mon0 == m.mon0;

  // Title bar: an accent-filled band with the month/year in white.
  char title[24];
  snprintf(title, sizeof(title), "%s %d", MONTH_NAMES[m.mon0], m.year);
  GRect title_bar = GRect(L.area.origin.x, L.area.origin.y, L.area.size.w, L.title_h);
  graphics_context_set_fill_color(ctx, s_accent);
  graphics_fill_rect(ctx, title_bar, 4, GCornersAll);
  graphics_context_set_text_color(ctx, GColorWhite);
  graphics_draw_text(ctx, title, L.num_font,
                     GRect(title_bar.origin.x, title_bar.origin.y, title_bar.size.w, title_bar.size.h),
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);

  // Weekday header, reordered for the chosen week-start.
  graphics_context_set_text_color(ctx, GColorDarkGray);
  for (int i = 0; i < 7; i++) {
    const char *label = WEEKDAY_INITIALS[(i + s_week_start) % 7];
    graphics_draw_text(ctx, label, L.small_font,
                       GRect(L.area.origin.x + i * L.cw, L.header_y, L.cw, L.header_h),
                       GTextOverflowModeFill, GTextAlignmentCenter, NULL);
  }

  // Day cells
  for (int d = 1; d <= m.dim; d++) {
    const int idx = m.first_offset + (d - 1);
    const int row = idx / 7;
    const int col = idx % 7;
    const GRect cell = GRect(L.area.origin.x + col * L.cw, L.grid_top + row * L.ch, L.cw, L.ch);
    const bool is_today = (d == m.today);

    if (is_today) {
      graphics_context_set_fill_color(ctx, s_accent);
      graphics_fill_rect(ctx, grect_inset(cell, GEdgeInsets(1)), 4, GCornersAll);
      graphics_context_set_text_color(ctx, GColorWhite);
    } else {
      graphics_context_set_text_color(ctx, GColorBlack);
    }

    char num[12];
    snprintf(num, sizeof(num), "%d", d);
    graphics_draw_text(ctx, num, L.num_font,
                       GRect(cell.origin.x, cell.origin.y - 2, cell.size.w, L.ch - 6),
                       GTextOverflowModeFill, GTextAlignmentCenter, NULL);

    if (show_dots && s_day_counts[d - 1] > 0) {
      graphics_context_set_fill_color(ctx, is_today ? GColorWhite : s_accent);
      graphics_fill_circle(ctx, GPoint(cell.origin.x + L.cw / 2, cell.origin.y + L.ch - 5), 2);
    }
  }

  // Sync-error banner (transient): a red strip along the bottom of the drawable
  // area — inside the disc on round, full width on rect.
  if (s_error[0]) {
#if defined(PBL_ROUND)
    GRect eb = GRect(L.area.origin.x, L.area.origin.y + L.area.size.h - 20, L.area.size.w, 20);
#else
    GRect eb = GRect(0, bounds.size.h - 20, bounds.size.w, 20);
#endif
    graphics_context_set_fill_color(ctx, GColorRed);
    graphics_fill_rect(ctx, eb, 0, GCornerNone);
    graphics_context_set_text_color(ctx, GColorWhite);
    eb.origin.y += 1;
    graphics_draw_text(ctx, s_error, fonts_get_system_font(FONT_KEY_GOTHIC_14), eb,
                       GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
  }
}

// --- navigation ------------------------------------------------------------

// Ask PKJS for the displayed month's summary. PKJS also pushes the current
// month proactively on its 'ready' event, which covers the initial load even
// if this send races startup.
static void request_month(void) {
  DictionaryIterator *it;
  if (app_message_outbox_begin(&it) != APP_MSG_OK) return;
  dict_write_uint8(it, MESSAGE_KEY_MsgType, MSG_REQUEST_MONTH);
  dict_write_int32(it, MESSAGE_KEY_Year, s_view_year);
  dict_write_int32(it, MESSAGE_KEY_Month, s_view_mon0);
  app_message_outbox_send();
}

static void change_month(int delta) {
  s_view_mon0 += delta;
  while (s_view_mon0 < 0)  { s_view_mon0 += 12; s_view_year--; }
  while (s_view_mon0 > 11) { s_view_mon0 -= 12; s_view_year++; }
  layer_mark_dirty(s_grid_layer);
  request_month();
}

static void toggle_week_start(void) {
  s_week_start = s_week_start ? 0 : 1;
  persist_write_int(PERSIST_WEEK_START, s_week_start);
  layer_mark_dirty(s_grid_layer);
}

// Parse the packed DayEvents payload into an AgendaDay. Lines are
// "<startMins|-1>\t<endMins|-1>\t<title>" joined by "\n", already sorted by PKJS.
static void parse_day_events(const char *payload, AgendaDay *blk) {
  blk->count = 0;
  const char *p = payload;
  while (*p && blk->count < MAX_EVENTS_PER_DAY) {
    const char *nl = p;
    while (*nl && *nl != '\n') nl++;             // end of line
    const char *tab1 = p;
    while (tab1 < nl && *tab1 != '\t') tab1++;   // after startMins
    if (tab1 < nl) {
      const char *tab2 = tab1 + 1;
      while (tab2 < nl && *tab2 != '\t') tab2++; // after endMins
      DetailEvent *e = &blk->events[blk->count++];
      int smin = atoi(p);
      int emin = (tab2 < nl) ? atoi(tab1 + 1) : -1;
      if (smin < 0) {
        e->all_day = true;
        e->start_hour = e->start_min = e->end_hour = e->end_min = 0;
      } else {
        e->all_day = false;
        e->start_hour = smin / 60; e->start_min = smin % 60;
        if (emin < 0) emin = smin;
        e->end_hour = emin / 60; e->end_min = emin % 60;
      }
      const char *title = (tab2 < nl) ? tab2 + 1 : tab1 + 1;
      int tlen = nl - title;
      if (tlen < 0) tlen = 0;
      if (tlen > MAX_TITLE_LEN - 1) {
        tlen = MAX_TITLE_LEN - 1;
        // Don't end mid-character: back off until the next byte starts a new
        // UTF-8 codepoint (a partial sequence would render the cell blank).
        while (tlen > 0 && ((unsigned char)title[tlen] & 0xC0) == 0x80) tlen--;
      }
      memcpy(e->title, title, tlen);
      e->title[tlen] = '\0';
    }
    p = (*nl == '\n') ? nl + 1 : nl;
  }
}

// Comparable key for a date (ascending).
static long ymd_key(int y, int m0, int d) { return (long)y * 10000 + (m0 + 1) * 100 + d; }

// Ask PKJS for the exact day's events (the agenda anchor).
static void request_day(int year, int mon0, int day) {
  DictionaryIterator *it;
  if (app_message_outbox_begin(&it) != APP_MSG_OK) return;
  dict_write_uint8(it, MESSAGE_KEY_MsgType, MSG_REQUEST_DAY);
  dict_write_int32(it, MESSAGE_KEY_Year, year);
  dict_write_int32(it, MESSAGE_KEY_Month, mon0);
  dict_write_int32(it, MESSAGE_KEY_Day, day);
  app_message_outbox_send();
}

// Ask PKJS for the next (dir=+1) / previous (dir=-1) day that has events,
// starting from the appropriate edge of the loaded agenda.
static void request_adj(int dir) {
  if (s_agenda_loading || s_agenda_len == 0) return;
  if (dir > 0 && s_agenda_end_down) return;
  if (dir < 0 && s_agenda_end_up) return;
  if (s_agenda_len >= MAX_AGENDA_DAYS) {        // window full — stop growing
    if (dir > 0) s_agenda_end_down = true; else s_agenda_end_up = true;
    return;
  }
  const AgendaDay *edge = (dir > 0) ? &s_agenda[s_agenda_len - 1] : &s_agenda[0];
  DictionaryIterator *it;
  if (app_message_outbox_begin(&it) != APP_MSG_OK) return;
  s_agenda_loading = true;
  s_agenda_pending_dir = dir;
  dict_write_uint8(it, MESSAGE_KEY_MsgType, MSG_REQUEST_ADJ);
  dict_write_int32(it, MESSAGE_KEY_Year, edge->year);
  dict_write_int32(it, MESSAGE_KEY_Month, edge->mon0);
  dict_write_int32(it, MESSAGE_KEY_Day, edge->day);
  dict_write_int32(it, MESSAGE_KEY_Dir, dir);
  app_message_outbox_send();
}

static void open_day(int day);

static void handle_tap(int x, int y) {
  const GRect bounds = layer_get_bounds(s_grid_layer);
  const MonthInfo m = month_info(s_view_year, s_view_mon0);
  const Layout L = compute_layout(bounds, &m);

  if (x < L.area.origin.x || y < L.grid_top) return;
  const int col = (x - L.area.origin.x) / L.cw;
  const int row = (y - L.grid_top) / L.ch;
  if (col < 0 || col > 6 || row < 0 || row >= m.weeks) return;

  const int day = (row * 7 + col) - m.first_offset + 1;
  if (day < 1 || day > m.dim) return;
  open_day(day);
}

// --- touch handler (derives tap vs. swipe) ---------------------------------

static void touch_handler(const TouchEvent *event, void *context) {
  switch (event->type) {
    case TouchEvent_Touchdown:
      s_down_x = event->x;
      s_down_y = event->y;
      s_touch_down = true;
      break;
    case TouchEvent_Liftoff: {
      if (!s_touch_down) break;
      s_touch_down = false;
      const int dx = event->x - s_down_x;
      const int dy = event->y - s_down_y;

      if (s_agenda_active) {
        // Day-detail gestures: vertical swipe moves through events, swipe
        // left→right goes back to the month (like the back button).
        if (iabs(dx) > SWIPE_MIN_PX && iabs(dx) > iabs(dy)) {
          if (dx > 0) window_stack_pop(true);    // L→R = back to month
        } else if (iabs(dy) > SWIPE_MIN_PX && s_detail_menu) {
          // Swipe up (dy<0) → next event (down); swipe down (dy>0) → previous.
          menu_layer_set_selected_next(s_detail_menu, dy > 0, MenuRowAlignCenter, true);
        }
        break;
      }

      // Month-view gestures.
      if (iabs(dx) > SWIPE_MIN_PX && iabs(dx) > iabs(dy)) {
        change_month(dx < 0 ? +1 : -1);          // swipe left = next month
      } else if (iabs(dx) < TAP_MAX_PX && iabs(dy) < TAP_MAX_PX) {
        handle_tap(s_down_x, s_down_y);
      }
      break;
    }
    default:
      break;
  }
}

// --- month-window buttons (parallel, reliably testable in the emulator) ----

static void month_up(ClickRecognizerRef rec, void *ctx)   { change_month(-1); }
static void month_down(ClickRecognizerRef rec, void *ctx) { change_month(+1); }
static void month_select(ClickRecognizerRef rec, void *ctx) {
  const MonthInfo m = month_info(s_view_year, s_view_mon0);
  open_day(m.today ? m.today : 1);
}
static void month_select_long(ClickRecognizerRef rec, void *ctx) { toggle_week_start(); }

static void month_click_config(void *context) {
  window_single_click_subscribe(BUTTON_ID_UP, month_up);
  window_single_click_subscribe(BUTTON_ID_DOWN, month_down);
  window_single_click_subscribe(BUTTON_ID_SELECT, month_select);
  window_long_click_subscribe(BUTTON_ID_SELECT, 0, month_select_long, NULL);
}

// --- agenda window (multi-section MenuLayer) -------------------------------
//
// Each section is one date; rows are that day's events. Scrolling to the first
// or last loaded day lazily requests the previous / next day that has events
// (empty days are skipped — PKJS finds the nearest non-empty day).

static uint16_t agenda_num_sections(MenuLayer *menu, void *ctx) {
  return s_agenda_len > 0 ? s_agenda_len : 1;   // 1 section for the loading state
}

static uint16_t agenda_num_rows(MenuLayer *menu, uint16_t section, void *ctx) {
  if (s_agenda_len == 0) return 1;              // "Loading…"
  int c = s_agenda[section].count;
  return c > 0 ? c : 1;                         // "No events" for the empty anchor
}

#define AGENDA_HEADER_H 30

static int16_t agenda_header_height(MenuLayer *menu, uint16_t section, void *ctx) {
  return AGENDA_HEADER_H;   // tall enough for the 18px date font
}

static void agenda_draw_header(GContext *ctx, const Layer *cell, uint16_t section, void *context) {
  char header[24];
  if (s_agenda_len == 0) {
    strncpy(header, "Agenda", sizeof(header));
  } else {
    const AgendaDay *d = &s_agenda[section];
    int wd = day_of_week(d->year, d->mon0 + 1, d->day);
    snprintf(header, sizeof(header), "%s, %s %d", WEEKDAY_ABBR[wd], MONTH_ABBR[d->mon0], d->day);
  }
  // Centre horizontally (so the first letter isn't clipped on round) and
  // vertically (so the text isn't cut by the event cell below).
  GFont font = fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD);
  GRect b = layer_get_bounds(cell);
#if defined(PBL_ROUND)
  b = grect_inset(b, GEdgeInsets(0, 8));
#else
  b.origin.x += 4; b.size.w -= 8;
#endif
  GSize ts = graphics_text_layout_get_content_size(header, font, b,
                 GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter);
  b.origin.y += (b.size.h - ts.h) / 2;
  b.size.h = ts.h;
  graphics_context_set_text_color(ctx, GColorBlack);
  graphics_draw_text(ctx, header, font, b,
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
}

static void agenda_draw_row(GContext *ctx, const Layer *cell, MenuIndex *idx, void *context) {
  if (s_agenda_len == 0) {
    menu_cell_basic_draw(ctx, cell, "Loading…", NULL, NULL);
    return;
  }
  const AgendaDay *d = &s_agenda[idx->section];
  if (d->count == 0) {
    menu_cell_basic_draw(ctx, cell, "No events", NULL, NULL);
    return;
  }
  const DetailEvent *e = &d->events[idx->row];
  char when[26];
  if (e->all_day) {
    strncpy(when, "All day", sizeof(when));
  } else if (clock_is_24h_style()) {
    if (e->end_hour == e->start_hour && e->end_min == e->start_min)
      snprintf(when, sizeof(when), "%02d:%02d", e->start_hour, e->start_min);
    else
      snprintf(when, sizeof(when), "%02d:%02d – %02d:%02d",
               e->start_hour, e->start_min, e->end_hour, e->end_min);
  } else {
    int sh = e->start_hour % 12; if (sh == 0) sh = 12;
    int eh = e->end_hour % 12;   if (eh == 0) eh = 12;
    if (e->end_hour == e->start_hour && e->end_min == e->start_min)
      snprintf(when, sizeof(when), "%d:%02d %s", sh, e->start_min, e->start_hour < 12 ? "AM" : "PM");
    else
      snprintf(when, sizeof(when), "%d:%02d %s – %d:%02d %s",
               sh, e->start_min, e->start_hour < 12 ? "AM" : "PM",
               eh, e->end_min, e->end_hour < 12 ? "AM" : "PM");
  }
  menu_cell_basic_draw(ctx, cell, e->title, when, NULL);
}

// Lazily extend the agenda when the user scrolls onto an edge day.
static void agenda_selection_changed(MenuLayer *menu, MenuIndex new_index,
                                     MenuIndex old_index, void *ctx) {
  if (s_agenda_len == 0 || s_agenda_loading) return;
  if (new_index.section >= (uint16_t)(s_agenda_len - 1) && !s_agenda_end_down) {
    request_adj(+1);
  } else if (new_index.section == 0 && !s_agenda_end_up) {
    request_adj(-1);
  }
}

static void detail_window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  s_detail_menu = menu_layer_create(layer_get_bounds(root));
  menu_layer_set_callbacks(s_detail_menu, NULL, (MenuLayerCallbacks) {
    .get_num_sections = agenda_num_sections,
    .get_num_rows = agenda_num_rows,
    .get_header_height = agenda_header_height,
    .draw_header = agenda_draw_header,
    .draw_row = agenda_draw_row,
    .selection_changed = agenda_selection_changed,
  });
  // Keep the selected row vertically centred on both platforms (round defaults
  // on, rect defaults off) so scrolling feels consistent.
  menu_layer_set_center_focused(s_detail_menu, true);
  menu_layer_set_click_config_onto_window(s_detail_menu, window);
  layer_add_child(root, menu_layer_get_layer(s_detail_menu));
}

static void detail_window_unload(Window *window) {
  menu_layer_destroy(s_detail_menu);
  s_detail_menu = NULL;
  s_agenda_active = false;
}

static void open_day(int day) {
  // Reset the agenda; the tapped day is the anchor (shown even if empty).
  s_agenda_len = 0;
  s_agenda_active = true;
  s_agenda_loading = true;
  s_agenda_pending_dir = 0;
  s_agenda_end_up = s_agenda_end_down = false;

  if (!s_detail_window) {
    s_detail_window = window_create();
    window_set_window_handlers(s_detail_window, (WindowHandlers) {
      .load = detail_window_load,
      .unload = detail_window_unload,
    });
  }
  window_stack_push(s_detail_window, true);
  if (s_detail_menu) menu_layer_reload_data(s_detail_menu);
  request_day(s_view_year, s_view_mon0, day);   // anchor
}

// --- one-time sync confirmation card ---------------------------------------

static void sync_window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect b = layer_get_bounds(root);
  s_sync_text = text_layer_create(grect_inset(b, GEdgeInsets(PBL_IF_ROUND_ELSE(20, 8))));
  text_layer_set_text(s_sync_text, s_sync_msg);
  text_layer_set_text_alignment(s_sync_text, GTextAlignmentCenter);
  text_layer_set_font(s_sync_text, fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD));
  text_layer_set_background_color(s_sync_text, GColorClear);
  text_layer_set_text_color(s_sync_text, GColorWhite);
#if defined(PBL_ROUND)
  text_layer_enable_screen_text_flow_and_paging(s_sync_text, 5);
#endif
  layer_add_child(root, text_layer_get_layer(s_sync_text));
}

static void sync_window_unload(Window *window) {
  text_layer_destroy(s_sync_text);
}

static void show_sync_card(int count, const char *next) {
  snprintf(s_sync_msg, sizeof(s_sync_msg), "Synced\n%d event%s%s%s",
           count, count == 1 ? "" : "s",
           (next && next[0]) ? "\n\nNext: " : "",
           (next && next[0]) ? next : "");
  if (!s_sync_window) {
    s_sync_window = window_create();
    window_set_window_handlers(s_sync_window, (WindowHandlers) {
      .load = sync_window_load,
      .unload = sync_window_unload,
    });
  }
  window_set_background_color(s_sync_window, s_accent);
  window_stack_push(s_sync_window, true);
}

// --- agenda insertion ------------------------------------------------------

// Insert a day's events into the date-sorted agenda (ignoring duplicates),
// preserving the user's visual position when inserting above the selection.
static void agenda_insert(int year, int mon0, int day, const char *payload) {
  if (s_agenda_len >= MAX_AGENDA_DAYS) return;

  long key = ymd_key(year, mon0, day);
  int pos = 0;
  while (pos < s_agenda_len &&
         ymd_key(s_agenda[pos].year, s_agenda[pos].mon0, s_agenda[pos].day) < key) pos++;
  if (pos < s_agenda_len &&
      s_agenda[pos].year == year && s_agenda[pos].mon0 == mon0 && s_agenda[pos].day == day) {
    return;   // already loaded
  }

  MenuIndex sel = s_detail_menu ? menu_layer_get_selected_index(s_detail_menu)
                                : (MenuIndex){ .section = 0, .row = 0 };

  for (int i = s_agenda_len; i > pos; i--) s_agenda[i] = s_agenda[i - 1];
  AgendaDay *blk = &s_agenda[pos];
  blk->year = year; blk->mon0 = mon0; blk->day = day;
  parse_day_events(payload, blk);
  s_agenda_len++;

  if (s_detail_menu) {
    menu_layer_reload_data(s_detail_menu);
    if (pos <= sel.section && s_agenda_len > 1) {
      sel.section += 1;   // we inserted at/above the selection — keep it stable
      menu_layer_set_selected_index(s_detail_menu, sel, MenuRowAlignNone, false);
    }
  }
}

// --- AppMessage (month summary from PKJS) ----------------------------------

static void inbox_received(DictionaryIterator *iter, void *context) {
  Tuple *type_t = dict_find(iter, MESSAGE_KEY_MsgType);
  if (!type_t) return;
  int type = type_t->value->int32;

  if (type == MSG_MONTH_SUMMARY) {
    Tuple *year_t = dict_find(iter, MESSAGE_KEY_Year);
    Tuple *mon_t  = dict_find(iter, MESSAGE_KEY_Month);
    Tuple *cnt_t  = dict_find(iter, MESSAGE_KEY_DayCounts);
    if (!year_t || !mon_t || !cnt_t) return;

    s_summary_year = year_t->value->int32;
    s_summary_mon0 = mon_t->value->int32;
    s_have_summary = true;
    s_error[0] = '\0';   // a successful sync clears any prior error

    memset(s_day_counts, 0, sizeof(s_day_counts));
    uint16_t n = cnt_t->length;
    if (n > sizeof(s_day_counts)) n = sizeof(s_day_counts);
    memcpy(s_day_counts, cnt_t->value->data, n);

    APP_LOG(APP_LOG_LEVEL_INFO, "Summary received: %d/%d (%u days)",
            s_summary_mon0 + 1, s_summary_year, n);
    if (s_grid_layer) layer_mark_dirty(s_grid_layer);

  } else if (type == MSG_DAY_EVENTS) {
    if (!s_agenda_active) return;   // agenda closed — ignore stale replies
    Tuple *day_t = dict_find(iter, MESSAGE_KEY_Day);
    if (!day_t) return;
    int day = day_t->value->int32;

    if (day < 0) {
      // Sentinel: no more events in the requested direction.
      Tuple *dir_t = dict_find(iter, MESSAGE_KEY_Dir);
      int dir = dir_t ? dir_t->value->int32 : s_agenda_pending_dir;
      if (dir > 0) s_agenda_end_down = true; else if (dir < 0) s_agenda_end_up = true;
      s_agenda_loading = false;
      s_agenda_pending_dir = 0;
      return;
    }

    Tuple *year_t = dict_find(iter, MESSAGE_KEY_Year);
    Tuple *mon_t  = dict_find(iter, MESSAGE_KEY_Month);
    Tuple *evt_t  = dict_find(iter, MESSAGE_KEY_DayEvents);
    if (!year_t || !mon_t || !evt_t) return;

    int was_dir = s_agenda_pending_dir;
    agenda_insert(year_t->value->int32, mon_t->value->int32, day, evt_t->value->cstring);
    s_agenda_loading = false;
    s_agenda_pending_dir = 0;
    APP_LOG(APP_LOG_LEVEL_INFO, "Agenda day %d/%d/%d (%d blocks)",
            mon_t->value->int32 + 1, day, year_t->value->int32, s_agenda_len);

    // After the anchor loads, prefetch one day forward for smooth first scroll.
    if (was_dir == 0 && !s_agenda_end_down) request_adj(+1);

  } else if (type == MSG_SETTINGS) {
    bool changed = false;
    Tuple *ws_t = dict_find(iter, MESSAGE_KEY_WeekStart);
    if (ws_t) {
      int ws = ws_t->value->int32 ? 1 : 0;
      if (ws != s_week_start) {
        s_week_start = ws;
        persist_write_int(PERSIST_WEEK_START, s_week_start);
        changed = true;
      }
    }
    Tuple *ac_t = dict_find(iter, MESSAGE_KEY_AccentColor);
    if (ac_t) {
      int rgb = ac_t->value->int32 & 0xFFFFFF;
      if (rgb != s_accent_rgb) {
        s_accent_rgb = rgb;
        s_accent = GColorFromHEX(s_accent_rgb);
        persist_write_int(PERSIST_ACCENT, s_accent_rgb);
        changed = true;
      }
    }
    if (changed && s_grid_layer) layer_mark_dirty(s_grid_layer);

  } else if (type == MSG_SYNC_INFO) {
    // Only arrives after a config save now, so show it each time.
    Tuple *cnt_t  = dict_find(iter, MESSAGE_KEY_SyncCount);
    Tuple *next_t = dict_find(iter, MESSAGE_KEY_SyncNext);
    show_sync_card(cnt_t ? cnt_t->value->int32 : 0,
                   next_t ? next_t->value->cstring : "");

  } else if (type == MSG_ERROR) {
    Tuple *msg_t = dict_find(iter, MESSAGE_KEY_ErrMsg);
    const char *m = msg_t ? msg_t->value->cstring : "Sync failed";
    APP_LOG(APP_LOG_LEVEL_ERROR, "Sync error: %s", m);
    snprintf(s_error, sizeof(s_error), "%s", m);
    s_agenda_loading = false;
    if (s_grid_layer) layer_mark_dirty(s_grid_layer);
    if (s_detail_menu) menu_layer_reload_data(s_detail_menu);
  }
}

static void inbox_dropped(AppMessageResult reason, void *context) {
  APP_LOG(APP_LOG_LEVEL_ERROR, "Inbox dropped: %d", reason);
}

// --- month window lifecycle ------------------------------------------------

static void month_window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  s_grid_layer = layer_create(layer_get_bounds(root));
  layer_set_update_proc(s_grid_layer, grid_update_proc);
  layer_add_child(root, s_grid_layer);

  if (touch_service_is_enabled()) {
    touch_service_subscribe(touch_handler, NULL);
  }
}

static void month_window_unload(Window *window) {
  touch_service_unsubscribe();
  layer_destroy(s_grid_layer);
}

// --- app lifecycle ---------------------------------------------------------

static void init(void) {
  // Real "now".
  time_t now = time(NULL);
  struct tm *lt = localtime(&now);
  s_cur_year = lt->tm_year + 1900;
  s_cur_mon0 = lt->tm_mon;
  s_cur_today = lt->tm_mday;
  s_view_year = s_cur_year;
  s_view_mon0 = s_cur_mon0;

  // Week-start setting: default Monday (1), persisted across launches.
  s_week_start = persist_exists(PERSIST_WEEK_START) ? persist_read_int(PERSIST_WEEK_START) : 1;

  // Accent colour (persisted, default cerulean).
  s_accent_rgb = persist_exists(PERSIST_ACCENT) ? persist_read_int(PERSIST_ACCENT) : DEFAULT_ACCENT_RGB;
  s_accent = GColorFromHEX(s_accent_rgb);

  // Per-day dot counts now arrive from PKJS (see inbox_received); none yet.

  // AppMessage: register handlers before opening, then request the first month.
  app_message_register_inbox_received(inbox_received);
  app_message_register_inbox_dropped(inbox_dropped);
  app_message_open(1024, 64);   // inbox holds the packed DayEvents cstring

  s_month_window = window_create();
  window_set_background_color(s_month_window, GColorWhite);
  window_set_click_config_provider(s_month_window, month_click_config);
  window_set_window_handlers(s_month_window, (WindowHandlers) {
    .load = month_window_load,
    .unload = month_window_unload,
  });
  window_stack_push(s_month_window, true);

  request_month();
}

static void deinit(void) {
  if (s_sync_window) window_destroy(s_sync_window);
  if (s_detail_window) window_destroy(s_detail_window);
  window_destroy(s_month_window);
}

int main(void) {
  init();
  app_event_loop();
  deinit();
}
