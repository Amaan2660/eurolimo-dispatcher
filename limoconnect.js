const { chromium } = require('playwright');

const LC_URL   = 'https://eurolimo.limoconnect247.net';
const LC_EMAIL = process.env.LC_EMAIL || 'Bot@test.dk';
const LC_PASS  = process.env.LC_PASS  || 'Test123!';

let _browser  = null;
let _page     = null;
let _loggedIn = false;

async function getPage() {
  if (!_browser) {
    _browser = await chromium.launch({ headless: true });
  }
  if (!_page || _page.isClosed()) {
    _page     = await _browser.newPage();
    _loggedIn = false;
  }
  return _page;
}

async function login(page) {
  if (_loggedIn) return;
  console.log('[LC] Logging in...');
  await page.goto(LC_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(4000);

  const emailSelectors = [
    'input[type="email"]',
    'input[name="email"]',
    'input[id="email"]',
    'input[placeholder*="mail" i]',
    'input[placeholder*="user" i]',
    'input[type="text"]',
  ];

  let emailFilled = false;
  for (const sel of emailSelectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 1000 })) {
        await el.fill(LC_EMAIL);
        console.log('[LC] Email filled via:', sel);
        emailFilled = true;
        break;
      }
    } catch (_) {}
  }

  if (!emailFilled) {
    const inputs = await page.$$('input');
    for (const inp of inputs) {
      if (await inp.isVisible()) {
        await inp.fill(LC_EMAIL);
        console.log('[LC] Email filled via first visible input');
        emailFilled = true;
        break;
      }
    }
  }

  const passSelectors = [
    'input[type="password"]',
    'input[name="password"]',
    'input[id="password"]',
    'input[placeholder*="pass" i]',
  ];

  for (const sel of passSelectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 1000 })) {
        await el.fill(LC_PASS);
        console.log('[LC] Password filled via:', sel);
        break;
      }
    } catch (_) {}
  }

  const submitSelectors = [
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("Login")',
    'button:has-text("Sign in")',
    'button:has-text("Log in")',
    'button:has-text("LOGIN")',
  ];

  for (const sel of submitSelectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 1000 })) {
        await el.click();
        console.log('[LC] Submitted via:', sel);
        break;
      }
    } catch (_) {}
  }

  await page.waitForTimeout(4000);
  console.log('[LC] After login URL:', page.url());
  _loggedIn = true;
}

async function fetchTripsByDateRange(startDate, endDate) {
  const page = await getPage();
  await login(page);

  console.log('[LC] Fetching trips', startDate, '->', endDate);
  await page.goto(LC_URL + '/#trips', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  const dateInputs = await page.$$('input[type="date"]');
  if (dateInputs.length >= 2) {
    await dateInputs[0].fill(startDate);
    await dateInputs[1].fill(endDate);
  } else if (dateInputs.length === 1) {
    await dateInputs[0].fill(startDate);
  }

  const searchBtns = [
    'button:has-text("Search")',
    'button:has-text("Filter")',
    'button:has-text("Apply")',
    'button:has-text("Refresh")',
    'button[type="submit"]',
  ];

  for (const sel of searchBtns) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 500 })) {
        await btn.click();
        console.log('[LC] Clicked search:', sel);
        break;
      }
    } catch (_) {}
  }

  await page.waitForTimeout(2500);

  const rawTrips = await page.evaluate(() => {
    const headers = Array.from(
      document.querySelectorAll('table thead th, table thead td')
    ).map(function(h) { return h.innerText.trim(); });

    const rows = Array.from(document.querySelectorAll('table tbody tr'));
    return rows.map(function(row, i) {
      const cells = Array.from(row.querySelectorAll('td')).map(function(c) {
        return c.innerText.trim();
      });
      const id = row.getAttribute('data-id') ||
                 row.getAttribute('data-booking-id') || '';
      return { cells: cells, headers: headers, id: id, rowIndex: i };
    }).filter(function(r) { return r.cells.length > 1; });
  });

  console.log('[LC] Scraped', rawTrips.length, 'rows');
  const trips = normaliseRows(rawTrips, startDate);
  return { trips: trips, raw: rawTrips };
}

function normaliseRows(rawRows, fallbackDate) {
  if (!rawRows.length) return [];
  const hdrs = (rawRows[0].headers || []).map(function(h) {
    return h.toLowerCase();
  });

  function colIdx(keywords) {
    for (var k = 0; k < keywords.length; k++) {
      var kw = keywords[k];
      for (var i = 0; i < hdrs.length; i++) {
        if (hdrs[i].indexOf(kw) >= 0) return i;
      }
    }
    return -1;
  }

  var iRef    = colIdx(['ref', 'booking', 'job', 'id']);
  var iTime   = colIdx(['pickup', 'pick up', 'time', 'date']);
  var iPax    = colIdx(['pax', 'passenger', 'client', 'customer', 'name']);
  var iFrom   = colIdx(['from', 'pickup address', 'origin']);
  var iTo     = colIdx(['to', 'drop', 'destination']);
  var iDriver = colIdx(['driver', 'chauffeur']);
  var iStatus = colIdx(['status', 'state']);

  return rawRows.map(function(row, i) {
    var c = row.cells;
    var pickupRaw = iTime >= 0 ? c[iTime] : (c[1] || '');
    var pickupTime;
    try {
      var d = new Date(pickupRaw);
      pickupTime = isNaN(d.getTime())
        ? new Date(fallbackDate + 'T08:00:00').toISOString()
        : d.toISOString();
    } catch (e) {
      pickupTime = new Date(fallbackDate + 'T08:00:00').toISOString();
    }

    return {
      id:              String(i + 1),
      lcId:            row.id || (iRef >= 0 ? c[iRef] : '') || ('ROW-' + (i + 1)),
      refNo:           iRef >= 0 ? c[iRef] : ('#' + (i + 1)),
      pickupTime:      pickupTime,
      customer:        iPax    >= 0 ? c[iPax]    : '',
      from:            iFrom   >= 0 ? c[iFrom]   : '',
      to:              iTo     >= 0 ? c[iTo]     : '',
      currentDriver:   iDriver >= 0 ? c[iDriver] : '',
      status:          iStatus >= 0 ? c[iStatus] : '',
      rawCells:        c,
      tripMinutes:     30,
      durationMinutes: 30,
      busyMinutes:     30,
      distanceKm:      0,
      serviceType:     '',
      assignedDriver:  null,
      tripType:        'C2C',
      publishStatus:   'pending',
      manuallyEdited:  false,
    };
  });
}

async function assignDriver(lcId, driverName, durationMinutes) {
  const page = await getPage();
  await login(page);

  console.log('[LC] Assigning', driverName, 'to', lcId);
  await page.goto(LC_URL + '/#trips', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  const found = await page.evaluate(function(id) {
    const rows = Array.from(document.querySelectorAll('table tbody tr'));
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].innerText && rows[i].innerText.indexOf(id) >= 0) {
        rows[i].setAttribute('data-lc-target', id);
        return true;
      }
    }
    return false;
  }, lcId);

  if (!found) {
    throw new Error('Booking "' + lcId + '" not found in list');
  }

  const editSels = [
    '[data-lc-target="' + lcId + '"] button:has-text("Edit")',
    '[data-lc-target="' + lcId + '"] a:has-text("Edit")',
    '[data-lc-target="' + lcId + '"]',
  ];

  for (const sel of editSels) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 800 })) {
        await el.click();
        break;
      }
    } catch (_) {}
  }

  await page.waitForTimeout(1800);

  const driverSels = [
    'select[name*="driver" i]',
    'select[id*="driver" i]',
    'input[name*="driver" i]',
    'input[id*="driver" i]',
    'input[placeholder*="driver" i]',
    'input[placeholder*="chauffeur" i]',
  ];

  let driverSet = false;
  for (const sel of driverSels) {
    try {
      const el = page.locator(sel).first();
      if (!await el.isVisible({ timeout: 500 })) continue;
      const tag = await el.evaluate(function(e) {
        return e.tagName.toLowerCase();
      });
      if (tag === 'select') {
        const opts = await el.evaluate(function(s) {
          return Array.from(s.options).map(function(o) {
            return { v: o.value, t: o.text };
          });
        });
        const match = opts.find(function(o) {
          return o.t.toLowerCase().indexOf(driverName.toLowerCase()) >= 0;
        });
        if (match) {
          await el.selectOption({ value: match.v });
          driverSet = true;
        }
      } else {
        await el.fill(driverName);
        await page.waitForTimeout(700);
        try {
          const sug = page.locator('[class*="suggest"] li, [role="option"]').first();
          if (await sug.isVisible({ timeout: 800 })) await sug.click();
        } catch (_) {}
        driverSet = true;
      }
      if (driverSet) break;
    } catch (_) {}
  }

  if (!driverSet) {
    throw new Error('Could not find driver field for booking ' + lcId);
  }

  if (durationMinutes && durationMinutes > 0) {
    const durSels = [
      'input[name*="duration" i]',
      'input[name*="hours" i]',
      'input[placeholder*="duration" i]',
    ];
    for (const sel of durSels) {
      try {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 500 })) {
          await el.fill(String(durationMinutes));
          break;
        }
      } catch (_) {}
    }
  }

  const saveSels = [
    'button:has-text("Save")',
    'button:has-text("Update")',
    'button:has-text("Confirm")',
    'button[type="submit"]',
  ];

  for (const sel of saveSels) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 500 })) {
        await btn.click();
        break;
      }
    } catch (_) {}
  }

  await page.waitForTimeout(1500);
  return { ok: true, lcId: lcId, driverName: driverName };
}

async function closeBrowser() {
  if (_browser) {
    await _browser.close();
    _browser  = null;
    _page     = null;
    _loggedIn = false;
  }
}

module.exports = {
  fetchTripsByDateRange: fetchTripsByDateRange,
  assignDriver:          assignDriver,
  closeBrowser:          closeBrowser,
};
