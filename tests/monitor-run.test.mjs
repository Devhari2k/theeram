// Full monitoring pass against the Firestore emulator.
// Run with: npm run test:monitor:emulator
//
// Never touches the live project: the Admin SDK is pointed at the emulator via
// FIRESTORE_EMULATOR_HOST and a demo-* project id, which has no real backend.

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { runOnce, HEARTBEAT_PATH } from '../monitor/run.js';

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
const PROJECT = 'demo-theeram-monitor';

let app, db;
before(() => { app = initializeApp({ projectId: PROJECT }, 'monitor-tests'); db = getFirestore(app); });
after(async () => { await deleteApp(app); });

const T0 = Date.UTC(2026, 8, 4, 0, 0, 0);
const HOUR = 3600e3;

// 120 hourly samples starting 3 days before T0; index 72 lands exactly on T0.
function hourly(mmPerHour) {
  const time = [], precipitation = [];
  const base = T0 - 72 * HOUR;
  for (let i = 0; i < 120; i++) {
    time.push(new Date(base + i * HOUR).toISOString().slice(0, 19) + 'Z');
    precipitation.push(mmPerHour);
  }
  return { time, precipitation };
}
// summarizeRainfall sums 25 trailing samples, so r24 = 25 * mmPerHour.
const DRY = hourly(0);          // r24 0      -> Minimal
const HIGH = hourly(5);         // r24 125    -> High
const SEVERE = hourly(9);       // r24 225    -> Severe

function weatherFor(mapping) {
  return {
    async fetchHourly(cells) {
      const m = new Map(); const failures = [];
      for (const c of cells) {
        const v = mapping[c.key];
        if (v === 'FAIL') failures.push({ cells: [c.key], error: 'simulated outage' });
        else if (v) m.set(c.key, v);
      }
      return { hourly: m, failures };
    },
    async fetchElevation(cells) {
      return { elevation: new Map(cells.map(c => [c.key, 5])), failures: [] };
    }
  };
}

async function seed(locations) {
  for (const c of ['families', 'alertDecisions', 'system']) {
    const s = await db.collection(c).get();
    await Promise.all(s.docs.map(d => d.ref.delete()));
  }
  const s = await db.collectionGroup('locations').get();
  await Promise.all(s.docs.map(d => d.ref.delete()));
  for (const l of locations) {
    await db.collection('families').doc(l.familyId).set({ name: 'fam' });
    await db.collection('families').doc(l.familyId).collection('locations').doc(l.id)
      .set({ ownerUid: l.ownerUid || 'u1', name: l.name || 'Place', lat: l.lat, lon: l.lon,
             ...(l.extra || {}) });
  }
}

const read = (familyId, id) =>
  db.collection('families').doc(familyId).collection('locations').doc(id).get().then(d => d.data());

const run = (mapping, opts = {}) => runOnce({
  db, weather: weatherFor(mapping), now: () => (opts.at ?? T0),
  logger: { log() {}, warn() {}, error() {} }, ...opts
});

const KOCHI = { familyId: 'f1', id: 'l1', lat: 9.9312, lon: 76.2673 };
const CELL = '9.93,76.27';

describe('monitor — full pass', () => {
  beforeEach(async () => { await seed([KOCHI]); });

  test('computes risk, writes server fields, and leaves identity fields alone', async () => {
    const s = await run({ [CELL]: HIGH });
    assert.equal(s.locationsChecked, 1);
    assert.equal(s.updated, 1);
    const d = await read('f1', 'l1');
    assert.equal(d.risk.level, 'High');
    assert.equal(d.rain.r24, 125);
    assert.equal(d.forecast.next24hMm, 120);
    // untouched
    assert.equal(d.ownerUid, 'u1');
    assert.equal(d.name, 'Place');
    assert.equal(d.lat, 9.9312);
    assert.equal(d.lon, 76.2673);
  });

  test('writes the heartbeat', async () => {
    await run({ [CELL]: HIGH });
    const h = (await db.collection(HEARTBEAT_PATH.collection).doc(HEARTBEAT_PATH.doc).get()).data();
    assert.equal(h.lastRunStatus, 'ok');
    assert.equal(h.locationsChecked, 1);
    assert.equal(h.alertsWouldSend, 1);
    assert.equal(typeof h.durationMs, 'number');
    assert.ok(h.lastRunAt);
  });

  test('records an alert decision but marks it undelivered', async () => {
    await run({ [CELL]: HIGH });
    const snap = await db.collection('alertDecisions').get();
    assert.equal(snap.size, 1);
    const d = snap.docs[0].data();
    assert.equal(d.kind, 'first');
    assert.equal(d.level, 'High');
    assert.equal(d.delivered, false, 'nothing may be delivered in this phase');
    assert.equal(d.deliveredAt, null);
  });

  test('backfills elevation and terrain when missing', async () => {
    await run({ [CELL]: HIGH });
    const d = await read('f1', 'l1');
    assert.equal(d.elevation, 5);
    assert.equal(d.terrainType, 'Coastal');
  });
});

describe('monitor — idempotency and overlap', () => {
  beforeEach(async () => { await seed([KOCHI]); });

  test('a second identical run decides nothing further', async () => {
    const a = await run({ [CELL]: HIGH });
    assert.equal(a.alertsWouldSend, 1);
    const b = await run({ [CELL]: HIGH });
    assert.equal(b.alertsWouldSend, 0, 'duplicate run must not re-alert');
    assert.equal(b.updated, 0, 'unchanged data must not be rewritten');
    assert.equal(b.unchanged, 1);
    assert.equal((await db.collection('alertDecisions').get()).size, 1);
  });

  test('two overlapping passes produce exactly one decision record', async () => {
    const [a, b] = await Promise.all([run({ [CELL]: HIGH }), run({ [CELL]: HIGH })]);
    const total = a.alertsWouldSend + b.alertsWouldSend;
    assert.ok(total >= 1, 'at least one pass must decide');
    // Deterministic decision ids mean a concurrent duplicate overwrites rather
    // than appending, so the record count is 1 whichever way the race lands.
    assert.equal((await db.collection('alertDecisions').get()).size, 1);
    const d = await read('f1', 'l1');
    assert.equal(d.alertState.band, 'high');
  });
});

describe('monitor — state machine end to end', () => {
  beforeEach(async () => { await seed([KOCHI]); });

  test('normal -> high -> severe -> high -> normal', async () => {
    await run({ [CELL]: DRY });
    assert.equal((await read('f1', 'l1')).alertState.band, 'normal');

    const up = await run({ [CELL]: HIGH }, { at: T0 + HOUR });
    assert.equal(up.decisions[0].kind, 'first');

    const esc = await run({ [CELL]: SEVERE }, { at: T0 + 2 * HOUR });
    assert.equal(esc.decisions[0].kind, 'escalation');
    assert.equal((await read('f1', 'l1')).alertState.episodeId, T0 + HOUR, 'same episode');

    const down = await run({ [CELL]: HIGH }, { at: T0 + 3 * HOUR });
    assert.equal(down.alertsWouldSend, 0, 'severe -> high is silent');
    assert.equal((await read('f1', 'l1')).alertState.band, 'high');

    const clear = await run({ [CELL]: DRY }, { at: T0 + 4 * HOUR });
    assert.equal(clear.decisions[0].kind, 'all_clear');
    const d = await read('f1', 'l1');
    assert.equal(d.alertState.band, 'normal');
    assert.equal(d.alertState.episodeId, null);
  });

  test('sustained reminder fires after the cooldown', async () => {
    await run({ [CELL]: SEVERE });
    const quiet = await run({ [CELL]: SEVERE }, { at: T0 + 6 * HOUR });
    assert.equal(quiet.alertsWouldSend, 0);
    const remind = await run({ [CELL]: SEVERE }, { at: T0 + 12 * HOUR });
    assert.equal(remind.decisions[0].kind, 'sustained');
  });
});

describe('monitor — resilience', () => {
  test('a failed cell does not kill the run and retains prior state', async () => {
    await seed([KOCHI, { familyId: 'f1', id: 'l2', lat: 9.4981, lon: 76.3388 }]);
    await run({ [CELL]: HIGH, '9.5,76.34': HIGH });
    const before = await read('f1', 'l1');

    const s = await run({ [CELL]: 'FAIL', '9.5,76.34': DRY }, { at: T0 + HOUR });
    assert.equal(s.lastRunStatus, 'degraded');
    assert.ok(s.weatherFailures >= 1);
    assert.equal(s.locationFailures, 1);

    const after = await read('f1', 'l1');
    assert.equal(after.risk.level, before.risk.level, 'stale data must be retained, not cleared');
    assert.equal(after.alertState.band, 'high', 'a missing forecast must not read as all-clear');

    assert.equal((await read('f1', 'l2')).risk.level, 'Minimal', 'other locations still processed');
  });

  test('heartbeat records the degraded status and failure counts', async () => {
    await seed([KOCHI]);
    await run({ [CELL]: 'FAIL' });
    const h = (await db.collection('system').doc('monitorHeartbeat').get()).data();
    assert.equal(h.lastRunStatus, 'degraded');
    assert.ok(h.weatherFailures >= 1);
  });
});

describe('monitor — scale and grouping', () => {
  test('multiple locations in one family each get their own state', async () => {
    await seed([
      { familyId: 'f1', id: 'l1', lat: 9.9312, lon: 76.2673 },
      { familyId: 'f1', id: 'l2', lat: 9.4981, lon: 76.3388 }
    ]);
    const s = await run({ [CELL]: SEVERE, '9.5,76.34': DRY });
    assert.equal(s.locationsChecked, 2);
    assert.equal(s.alertsWouldSend, 1);
    assert.equal((await read('f1', 'l1')).alertState.band, 'severe');
    assert.equal((await read('f1', 'l2')).alertState.band, 'normal');
  });

  test('multiple families are processed in one pass', async () => {
    await seed([
      { familyId: 'f1', id: 'l1', lat: 9.9312, lon: 76.2673 },
      { familyId: 'f2', id: 'l9', lat: 8.8932, lon: 76.6141 }
    ]);
    const s = await run({ [CELL]: HIGH, '8.89,76.61': SEVERE });
    assert.equal(s.locationsChecked, 2);
    assert.equal(s.alertsWouldSend, 2);
    assert.equal((await read('f1', 'l1')).risk.level, 'High');
    assert.equal((await read('f2', 'l9')).risk.level, 'Severe');
  });

  test('nearby locations share ONE forecast cell', async () => {
    await seed([
      { familyId: 'f1', id: 'l1', lat: 9.9312, lon: 76.2673 },
      { familyId: 'f2', id: 'l2', lat: 9.9349, lon: 76.2651 }   // different family, same cell
    ]);
    const s = await run({ [CELL]: HIGH });
    assert.equal(s.locationsChecked, 2);
    assert.equal(s.cells, 1, 'two locations, one Open-Meteo cell');
    assert.equal((await read('f1', 'l1')).risk.level, 'High');
    assert.equal((await read('f2', 'l2')).risk.level, 'High');
  });
});

describe('monitor — dry run', () => {
  beforeEach(async () => { await seed([KOCHI]); });

  test('reports what would happen and writes nothing', async () => {
    const s = await run({ [CELL]: SEVERE }, { dryRun: true });
    assert.equal(s.dryRun, true);
    assert.equal(s.alertsWouldSend, 1);
    assert.equal(s.plannedWrites.length, 1);
    assert.equal(s.plannedWrites[0].payload.risk.level, 'Severe');

    const d = await read('f1', 'l1');
    assert.equal(d.risk, undefined, 'dry run must not write the location');
    assert.equal(d.alertState, undefined);
    assert.equal((await db.collection('alertDecisions').get()).size, 0);
    const h = await db.collection('system').doc('monitorHeartbeat').get();
    assert.equal(h.exists, false, 'dry run must not write the heartbeat');
  });

  test('planned writes only ever contain allowlisted fields', async () => {
    const s = await run({ [CELL]: HIGH }, { dryRun: true });
    for (const k of Object.keys(s.plannedWrites[0].payload)) {
      assert.ok(!['ownerUid', 'name', 'lat', 'lon', 'createdAt'].includes(k), `leaked ${k}`);
    }
  });
});
