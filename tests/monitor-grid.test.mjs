// Grid de-duplication, batching, and the server-controlled field allowlist.
// Pure unit tests — no emulator.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { gridKey, groupByCell, chunk, isFiniteCoord } from '../monitor/grid.js';
import { assertServerOnly, SERVER_CONTROLLED_FIELDS, PROTECTED_FIELDS } from '../monitor/fields.js';
import { createWeatherClient } from '../monitor/weather.js';

describe('gridKey', () => {
  test('rounds to ~1.1km cells', () => {
    assert.equal(gridKey(9.9312, 76.2673), '9.93,76.27');
    assert.equal(gridKey(9.9349, 76.2651), '9.93,76.27');
  });
  test('nearby coordinates collapse, distant ones do not', () => {
    assert.equal(gridKey(9.931, 76.267), gridKey(9.9314, 76.2668));
    assert.notEqual(gridKey(9.93, 76.27), gridKey(9.95, 76.27));
  });
  test('-0 normalises so it cannot create a twin cell', () => {
    assert.equal(gridKey(-0.001, 76.27), gridKey(0.001, 76.27));
  });
  test('precision is configurable', () => {
    assert.equal(gridKey(9.9312, 76.2673, 1), '9.9,76.3');
  });
});

describe('groupByCell', () => {
  const locs = [
    { id: 'a', lat: 9.9312, lon: 76.2673 },   // Kochi
    { id: 'b', lat: 9.9349, lon: 76.2651 },   // same cell as a
    { id: 'c', lat: 9.4981, lon: 76.3388 },   // Alappuzha
    { id: 'd', lat: 8.8932, lon: 76.6141 }    // Kollam
  ];

  test('collapses nearby locations into one cell', () => {
    const cells = groupByCell(locs);
    assert.equal(cells.size, 3, '4 locations should need only 3 forecast cells');
    const shared = [...cells.values()].find(c => c.locations.length === 2);
    assert.deepEqual(shared.locations.map(l => l.id).sort(), ['a', 'b']);
  });

  test('cell coordinates are the rounded centre, not a raw saved coordinate', () => {
    const cell = groupByCell([{ id: 'a', lat: 9.93124, lon: 76.26731 }]).get('9.93,76.27');
    assert.equal(cell.lat, 9.93);
    assert.equal(cell.lon, 76.27);
  });

  test('locations with unusable coordinates are skipped, not crashed on', () => {
    const cells = groupByCell([
      { id: 'ok', lat: 9.93, lon: 76.27 },
      { id: 'nullLat', lat: null, lon: 76.27 },
      { id: 'strLat', lat: '9.93', lon: 76.27 },
      { id: 'nan', lat: NaN, lon: 76.27 },
      { id: 'missing' }
    ]);
    assert.equal(cells.size, 1);
    assert.equal([...cells.values()][0].locations.length, 1);
  });

  test('an empty input yields no cells', () => {
    assert.equal(groupByCell([]).size, 0);
  });

  test('isFiniteCoord rejects strings and non-finite numbers', () => {
    assert.equal(isFiniteCoord(9.93), true);
    assert.equal(isFiniteCoord('9.93'), false);
    assert.equal(isFiniteCoord(Infinity), false);
    assert.equal(isFiniteCoord(null), false);
  });
});

describe('chunk', () => {
  test('splits into request-sized batches', () => {
    assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
    assert.deepEqual(chunk([], 10), []);
  });
  test('rejects a non-positive size', () => {
    assert.throws(() => chunk([1], 0), /positive/);
  });
});

describe('server-controlled field allowlist', () => {
  test('accepts the derived observation fields', () => {
    assert.doesNotThrow(() => assertServerOnly({
      rain: {}, forecast: {}, risk: {}, elevation: 5, terrainType: 'Coastal',
      alertState: {}, lastCheckedAt: 'x', lastUpdated: 'y'
    }));
  });

  test('refuses every protected ownership field', () => {
    for (const f of PROTECTED_FIELDS) {
      assert.throws(() => assertServerOnly({ risk: {}, [f]: 'x' }),
        /refused to write protected field/, `${f} must be refused`);
    }
  });

  test('refuses anything not on the allowlist', () => {
    assert.throws(() => assertServerOnly({ somethingNew: 1 }), /non-allowlisted/);
  });

  test('the two lists do not overlap', () => {
    for (const f of PROTECTED_FIELDS) assert.ok(!SERVER_CONTROLLED_FIELDS.includes(f));
  });
});

describe('weather client', () => {
  const cells = [{ key: '9.93,76.27', lat: 9.93, lon: 76.27 },
                 { key: '9.5,76.34', lat: 9.5, lon: 76.34 }];
  const hourly = { time: ['2026-09-01T00:00:00Z'], precipitation: [1] };

  test('batches multiple cells into ONE request with comma-separated coords', async () => {
    const urls = [];
    const w = createWeatherClient({
      fetchImpl: async (url) => {
        urls.push(url);
        return { ok: true, json: async () => [{ hourly }, { hourly }] };
      }
    });
    const res = await w.fetchHourly(cells);
    assert.equal(urls.length, 1, 'two cells must cost one request');
    assert.ok(urls[0].includes('latitude=9.93%2C9.5') || urls[0].includes('latitude=9.93,9.5'));
    assert.equal(res.hourly.size, 2);
    assert.equal(res.failures.length, 0);
  });

  test('the batch URL keeps the window parameters from risk.js', async () => {
    let seen;
    const w = createWeatherClient({
      fetchImpl: async (url) => { seen = url; return { ok: true, json: async () => [{ hourly }, { hourly }] }; }
    });
    await w.fetchHourly(cells);
    assert.ok(seen.includes('past_days=3'));
    assert.ok(seen.includes('forecast_days=2'));
    assert.ok(seen.includes('hourly=precipitation'));
  });

  test('honours batchSize', async () => {
    let calls = 0;
    const w = createWeatherClient({
      batchSize: 1,
      fetchImpl: async () => { calls++; return { ok: true, json: async () => ({ hourly }) }; }
    });
    await w.fetchHourly(cells);
    assert.equal(calls, 2);
  });

  test('a failed batch is recorded and does not throw', async () => {
    const w = createWeatherClient({ fetchImpl: async () => ({ ok: false, status: 503 }) });
    const res = await w.fetchHourly(cells);
    assert.equal(res.hourly.size, 0);
    assert.equal(res.failures.length, 1);
    assert.match(res.failures[0].error, /503/);
  });

  test('a network throw is caught per batch', async () => {
    const w = createWeatherClient({ fetchImpl: async () => { throw new Error('ECONNRESET'); } });
    const res = await w.fetchHourly(cells);
    assert.equal(res.failures.length, 1);
    assert.match(res.failures[0].error, /ECONNRESET/);
  });

  test('a result-count mismatch is treated as a failure rather than mis-assigned', async () => {
    const w = createWeatherClient({
      fetchImpl: async () => ({ ok: true, json: async () => [{ hourly }] })  // 1 for 2 cells
    });
    const res = await w.fetchHourly(cells);
    assert.equal(res.failures.length, 1);
    assert.equal(res.hourly.size, 0);
  });

  test('elevation maps values positionally onto cells', async () => {
    const w = createWeatherClient({
      fetchImpl: async () => ({ ok: true, json: async () => ({ elevation: [3, 41] }) })
    });
    const res = await w.fetchElevation(cells);
    assert.equal(res.elevation.get('9.93,76.27'), 3);
    assert.equal(res.elevation.get('9.5,76.34'), 41);
  });
});
