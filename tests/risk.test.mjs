// Theeram — risk engine equivalence / characterisation tests.
//
// Run with:  npm run test:risk
//
// These lock down the CURRENT behaviour of the risk model so the Phase 2.4.1
// extraction can be proven to be a pure refactor, and so any later change to
// the model is a deliberate, visible decision rather than an accident.
//
// They are characterisation tests: they assert what the shipped app DOES,
// including two quirks that are preserved on purpose (see below). If a future
// phase intentionally changes the model, these tests are expected to fail and
// must be updated as part of that change — do not "fix" the model to satisfy
// them, and do not relax them to accommodate a drive-by edit.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  TERRAIN_ICONS, classifyTerrain, computeRisk, isHighOrExtreme,
  summarizeRainfall, buildForecastUrl, buildElevationUrl
} from '../www/js/risk.js';

const r = (r24, r48 = 0, r72 = 0) => computeRisk({ r24, r48, r72 });

// ---------------------------------------------------------------------------
describe('computeRisk — IMD band thresholds', () => {
  test('Severe at r24 >= 204.5', () => {
    assert.equal(r(204.4).level, 'High');      // just below
    assert.equal(r(204.5).level, 'Severe');    // exactly at
    assert.equal(r(204.6).level, 'Severe');    // just above
  });

  test('Severe via the r48 >= 300 alternative', () => {
    assert.equal(r(0, 299.9).level, 'High');   // 299.9 still trips r48>=180
    assert.equal(r(0, 300).level, 'Severe');
    assert.equal(r(0, 300.1).level, 'Severe');
  });

  test('High at r24 >= 115.6', () => {
    assert.equal(r(115.5).level, 'Moderate');
    assert.equal(r(115.6).level, 'High');
    assert.equal(r(115.7).level, 'High');
  });

  test('High via the r48 >= 180 alternative', () => {
    assert.equal(r(0, 179.9).level, 'Minimal');
    assert.equal(r(0, 180).level, 'High');
    assert.equal(r(0, 180.1).level, 'High');
  });

  test('Moderate at r24 >= 64.5', () => {
    assert.equal(r(64.4).level, 'Low');
    assert.equal(r(64.5).level, 'Moderate');
    assert.equal(r(64.6).level, 'Moderate');
  });

  test('Moderate via the r72 >= 150 alternative', () => {
    assert.equal(r(0, 0, 149.9).level, 'Low');
    assert.equal(r(0, 0, 150).level, 'Moderate');
    assert.equal(r(0, 0, 150.1).level, 'Moderate');
  });

  // Note the asymmetry: the Low band uses STRICT >, every band above uses >=.
  test('Low at r24 > 20 — strictly greater, not >=', () => {
    assert.equal(r(20).level, 'Minimal');
    assert.equal(r(20.1).level, 'Low');
  });

  test('Low via r72 > 60 — strictly greater', () => {
    assert.equal(r(0, 0, 60).level, 'Minimal');
    assert.equal(r(0, 0, 60.1).level, 'Low');
  });

  test('Minimal at and below zero', () => {
    assert.equal(r(0).level, 'Minimal');
    assert.equal(r(-1).level, 'Minimal');
  });

  test('highest matching band wins regardless of argument order', () => {
    assert.equal(r(204.5, 300, 150).level, 'Severe');
    assert.equal(r(0, 180, 150).level, 'High');
  });
});

describe('computeRisk — returned shape, percentages and colours', () => {
  const expected = {
    Severe:   { pct: 95, color: 'var(--coral)' },
    High:     { pct: 72, color: 'var(--amber)' },
    Moderate: { pct: 45, color: 'var(--amber)' },
    Low:      { pct: 20, color: 'var(--safe)' },
    Minimal:  { pct: 6,  color: 'var(--safe)' }
  };
  const sample = { Severe: r(204.5), High: r(115.6), Moderate: r(64.5), Low: r(20.1), Minimal: r(0) };

  for (const [level, want] of Object.entries(expected)) {
    test(`${level}: pct ${want.pct}, colour ${want.color}`, () => {
      assert.equal(sample[level].level, level);
      assert.equal(sample[level].pct, want.pct);
      assert.equal(sample[level].color, want.color);
    });
  }

  test('always returns exactly level, pct, color, reason', () => {
    assert.deepEqual(Object.keys(r(0)).sort(), ['color', 'level', 'pct', 'reason']);
  });

  test('reasons quote the r24 value and are non-empty', () => {
    assert.match(r(204.5).reason, /Extremely heavy rainfall detected — 204\.5mm/);
    assert.match(r(115.6, 190).reason, /Very heavy rainfall — 115\.6mm in 24h, 190mm over 48h/);
    assert.match(r(64.5).reason, /Heavy rainfall recorded — 64\.5mm/);
    assert.match(r(20.1).reason, /light to moderate \(20\.1mm\/24h\)/);
    assert.match(r(0).reason, /Little to no recent rainfall \(0mm\/24h\)/);
  });
});

describe('computeRisk — missing and malformed input', () => {
  test('an empty object falls through to Minimal', () => {
    const out = computeRisk({});
    assert.equal(out.level, 'Minimal');
    assert.match(out.reason, /undefined/); // preserved: undefined is interpolated as-is
  });

  test('null fields behave as zero and give Minimal', () => {
    assert.equal(computeRisk({ r24: null, r48: null, r72: null }).level, 'Minimal');
  });

  test('NaN never satisfies a comparison, so NaN gives Minimal', () => {
    assert.equal(computeRisk({ r24: NaN, r48: NaN, r72: NaN }).level, 'Minimal');
  });

  test('numeric strings are coerced by the comparisons', () => {
    assert.equal(computeRisk({ r24: '80', r48: '0', r72: '0' }).level, 'Moderate');
  });

  test('Infinity reaches Severe; -Infinity reaches Minimal', () => {
    assert.equal(computeRisk({ r24: Infinity, r48: 0, r72: 0 }).level, 'Severe');
    assert.equal(computeRisk({ r24: -Infinity, r48: 0, r72: 0 }).level, 'Minimal');
  });
});

// ---------------------------------------------------------------------------
describe('classifyTerrain', () => {
  test('band boundaries', () => {
    assert.equal(classifyTerrain(7.9).type, 'Coastal');
    assert.equal(classifyTerrain(8).type, 'Low-lying floodplain');
    assert.equal(classifyTerrain(39.9).type, 'Low-lying floodplain');
    assert.equal(classifyTerrain(40).type, 'Midland');
    assert.equal(classifyTerrain(149.9).type, 'Midland');
    assert.equal(classifyTerrain(150).type, 'Highland');
  });

  test('zero, negative and very high elevations', () => {
    assert.equal(classifyTerrain(0).type, 'Coastal');
    assert.equal(classifyTerrain(-100).type, 'Coastal');
    assert.equal(classifyTerrain(1000).type, 'Highland');
  });

  test('null, undefined and NaN return null', () => {
    assert.equal(classifyTerrain(null), null);
    assert.equal(classifyTerrain(undefined), null);
    assert.equal(classifyTerrain(NaN), null);
  });

  // PRESERVED QUIRK: the guard is isNaN(), which coerces before testing, so
  // '' and false are treated as elevation 0 rather than rejected.
  test('QUIRK: empty string and false coerce to 0 and classify as Coastal', () => {
    assert.equal(classifyTerrain('').type, 'Coastal');
    assert.equal(classifyTerrain(false).type, 'Coastal');
    assert.equal(classifyTerrain([]).type, 'Coastal');
  });

  test('non-numeric strings are rejected', () => {
    assert.equal(classifyTerrain('abc'), null);
  });

  test('every band returns type, icon and desc, with the icon from TERRAIN_ICONS', () => {
    const pairs = [[0, 'coastal'], [10, 'floodplain'], [50, 'midland'], [500, 'highland']];
    for (const [elev, key] of pairs) {
      const t = classifyTerrain(elev);
      assert.deepEqual(Object.keys(t).sort(), ['desc', 'icon', 'type']);
      assert.equal(t.icon, TERRAIN_ICONS[key]);
      assert.ok(t.desc.length > 0);
    }
  });
});

// ---------------------------------------------------------------------------
describe('isHighOrExtreme', () => {
  test('true only for High and Severe', () => {
    assert.equal(isHighOrExtreme('High'), true);
    assert.equal(isHighOrExtreme('Severe'), true);
    for (const l of ['Minimal', 'Low', 'Moderate', 'high', 'SEVERE', '', null, undefined]) {
      assert.equal(isHighOrExtreme(l), false, `expected false for ${String(l)}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Fixtures use explicit Z-suffixed timestamps so the suite is timezone
// independent. Open-Meteo with timezone=auto returns NAIVE local timestamps
// ("2026-09-01T00:00"), which new Date() parses in the runtime's local zone —
// that is the shipped behaviour and is unchanged by this extraction.
function series(hours, gen, startISO = '2026-09-01T00:00:00Z') {
  const time = [], precipitation = [];
  const base = new Date(startISO).getTime();
  for (let i = 0; i < hours; i++) {
    time.push(new Date(base + i * 3600e3).toISOString().slice(0, 19) + 'Z');
    precipitation.push(gen(i));
  }
  return { time, precipitation };
}
// times[72] === now exactly, times[73] > now, so nowIdx settles at 72.
const NOW = new Date('2026-09-04T00:00:00Z');

describe('summarizeRainfall — window aggregation', () => {
  // PRESERVED QUIRK: the trailing loop runs (nowIdx - n)..nowIdx INCLUSIVE,
  // so it sums n+1 samples. The forward loop runs (nowIdx+1)..(nowIdx+n),
  // which is exactly n. The windows are deliberately asymmetric.
  test('QUIRK: trailing windows sum n+1 samples, forward sums n', () => {
    const out = summarizeRainfall(series(120, () => 1), NOW);
    assert.equal(out.r24, 25);              // indices 48..72
    assert.equal(out.r48, 49);              // indices 24..72
    assert.equal(out.r72, 73);              // indices  0..72
    assert.equal(out.forecastNext24h, 24);  // indices 73..96
  });

  test('returns exactly r24, r48, r72, forecastNext24h', () => {
    assert.deepEqual(Object.keys(summarizeRainfall(series(120, () => 0), NOW)).sort(),
      ['forecastNext24h', 'r24', 'r48', 'r72']);
  });

  test('zero rainfall yields zeros', () => {
    assert.deepEqual(summarizeRainfall(series(120, () => 0), NOW),
      { r24: 0, r48: 0, r72: 0, forecastNext24h: 0 });
  });

  test('nulls are skipped, not treated as zero-length windows', () => {
    const out = summarizeRainfall(series(120, i => (i % 2 ? null : 2)), NOW);
    assert.equal(out.r24, 26); // 13 even indices in 48..72, ×2
  });

  test('an all-null series yields zeros', () => {
    assert.deepEqual(summarizeRainfall(series(120, () => null), NOW),
      { r24: 0, r48: 0, r72: 0, forecastNext24h: 0 });
  });

  test('undefined samples are skipped like nulls (loose != null)', () => {
    assert.equal(summarizeRainfall(series(120, () => undefined), NOW).r24, 0);
  });

  test('results are rounded to one decimal place', () => {
    assert.equal(summarizeRainfall(series(120, () => 0.01), NOW).r24, 0.3); // 25×0.01 = 0.25 → 0.3
  });

  test('negative precipitation is summed as-is, not clamped', () => {
    assert.equal(summarizeRainfall(series(120, () => -1), NOW).r24, -25);
  });

  test('a short series clamps to the available samples', () => {
    const out = summarizeRainfall(series(3, () => 5), NOW);
    assert.equal(out.r24, 15);             // nowIdx falls at the last index
    assert.equal(out.forecastNext24h, 0);  // nothing beyond it
  });

  test('a single sample is handled without going out of range', () => {
    assert.deepEqual(summarizeRainfall(series(1, () => 9), NOW),
      { r24: 9, r48: 9, r72: 9, forecastNext24h: 0 });
  });

  test('an empty series yields zeros rather than throwing', () => {
    assert.deepEqual(summarizeRainfall({ time: [], precipitation: [] }, NOW),
      { r24: 0, r48: 0, r72: 0, forecastNext24h: 0 });
  });

  test('a clock before the series start anchors nowIdx at 0', () => {
    const out = summarizeRainfall(series(120, () => 1), new Date('2026-08-01T00:00:00Z'));
    assert.equal(out.r24, 1);
    assert.equal(out.forecastNext24h, 24);
  });

  test('a clock after the series end anchors nowIdx at the last sample', () => {
    const out = summarizeRainfall(series(120, () => 1), new Date('2027-01-01T00:00:00Z'));
    assert.equal(out.r24, 25);
    assert.equal(out.forecastNext24h, 0);
  });

  test('forecast window only counts samples strictly after now', () => {
    const out = summarizeRainfall(series(120, i => (i > 72 ? 3 : 0)), NOW);
    assert.equal(out.r24, 0);
    assert.equal(out.forecastNext24h, 72); // 24 samples × 3
  });
});

// ---------------------------------------------------------------------------
describe('summarizeRainfall → computeRisk end to end', () => {
  test('a heavy trailing series reaches Severe', () => {
    // 25 samples × 9mm = 225mm in the r24 window, over the 204.5 threshold.
    const out = summarizeRainfall(series(120, () => 9), NOW);
    assert.equal(out.r24, 225);
    assert.equal(computeRisk(out).level, 'Severe');
  });

  test('a dry series stays Minimal', () => {
    assert.equal(computeRisk(summarizeRainfall(series(120, () => 0), NOW)).level, 'Minimal');
  });
});

// ---------------------------------------------------------------------------
describe('URL builders', () => {
  test('forecast URL keeps the windows the aggregation depends on', () => {
    const u = buildForecastUrl(9.93, 76.26);
    assert.ok(u.startsWith('https://api.open-meteo.com/v1/forecast?'));
    assert.ok(u.includes('latitude=9.93'));
    assert.ok(u.includes('longitude=76.26'));
    assert.ok(u.includes('hourly=precipitation'));
    assert.ok(u.includes('past_days=3'));     // feeds the 72h trailing window
    assert.ok(u.includes('forecast_days=2')); // feeds forecastNext24h
    assert.ok(u.includes('timezone=auto'));
  });

  test('elevation URL', () => {
    assert.equal(buildElevationUrl(9.93, 76.26),
      'https://api.open-meteo.com/v1/elevation?latitude=9.93&longitude=76.26');
  });
});
