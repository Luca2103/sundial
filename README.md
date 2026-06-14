![Calendar for Pebble](assets/banner.png)

# Calendar for Pebble

A touch calendar watchapp for **Pebble Time 2** and **Pebble Round 2**.

Shows the month with a dot on every day that has events; tap a day for an agenda you can
scroll through. Syncs from **iCloud** and **Google Calendar** — no companion app to install.

## Screenshots

### Pebble Time 2 (emery)

| Month (Mon start) | Month (Sun start) | Day agenda |
|:--:|:--:|:--:|
| ![](screenshots/emery_month_monday.png) | ![](screenshots/emery_month_sunday.png) | ![](screenshots/emery_day_detail.png) |

### Pebble Round 2 (gabbro)

| Month (Mon start) | Month (Sun start) | Day agenda |
|:--:|:--:|:--:|
| ![](screenshots/gabbro_month_monday.png) | ![](screenshots/gabbro_month_sunday.png) | ![](screenshots/gabbro_day_detail.png) |

### Accent colours

| Red | Green |
|:--:|:--:|
| ![](screenshots/emery_month_red.png) | ![](screenshots/gabbro_month_green.png) |

## Install

Sideload the prebuilt **[`calendar.pbw`](calendar.pbw)** with the Pebble app or the developer
tools:

```sh
pebble install --phone <your-phone-ip> calendar.pbw
```

Or build from source (requires the [Pebble SDK](https://developer.repebble.com)):

```sh
pebble build
pebble install --emulator emery      # or gabbro
```

## Setup — adding your calendars

Open the **Pebble mobile app → My Apps → Calendar → ⚙︎ Settings**, paste one or more calendar
links, choose your **week start** (Monday/Sunday) and **accent colour**, then **Save**. The
watch shows a “Synced” confirmation. Multiple links are merged into one calendar.

The app accepts a `webcal://…` link, a direct `.ics` URL, a Google share link, or a Google
“secret iCal” address.

### iCloud calendar link

1. **iPhone:** Calendar app → **Calendars** → tap the **ⓘ** next to a calendar → enable
   **Public Calendar** → **Share Link** → Copy.
2. Paste the `webcal://…` link into a calendar row in Settings.
   *(Public sharing is read-only and needs no password.)*

### Google calendar link

On a computer at **calendar.google.com**:

1. Hover the calendar → **⋮** → **Settings and sharing**.
2. **Easiest (public):** under **Access permissions**, tick **Make available to public**, then
   copy the share link (the `…?cid=…` URL) — the app converts it automatically.
3. **Private (keep it unlisted):** scroll to **Integrate calendar** → copy **Secret address in
   iCal format** (ends in `.ics`).
4. Paste the link into a calendar row in Settings.

> A Google share/`cid` link only works if the calendar is **public**. To keep a calendar
> private, use its **Secret iCal address** instead.

## Controls

- **Tap** a day → open its agenda.
- **Swipe up / down** in the agenda → next / previous day with events.
- **Swipe left → right** (or **Back**) → return to the month.
- **Swipe left / right**, or the **Up / Down** buttons, on the month → previous / next month.

## How it works

All networking and parsing happen off-watch in PebbleKit JS (the watch only renders). The JS
side fetches each ICS feed, expands recurrence (`RRULE`/`EXDATE`) and resolves timezones, then
sends the watch a compact per-day summary for the grid and, on demand, a single day’s events
for the agenda — keeping every Bluetooth message small.

## Project layout

```
src/c/pebble-calendar.c   watch UI (month grid, agenda, settings, AppMessage)
src/pkjs/index.js         PebbleKit JS: fetch, AppMessage, config flow
src/pkjs/ics.js           iCalendar parsing + recurrence + VTIMEZONE
src/pkjs/gcal.js          Google share-link → ICS URL normalisation
src/pkjs/config.js        settings page (calendars, week start, accent)
pkjs-test/                node unit tests (run: node pkjs-test/test-ics.js)
```

## Credits

- App menu icon adapted from [pebble-dev/iconography](https://github.com/pebble-dev/iconography)
  (Apache-2.0).
- Watch screenshots for the banner created using <https://pebble-render.aru.dev/>.

## License

[MIT](LICENSE) © alex_pavlov
