/**
 * LimoConnect Playwright automation
 * - Login once, reuse session
 * - fetchTripsByDateRange: navigates trips page, filters by date, scrapes all rows
 * - assignDriver: opens a booking, sets driver + duration, saves
 */

const { chromium } = require('playwright');

const LC_URL   = 'https://eurolimo.limoconnect247.net';
const LC_EMAIL = 'Bot@test.dk';
const LC_PASS  = 'Test123!';

let _browser  = null;
let _ctx      = null;
let _page     = null;
let _loggedIn = false;

// ── Browser / session management ─────────────────────────────────────────────

async function getPage() {
  if (!_browser) {
    _browser = await chromium.launch({ headless: true, slowMo: 80 });
    _ctx     = await _browser.newContext({ viewport: { width: 1440, height: 900 } });
  }
  if (!_page || _page.isClosed()) {
    _page     = await _ctx.newPage();
    _loggedIn = false;
  }
  return _page;
}

async function login(page) {
  if (_loggedIn) return;
  console.log('[LC] Logging in…');

  await page.goto(LC_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);

  // Fill email
  const emailSel = 'input[type="email"], input[name="email"], input[placeholder*="mail" i], input[placeholder*="Email" i]';
  await page.waitForSelector(emailSel, { timeout: 10000 });
  await page.fill(emailSel, LC_EMAIL);

  // Fill password
  await page.fill('input[type="password"]', LC_PASS);

  // Submit
  await page.click('button[type="submit"], input[type="submit"], button:has-text("Login"), button:has-text("Sign in"), button:has-text("Log in")');

  // Wait for post-login state
  await page.waitForTimeout(3000);
  await page.screenshot({ path: '/tmp/lc_login.png' });

  _loggedIn = true;
  console.log('[LC] Logged in. URL:', page.url());
}

// ── Fetch trips by date range ─────────────────────────────────────────────────
/**
 * Navigate to trips page, apply date filter, scrape all booking rows.
 * Returns array of normalised trip objects.
 */
async function fetchTripsByDateRange(startDate, endDate) {
  const page = await getPage();
  await login(page);

  console.log(`[LC] Fetching trips ${startDate} → ${endDate}`);

  // Navigate to trips
  await page.goto(`${LC_URL}/#trips`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: '/tmp/lc_trips_pre.png' });

  // ── Try to set date range filters ────────────────────────────────────────
  // LimoConnect typically has "From date" / "To date" inputs or a date picker
  const dateInputs = await page.$$('input[type="date"]');
  if (dateInputs.length >= 2) {
    await dateInputs[0].fill(startDate);
    await dateInputs[1].fill(endDate);
    console.log('[LC] Filled date range inputs');
  } else if (dateInputs.length === 1) {
    await dateInputs[0].fill(startDate);
    console.log('[LC] Filled single date input');
  } else {
    // Try text inputs with date-like placeholders
    const fromSels = [
      'input[placeholder*="from" i]', 'input[placeholder*="start" i]',
      'input[id*="from" i]',          'input[id*="start" i]',
      'input[name*="from" i]',        'input[name*="start" i]',
    ];
    const toSels = [
      'input[placeholder*="to" i]',   'input[placeholder*="end" i]',
      'input[id*="to" i]',            'input[id*="end" i]',
      'input[name*="to" i]',          'input[name*="end" i]',
    ];
    for (const sel of fromSels) {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 500 }).catch(() => false)) {
        await el.fill(startDate); break;
      }
    }
    for (const sel of toSels) {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 500 }).catch(() => false)) {
        await el.fill(endDate); break;
      }
    }
  }

  // Click Search / Filter / Apply button if present
  const searchBtns = [
    'button:has-text("Search")', 'button:has-text("Filter")',
    'button:has-text("Apply")',  'button:has-text("Refresh")',
    'input[type="submit"]',      'button[type="submit"]',
  ];
  for (const sel of searchBtns) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
      await btn.click();
      console.log(`[LC] Clicked search button: ${sel}`);
      break;
    }
  }

  await page.waitForTimeout(2500);
  await page.screenshot({ path: '/tmp/lc_trips_filtered.png' });

  // ── Scrape all visible trip rows ─────────────────────────────────────────
  const rawTrips = await page.evaluate(() => {
    // Collect table headers first
    const headers = Array.from(
      document.querySelectorAll('table thead th, table thead td')
    ).map(h => h.innerText.trim());

    // Collect all data rows
    const rows = Array.from(document.querySelectorAll('table tbody tr'));
    return rows.map(row => {
      const cells = Array.from(row.querySelectorAll('td')).map(c => c.innerText.trim());
      const id    = row.getAttribute('data-id')
                 || row.getAttribute('data-booking-id')
                 || row.getAttribute('id')
                 || '';
      // Also grab any action buttons to find edit links
      const links = Array.from(row.querySelectorAll('a, button'))
        .map(el => ({ text: el.innerText.trim(), href: el.getAttribute('href') || '' }));
      return { cells, headers, id, links };
    }).filter(r => r.cells.length > 1);
  });

  console.log(`[LC] Scraped ${rawTrips.length} rows`);
  await page.screenshot({ path: '/tmp/lc_trips_post.png' });

  // ── Also try grabbing structured trip cards (some LC builds use cards) ───
  const cardTrips = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('[class*="booking"], [class*="trip"], [class*="job"]'))
      .filter(el => el.tagName !== 'BODY' && el.tagName !== 'HTML' && el.tagName !== 'DIV' || el.children.length > 2);
    return cards.slice(0, 100).map(card => ({
      text: card.innerText.trim().substring(0, 500),
      id:   card.getAttribute('data-id') || card.getAttribute('data-booking-id') || '',
      classes: card.className,
    }));
  });

  // ── Normalise raw rows into trip objects ─────────────────────────────────
  const trips = normaliseRows(rawTrips, startDate);

  return {
    trips,
    raw:       rawTrips,
    cardTrips,
    screenshots: ['/tmp/lc_trips_pre.png', '/tmp/lc_trips_filtered.png', '/tmp/lc_trips_post.png'],
  };
}

/**
 * Map raw table rows to normalised trip objects.
 * Column positions are guessed by header name matching.
 */
function normaliseRows(rawRows, fallbackDate) {
  if (!rawRows.length) return [];

  // Use headers from first row that has them
  const hRow   = rawRows[0];
  const hdrs   = (hRow.headers || []).map(h => h.toLowerCase());

  function colIdx(keywords) {
    for (const kw of keywords) {
      const i = hdrs.findIndex(h => h.includes(kw));
      if (i >= 0) return i;
    }
    return -1;
  }

  const iRef     = colIdx(['ref', 'booking', 'id', 'job']);
  const iTime    = colIdx(['pickup', 'pick up', 'time', 'date']);
  const iPax     = colIdx(['pax', 'passenger', 'client', 'customer', 'name']);
  const iFrom    = colIdx(['from', 'pick up address', 'origin', 'pickup address']);
  const iTo      = colIdx(['to', 'drop', 'destination', 'dropoff']);
  const iDriver  = colIdx(['driver', 'chauffeur']);
  const iStatus  = colIdx(['status', 'state']);
  const iVehicle = colIdx(['vehicle', 'car', 'type']);

  return rawRows.map((row, i) => {
    const c = row.cells;
    const pickupRaw = iTime >= 0 ? c[iTime] : (c[1] || '');
    let pickupTime;
    try { pickupTime = new Date(pickupRaw).toISOString(); } catch(_) {
      pickupTime = new Date(fallbackDate + 'T08:00:00').toISOString();
    }

    return {
      id:             String(i + 1),
      lcId:           row.id || (iRef >= 0 ? c[iRef] : '') || `ROW-${i+1}`,
      refNo:          iRef >= 0 ? c[iRef] : `#${i+1}`,
      pickupTime,
      customer:       iPax >= 0 ? c[iPax] : '',
      from:           iFrom >= 0 ? c[iFrom] : '',
      to:             iTo >= 0 ? c[iTo] : '',
      currentDriver:  iDriver >= 0 ? c[iDriver] : '',
      status:         iStatus >= 0 ? c[iStatus] : '',
      vehicleType:    iVehicle >= 0 ? c[iVehicle] : '',
      rawCells:       c,             // keep for debugging
      assignedDriver: null,
      durationMinutes: 30,
      busyMinutes:     30,
      tripType:        'C2C',
      publishStatus:   'pending',
      manuallyEdited:  false,
    };
  });
}

// ── Assign driver to a booking ─────────────────────────────────────────────────
/**
 * Open a booking by its reference/ID, assign driver + optionally duration, save.
 */
async function assignDriver(lcId, driverName, durationMinutes) {
  const page = await getPage();
  await login(page);

  console.log(`[LC] Assigning "${driverName}" to ${lcId}…`);

  // Navigate to trips list
  await page.goto(`${LC_URL}/#trips`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  // Find and click the row matching this booking
  const found = await page.evaluate((id) => {
    const rows = Array.from(document.querySelectorAll('table tbody tr, [class*="booking-row"], [class*="trip-row"]'));
    for (const row of rows) {
      if (row.innerText && row.innerText.includes(id)) {
        row.setAttribute('data-lc-target', id);
        return true;
      }
    }
    return false;
  }, lcId);

  if (!found) {
    throw new Error(`Booking "${lcId}" not found in trip list`);
  }

  // Click the row or its edit button
  const editSelectors = [
    `[data-lc-target="${lcId}"] button:has-text("Edit")`,
    `[data-lc-target="${lcId}"] a:has-text("Edit")`,
    `[data-lc-target="${lcId}"] [class*="edit"]`,
    `[data-lc-target="${lcId}"]`,
  ];
  for (const sel of editSelectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 800 })) { await el.click(); break; }
    } catch(_) {}
  }

  await page.waitForTimeout(1800);
  await page.screenshot({ path: `/tmp/lc_edit_${lcId.replace(/[^a-z0-9]/gi,'_')}.png` });

  // ── Set driver ────────────────────────────────────────────────────────────
  const driverSelectors = [
    'select[name*="driver" i]', 'select[id*="driver" i]', '[class*="driver"] select',
    'input[name*="driver" i]',  'input[id*="driver" i]',  '[class*="driver"] input',
    'input[placeholder*="driver" i]', 'input[placeholder*="chauffeur" i]',
  ];

  let driverSet = false;
  for (const sel of driverSelectors) {
    const el = page.locator(sel).first();
    if (!await el.isVisible({ timeout: 600 }).catch(() => false)) continue;
    const tag = await el.evaluate(e => e.tagName.toLowerCase());
    if (tag === 'select') {
      // Try exact label match, then partial
      const opts = await el.evaluate(s =>
        Array.from(s.options).map(o => ({ v: o.value, t: o.text }))
      );
      const match = opts.find(o => o.t.toLowerCase().includes(driverName.toLowerCase()))
                 || opts.find(o => o.t.toLowerCase().split(' ')[0] === driverName.toLowerCase().split(' ')[0]);
      if (match) { await el.selectOption({ value: match.v }); driverSet = true; }
    } else {
      await el.clear();
      await el.fill(driverName);
      // Handle autocomplete dropdown
      await page.waitForTimeout(700);
      const suggestion = page.locator(`[class*="suggest"] li, [class*="autocomplete"] li, [role="option"]`).first();
      if (await suggestion.isVisible({ timeout: 800 }).catch(() => false)) {
        await suggestion.click();
      }
      driverSet = true;
    }
    if (driverSet) { console.log(`[LC] Driver set via ${sel}`); break; }
  }

  if (!driverSet) {
    await page.screenshot({ path: `/tmp/lc_nodriver_${lcId.replace(/[^a-z0-9]/gi,'_')}.png` });
    throw new Error(`Could not find driver field for booking ${lcId}. Check /tmp/lc_edit_*.png`);
  }

  // ── Set duration (roadshows / hourly) ─────────────────────────────────────
  if (durationMinutes && durationMinutes > 0) {
    const durSels = [
      'input[name*="duration" i]', 'input[id*="duration" i]',
      'input[name*="hours" i]',    'input[id*="hours" i]',
      'input[placeholder*="duration" i]', 'input[placeholder*="hours" i]',
    ];
    for (const sel of durSels) {
      const el = page.locator(sel).first();
      if (!await el.isVisible({ timeout: 500 }).catch(() => false)) continue;
      await el.clear();
      await el.fill(String(durationMinutes));
      console.log(`[LC] Duration set to ${durationMinutes}min`);
      break;
    }
  }

  // ── Save ──────────────────────────────────────────────────────────────────
  const saveSels = [
    'button:has-text("Save")', 'button:has-text("Update")',
    'button:has-text("Assign")', 'button:has-text("Confirm")',
    'button[type="submit"]', 'input[type="submit"]',
  ];
  for (const sel of saveSels) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
      await btn.click();
      console.log(`[LC] Saved via "${sel}"`);
      break;
    }
  }

  await page.waitForTimeout(1500);
  await page.screenshot({ path: `/tmp/lc_saved_${lcId.replace(/[^a-z0-9]/gi,'_')}.png` });

  return { ok: true, lcId, driverName, durationMinutes };
}

async function closeBrowser() {
  if (_browser) { await _browser.close(); _browser = null; _ctx = null; _page = null; _loggedIn = false; }
}

module.exports = { fetchTripsByDateRange, assignDriver, closeBrowser };
