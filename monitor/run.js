// One monitoring pass.
//
// Everything external is injected — Firestore handle, weather client, clock,
// logger — so the whole pass can be driven against the emulator or against
// pure fakes. Nothing in here reaches for a global.

import { computeRisk, summarizeRainfall, classifyTerrain } from '../www/js/risk.js';
import { groupByCell, DEFAULT_PRECISION } from './grid.js';
import { decide, decisionId } from './alerts.js';
import { notifyUndelivered } from './notify.js';
import { assertServerOnly } from './fields.js';

export const HEARTBEAT_PATH = { collection: 'system', doc: 'monitorHeartbeat' };

// Rainfall totals are reported to 0.1mm, so anything smaller is noise. Writing
// on every jitter would burn the Spark write quota (Phase 2.3 §H) for a value
// nobody can see; write when the RISK LEVEL moves, or when rainfall moves
// enough to be visible in the UI.
const RAIN_EPSILON = 0.05;

function materiallyDifferent(prev, next) {
  if (!prev || !prev.risk || prev.risk.level !== next.risk.level) return true;
  const a = prev.rain || {};
  const b = next.rain;
  for (const k of ['r24', 'r48', 'r72']) {
    if (Math.abs(Number(a[k] ?? NaN) - b[k]) >= RAIN_EPSILON || Number.isNaN(Number(a[k]))) return true;
  }
  const pf = (prev.forecast || {}).next24hMm;
  if (Number.isNaN(Number(pf)) || Math.abs(Number(pf ?? NaN) - next.forecast.next24hMm) >= RAIN_EPSILON) return true;
  return false;
}

/**
 * @param {object} deps
 * @param {FirebaseFirestore.Firestore} deps.db
 * @param {object}   deps.weather      createWeatherClient()
 * @param {Function} [deps.now]        () => ms
 * @param {object}   [deps.logger]
 * @param {boolean}  [deps.dryRun]     when true nothing is written
 * @param {number}   [deps.precision]  grid precision
 * @param {object}   [deps.alertConfig]
 */
export async function runOnce(deps) {
  const {
    db, weather,
    now = () => Date.now(),
    logger = console,
    dryRun = false,
    precision = DEFAULT_PRECISION,
    alertConfig = {},
    // Optional. Absent (the default) means detection only, exactly as before.
    notifier = null,
    runId = `run-${Date.now()}`
  } = deps;

  const startedAt = now();
  const summary = {
    startedAt,
    dryRun,
    locationsChecked: 0,
    cells: 0,
    updated: 0,
    unchanged: 0,
    weatherFailures: 0,
    locationFailures: 0,
    alertsWouldSend: 0,
    decisions: [],
    plannedWrites: []
  };

  // ---- 1. read every saved location across all families -------------------
  const snap = await db.collectionGroup('locations').get();
  const locations = snap.docs.map(d => ({
    id: d.id,
    ref: d.ref,
    familyId: d.ref.parent.parent ? d.ref.parent.parent.id : null,
    ...d.data()
  }));
  summary.locationsChecked = locations.length;

  // ---- 2. collapse to grid cells -----------------------------------------
  const cells = groupByCell(locations, precision);
  summary.cells = cells.size;
  const cellList = [...cells.values()];

  // ---- 3. fetch weather (batched) ----------------------------------------
  const { hourly, failures: hourlyFailures } = await weather.fetchHourly(cellList);
  summary.weatherFailures += hourlyFailures.length;
  for (const f of hourlyFailures) {
    logger.warn(`[monitor] forecast batch failed for ${f.cells.length} cell(s): ${f.error}`);
  }

  // Elevation is static — only ask for cells where some location lacks it.
  const needElevation = cellList.filter(c => c.locations.some(l => l.elevation == null));
  let elevation = new Map();
  if (needElevation.length) {
    const res = await weather.fetchElevation(needElevation);
    elevation = res.elevation;
    summary.weatherFailures += res.failures.length;
    for (const f of res.failures) {
      logger.warn(`[monitor] elevation batch failed for ${f.cells.length} cell(s): ${f.error}`);
    }
  }

  // ---- 4. per location: compute, diff, transact --------------------------
  for (const cell of cellList) {
    const cellHourly = hourly.get(cell.key);
    for (const loc of cell.locations) {
      try {
        if (!cellHourly) {
          // No fresh data for this cell. Phase 2.3 §J: retain the previous
          // state rather than inventing one — a missing forecast must never
          // read as "risk has fallen".
          summary.locationFailures++;
          continue;
        }

        const rain = summarizeRainfall(cellHourly, new Date(now()));
        const risk = computeRisk(rain);

        const next = {
          rain: { r24: rain.r24, r48: rain.r48, r72: rain.r72 },
          forecast: { next24hMm: rain.forecastNext24h },
          risk: { level: risk.level, pct: risk.pct, color: risk.color, reason: risk.reason }
        };

        const elev = loc.elevation == null ? elevation.get(cell.key) : loc.elevation;
        if (loc.elevation == null && typeof elev === 'number') {
          next.elevation = elev;
          const terrain = classifyTerrain(elev);
          next.terrainType = terrain ? terrain.type : null;
        }

        const result = await applyLocation({
          db, ref: loc.ref, locationId: loc.id, familyId: loc.familyId,
          next, nowMs: now(), dryRun, alertConfig
        });

        if (result.decision) {
          summary.alertsWouldSend++;
          summary.decisions.push(result.decision);
          // Structured, non-identifying: ids only, never names or coordinates.
          logger.log('[monitor] ALERT DECISION ' + JSON.stringify({
            kind: result.decision.kind,
            level: result.decision.level,
            familyId: loc.familyId,
            locationId: loc.id,
            episodeId: result.decision.episodeId,
            wouldNotify: true,
            sent: false
          }));
        }
        if (result.written) summary.updated++; else summary.unchanged++;
        if (dryRun && result.payload) {
          summary.plannedWrites.push({ locationId: loc.id, familyId: loc.familyId, payload: result.payload });
        }
      } catch (err) {
        summary.locationFailures++;
        logger.warn(`[monitor] location ${loc.id} failed: ${String(err && err.message || err)}`);
      }
    }
  }

  // ---- 4.5 deliver notifications -----------------------------------------
  // Strictly after the detection phase, and driven by Firestore rather than by
  // `summary.decisions`, so a decision recorded by an earlier crashed run is
  // picked up too. Optional: with no notifier the monitor behaves exactly as
  // it did before this phase existed.
  if (notifier) {
    try {
      const n = await notifyUndelivered({ db, notifier, now, logger, runId, dryRun });
      summary.notifications = n;
    } catch (err) {
      // Delivery must never take the monitoring pass down with it.
      summary.notificationError = String(err && err.message || err);
      logger.warn(`[monitor] notification phase failed: ${summary.notificationError}`);
    }
  }

  // ---- 5. heartbeat -------------------------------------------------------
  const finishedAt = now();
  summary.durationMs = finishedAt - startedAt;
  summary.lastRunStatus = summary.locationFailures || summary.weatherFailures ? 'degraded' : 'ok';

  const heartbeat = {
    lastRunAt: new Date(finishedAt).toISOString(),
    lastRunStatus: summary.lastRunStatus,
    locationsChecked: summary.locationsChecked,
    alertsWouldSend: summary.alertsWouldSend,
    durationMs: summary.durationMs,
    cells: summary.cells,
    updated: summary.updated,
    unchanged: summary.unchanged,
    weatherFailures: summary.weatherFailures,
    locationFailures: summary.locationFailures,
    notificationsSent: summary.notifications ? summary.notifications.sent : 0,
    notificationFailures: summary.notifications ? summary.notifications.failures : 0,
    decisionsDelivered: summary.notifications ? summary.notifications.delivered : 0,
    // Non-zero means somebody was never reached. Worth watching.
    decisionsRetired: summary.notifications ? summary.notifications.retired : 0,
    dryRun
  };
  summary.heartbeat = heartbeat;

  if (!dryRun) {
    await db.collection(HEARTBEAT_PATH.collection).doc(HEARTBEAT_PATH.doc).set(heartbeat);
  }

  return summary;
}

/**
 * Read-modify-write for one location, inside a transaction.
 *
 * The transaction matters: cron schedules overlap in practice (a slow run, a
 * manual run alongside a scheduled one), and two passes deciding from the same
 * stale alertState would both conclude "normal -> high" and record the
 * transition twice. Re-reading alertState inside the transaction means the
 * second pass sees the first pass's band and stays silent.
 */
export async function applyLocation({ db, ref, locationId, familyId, next, nowMs, dryRun, alertConfig }) {
  if (dryRun) {
    const snap = await ref.get();
    const cur = snap.exists ? snap.data() : {};
    const { state, decision } = decide(cur.alertState, next.risk.level, nowMs, alertConfig);
    const changed = materiallyDifferent(cur, next);
    const payload = changed || decision
      ? assertServerOnly({ ...next, alertState: state, lastCheckedAt: new Date(nowMs).toISOString() })
      : null;
    return { written: false, decision, payload };
  }

  let decision = null;
  let written = false;
  let payload = null;

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const cur = snap.data();

    const out = decide(cur.alertState, next.risk.level, nowMs, alertConfig);
    decision = out.decision;

    const changed = materiallyDifferent(cur, next);
    if (!changed && !decision) return;

    payload = assertServerOnly({
      ...next,
      alertState: out.state,
      lastCheckedAt: new Date(nowMs).toISOString(),
      lastUpdated: new Date(nowMs).toISOString()
    });
    tx.set(ref, payload, { merge: true });
    written = true;

    if (decision) {
      // Deterministic id: re-deciding the same transition overwrites rather
      // than appending, so the record cannot double up either.
      const id = decisionId(locationId, decision);
      tx.set(db.collection('alertDecisions').doc(id), {
        locationId, familyId,
        kind: decision.kind,
        level: decision.level,
        band: decision.band,
        episodeId: decision.episodeId,
        decidedAt: new Date(decision.at).toISOString(),
        delivered: false,      // no FCM in this phase
        deliveredAt: null
      });
    }
  });

  return { written, decision, payload };
}
