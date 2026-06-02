const express = require('express');
const cors    = require('cors');
const path    = require('path');
const lc      = require('./limoconnect');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Allocation logic ──────────────────────────────────────────────────────────

const AIRPORT_KW = ['cph', 'lufthavn', 'copenhagen airport', 'kastrup'];
const FAR_KM     = 45;

function norm(s) { return (s || '').trim().toLowerCase(); }
function isAirport(t) { const s = norm(t); return AIRPORT_KW.some(function(k) { return s.indexOf(k) >= 0; }); }

function bookingType(trip) {
  if (isAirport(trip.from)) return 'A2C';
  if (isAirport(trip.to))   return 'C2A';
  return 'C2C';
}

const GAP = {
  C2C: { C2C: 25, A2C: 30, C2A: 25 },
  A2C: { C2C: 50, A2C: 50, C2A: 50 },
  C2A: { C2C: 50, A2C: 0,  C2A: 40 },
};

function busyMins(trip) {
  var base = trip.tripMinutes || 30;
  var txt  = norm((trip.customer || '') + ' ' + (trip.serviceType || ''));
  var isRS = ['roadshow','site inspection','hourly'].some(function(k) { return txt.indexOf(k) >= 0; });
  if (isRS) {
    if (trip.durationMinutes > 0) return trip.durationMinutes;
    if (trip.durationHours   > 0) return Math.round(trip.durationHours * 60);
    return base + 60;
  }
  var km = parseFloat(trip.distanceKm) || 0;
  if (km >= FAR_KM) return base + (isAirport(trip.from) ? 30 : 0);
  return base;
}

function allocate(trips, drivers) {
  var sorted = trips.slice().sort(function(a, b) {
    return new Date(a.pickupTime) - new Date(b.pickupTime);
  });
  var st = {};
  drivers.forEach(function(d) {
    st[d.name] = {
      lastEnd:    null,
      lastType:   null,
      count:      0,
      shiftStart: d.shiftStart ? new Date(d.shiftStart) : null,
      shiftEnd:   d.shiftEnd   ? new Date(d.shiftEnd)   : null,
    };
  });

  return sorted.map(function(trip) {
    var pickup = new Date(trip.pickupTime);
    var busy   = busyMins(trip);
    var tType  = bookingType(trip);
    var best   = null;
    var bestScore = Infinity;

    drivers.forEach(function(d) {
      var s = st[d.name];
      if (s.shiftStart && pickup < new Date(s.shiftStart.getTime() - 30 * 60000)) return;
      if (s.shiftEnd   && pickup > new Date(s.shiftEnd.getTime()   + 30 * 60000)) return;
      if (s.lastEnd) {
        var gap = (pickup - s.lastEnd) / 60000;
        var req = (GAP[s.lastType] && GAP[s.lastType][tType]) ? GAP[s.lastType][tType] : 25;
        if (gap < req) return;
      }
      var shiftH = (s.shiftStart && s.shiftEnd) ? (s.shiftEnd - s.shiftStart) / 3600000 : 8;
      var score  = s.count / Math.max(shiftH, 0.1);
      if (score < bestScore) { best = d.name; bestScore = score; }
    });

    if (best) {
      st[best].lastEnd  = new Date(pickup.getTime() + busy * 60000);
      st[best].lastType = tType;
      st[best].count++;
    }

    return Object.assign({}, trip, {
      assignedDriver:  best || null,
      busyMinutes:     busy,
      durationMinutes: trip.durationMinutes || busy,
      tripType:        tType,
    });
  });
}

// ── Debug: full login + trips page inspection ─────────────────────────────────

app.get('/api/lc/screenshot', async function(req, res) {
  try {
    var chromium = require('playwright').chromium;
    var browser  = await chromium.launch({ headless: true });
    var page     = await browser.newPage({ viewport: { width: 1440, height: 900 } });

    var LC_EMAIL = process.env.LC_EMAIL || 'Bot@test.dk';
    var LC_PASS  = process.env.LC_PASS  || 'Test123!';

    // Step 1 — load login page
    await page.goto('https://eurolimo.limoconnect247.net', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(4000);
    var loginShot = await page.screenshot({ fullPage: true });

    // Step 2 — fill email
    var emailSels = ['input[type="email"]','input[name="email"]','input[placeholder*="mail" i]','input[type="text"]'];
    for (var i = 0; i < emailSels.length; i++) {
      try {
        var el = page.locator(emailSels[i]).first();
        if (await el.isVisible({ timeout: 800 })) { await el.fill(LC_EMAIL); break; }
      } catch(_) {}
    }

    // Step 3 — fill password
    var passSels = ['input[type="password"]','input[name="password"]','input[placeholder*="pass" i]'];
    for (var i = 0; i < passSels.length; i++) {
      try {
        var el = page.locator(passSels[i]).first();
        if (await el.isVisible({ timeout: 800 })) { await el.fill(LC_PASS); break; }
      } catch(_) {}
    }

    // Step 4 — submit
    var submitSels = ['button[type="submit"]','input[type="submit"]','button:has-text("Login")','button:has-text("Sign in")','button:has-text("Log in")'];
    for (var i = 0; i < submitSels.length; i++) {
      try {
        var el = page.locator(submitSels[i]).first();
        if (await el.isVisible({ timeout: 800 })) { await el.click(); break; }
      } catch(_) {}
    }

    await page.waitForTimeout(5000);
    var afterLoginShot = await page.screenshot({ fullPage: true });
    var afterLoginUrl  = page.url();

    // Step 5 — go to trips
    await page.goto('https://eurolimo.limoconnect247.net/#trips', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);
    var tripsShot = await page.screenshot({ fullPage: true });

    // Step 6 — inspect the DOM
    var pageInfo = await page.evaluate(function() {
      return {
        url:          location.href,
        title:        document.title,
        inputs:       Array.from(document.querySelectorAll('input')).map(function(i) {
                        return { type: i.type, name: i.name, id: i.id, placeholder: i.placeholder, cls: i.className.substring(0, 60) };
                      }),
        selects:      Array.from(document.querySelectorAll('select')).map(function(s) {
                        return { name: s.name, id: s.id, options: Array.from(s.options).slice(0, 5).map(function(o) { return o.text; }) };
                      }),
        tableHeaders: Array.from(document.querySelectorAll('th')).map(function(h) { return h.innerText.trim(); }),
        rowCount:     document.querySelectorAll('table tbody tr').length,
        allText:      document.body.innerText.substring(0, 3000),
      };
    });

    await browser.close();

    res.json({
      afterLoginUrl:        afterLoginUrl,
      tripsPageInfo:        pageInfo,
      loginScreenshot:      'data:image/png;base64,' + loginShot.toString('base64'),
      afterLoginScreenshot: 'data:image/png;base64,' + afterLoginShot.toString('base64'),
      tripsScreenshot:      'data:image/png;base64,' + tripsShot.toString('base64'),
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Pull bookings from LimoConnect ────────────────────────────────────────────

app.get('/api/lc/trips', async function(req, res) {
  try {
    var today     = new Date().toISOString().slice(0, 10);
    var startDate = req.query.start || today;
    var endDate   = req.query.end   || startDate;
    var result    = await lc.fetchTripsByDateRange(startDate, endDate);
    res.json({ ok: true, trips: result.trips, raw: result.raw });
  } catch(e) {
    console.error('[fetch trips]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Auto-allocate ─────────────────────────────────────────────────────────────

app.post('/api/allocate', function(req, res) {
  try {
    var allocated = allocate(req.body.trips, req.body.drivers);
    res.json({ ok: true, trips: allocated });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Assign single trip ────────────────────────────────────────────────────────

app.post('/api/lc/assign', async function(req, res) {
  try {
    var result = await lc.assignDriver(req.body.lcId, req.body.driverName, req.body.durationMinutes);
    res.json({ ok: true, result: result });
  } catch(e) {
    console.error('[assign]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Publish all ───────────────────────────────────────────────────────────────

app.post('/api/lc/publish-all', async function(req, res) {
  var trips   = req.body.trips;
  var results = [];
  for (var i = 0; i < trips.length; i++) {
    var trip = trips[i];
    if (!trip.assignedDriver || trip.publishStatus === 'published') {
      results.push({ lcId: trip.lcId, skipped: true });
      continue;
    }
    try {
      await lc.assignDriver(trip.lcId, trip.assignedDriver, trip.durationMinutes);
      results.push({ lcId: trip.lcId, ok: true });
    } catch(e) {
      results.push({ lcId: trip.lcId, ok: false, error: e.message });
    }
  }
  await lc.closeBrowser();
  res.json({ ok: true, results: results });
});

// ── Serve React app ───────────────────────────────────────────────────────────

app.get('*', function(req, res) {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', function() {
  console.log('\n🚖 EuroLimo Dispatcher → http://localhost:' + PORT + '\n');
});
