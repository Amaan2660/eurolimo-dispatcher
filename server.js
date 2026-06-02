const express = require('express');
const cors    = require('cors');
const path    = require('path');
const lc      = require('./limoconnect');

const app  = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Allocation logic ──────────────────────────────────────────────────────────

const AIRPORT_KW = ['cph', 'lufthavn', 'copenhagen airport', 'kastrup'];
const FAR_KM     = 45;

function norm(s) { return (s || '').trim().toLowerCase(); }
function isAirport(t) { const s = norm(t); return AIRPORT_KW.some(k => s.includes(k)); }

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
  const base = trip.tripMinutes || 30;
  const txt  = norm(`${trip.customer||''} ${trip.serviceType||''}`);
  const isRS = ['roadshow','site inspection','hourly'].some(k => txt.includes(k));
  if (isRS) {
    if (trip.durationMinutes > 0) return trip.durationMinutes;
    if (trip.durationHours   > 0) return Math.round(trip.durationHours * 60);
    return base + 60;
  }
  const km = parseFloat(trip.distanceKm) || 0;
  if (km >= FAR_KM) return base + (isAirport(trip.from) ? 30 : 0);
  return base;
}

function allocate(trips, drivers) {
  const sorted = [...trips].sort((a,b) => new Date(a.pickupTime) - new Date(b.pickupTime));
  const st = {};
  drivers.forEach(d => {
    st[d.name] = {
      lastEnd: null, lastType: null, count: 0,
      shiftStart: d.shiftStart ? new Date(d.shiftStart) : null,
      shiftEnd:   d.shiftEnd   ? new Date(d.shiftEnd)   : null,
    };
  });

  return sorted.map(trip => {
    const pickup = new Date(trip.pickupTime);
    const busy   = busyMins(trip);
    const tType  = bookingType(trip);
    let best = null, bestScore = Infinity;

    drivers.forEach(d => {
      const s = st[d.name];
      if (s.shiftStart && pickup < new Date(s.shiftStart.getTime() - 30*60000)) return;
      if (s.shiftEnd   && pickup > new Date(s.shiftEnd.getTime()   + 30*60000)) return;
      if (s.lastEnd) {
        const gap = (pickup - s.lastEnd) / 60000;
        if (gap < (GAP[s.lastType]?.[tType] ?? 25)) return;
      }
      const shiftH = s.shiftStart && s.shiftEnd ? (s.shiftEnd - s.shiftStart)/3600000 : 8;
      const score  = s.count / Math.max(shiftH, 0.1);
      if (score < bestScore) { best = d.name; bestScore = score; }
    });

    if (best) {
      st[best].lastEnd  = new Date(pickup.getTime() + busy*60000);
      st[best].lastType = tType;
      st[best].count++;
    }

    return { ...trip, assignedDriver: best||null, busyMinutes: busy, durationMinutes: trip.durationMinutes || busy, tripType: tType };
  });
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Pull bookings from LimoConnect for a date range
app.get('/api/lc/trips', async (req, res) => {
  try {
    const today     = new Date().toISOString().slice(0,10);
    const startDate = req.query.start || today;
    const endDate   = req.query.end   || startDate;
    const result    = await lc.fetchTripsByDateRange(startDate, endDate);
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[fetch trips]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Auto-allocate
app.post('/api/allocate', (req, res) => {
  try {
    const { trips, drivers } = req.body;
    const allocated = allocate(trips, drivers);
    res.json({ ok: true, trips: allocated });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Assign single trip
app.post('/api/lc/assign', async (req, res) => {
  try {
    const { lcId, driverName, durationMinutes } = req.body;
    const result = await lc.assignDriver(lcId, driverName, durationMinutes);
    res.json({ ok: true, result });
  } catch (e) {
    console.error('[assign]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Publish all
app.post('/api/lc/publish-all', async (req, res) => {
  const { trips } = req.body;
  const results   = [];
  for (const trip of trips) {
    if (!trip.assignedDriver || trip.publishStatus === 'published') {
      results.push({ lcId: trip.lcId, skipped: true }); continue;
    }
    try {
      await lc.assignDriver(trip.lcId, trip.assignedDriver, trip.durationMinutes);
      results.push({ lcId: trip.lcId, ok: true });
    } catch (e) {
      results.push({ lcId: trip.lcId, ok: false, error: e.message });
    }
  }
  await lc.closeBrowser();
  res.json({ ok: true, results });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`\n🚖 EuroLimo Dispatcher → http://localhost:${PORT}\n`));
