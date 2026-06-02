# EuroLimo Dispatcher

Booking dispatcher with LimoConnect integration via Playwright headless browser.

## Setup (run locally)

```bash
# 1. Install dependencies
npm install

# 2. Install Playwright's Chromium browser
npm run install-browsers

# 3. Start the server
npm start
```

Then open http://localhost:3000 in your browser.

## How it works

1. **Import trips** — drag-drop a CSV or click "Import CSV"
2. **Auto-allocate** — click ⚡ to auto-assign drivers using gap/shift rules
3. **Review & edit** — change any driver or duration before publishing
   - Roadshows / hourly services: edit the duration field (shows "RS" badge)
   - Long trips (>45km): shows "far" badge, duration auto-includes buffer
4. **Publish** — hit "Publish ↗" per row, or "Publish all to LC" to push everything

## LimoConnect automation

The Playwright script (`limoconnect.js`) logs into `eurolimo.limoconnect247.net` and
assigns drivers by interacting with the web UI directly.

**First-time setup:** Run the structure scraper once to see the actual DOM:
```bash
# in a Node REPL or script:
const lc = require('./limoconnect');
lc.scrapePageStructure().then(s => console.log(JSON.stringify(s, null, 2)));
```

This saves screenshots to `/tmp/lc_*.png` so you can see exactly what the
Playwright script is seeing. If selectors need tuning, edit the `driverSelectors`
array in `limoconnect.js`.

## CSV format

Required columns: `Pickup Time`, `Pick Up`, `Drop Off`

Optional: `Customer Name`, `Trip Minutes`, `Duration Hours`, `Duration Minutes`,
`Distance_km`, `ServiceType`, `Ref No`, `LC ID`

## Credentials

Stored in `limoconnect.js` — change `LC_EMAIL` / `LC_PASS` if they change.
