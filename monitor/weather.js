// Open-Meteo access for the monitor.
//
// The query parameters are NOT restated here. Both URLs are derived from
// www/js/risk.js's builders and then have their coordinate lists swapped in,
// so past_days/forecast_days/hourly stay defined in exactly one place. Those
// parameters determine whether summarizeRainfall()'s 72h trailing and 24h
// forward windows have any samples to add up; if they drifted apart from the
// aggregation, risk would quietly be computed over the wrong span.

import { buildForecastUrl, buildElevationUrl } from '../www/js/risk.js';
import { chunk } from './grid.js';

export const DEFAULT_BATCH_SIZE = 50;

function withCoords(templateUrl, cells) {
  const u = new URL(templateUrl);
  u.searchParams.set('latitude', cells.map(c => c.lat).join(','));
  u.searchParams.set('longitude', cells.map(c => c.lon).join(','));
  return u.toString();
}

// A single coordinate returns an object; multiple return an array. Normalise.
function asArray(payload, expected) {
  const arr = Array.isArray(payload) ? payload : [payload];
  if (arr.length !== expected) {
    throw new Error(`Open-Meteo returned ${arr.length} results for ${expected} coordinates`);
  }
  return arr;
}

/**
 * @param {object} [opts]
 * @param {Function} [opts.fetchImpl]  injected for tests; defaults to global fetch
 * @param {number}   [opts.batchSize]
 */
export function createWeatherClient(opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const batchSize = opts.batchSize || DEFAULT_BATCH_SIZE;

  async function getJson(url) {
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`Open-Meteo responded ${res.status}`);
    return res.json();
  }

  /**
   * @returns {{ hourly: Map<string,object>, failures: Array<{cells:string[], error:string}> }}
   * A failed batch is recorded and the run continues; those cells simply have
   * no fresh data this time and their stored risk is retained.
   */
  async function fetchHourly(cells) {
    const hourly = new Map();
    const failures = [];
    for (const batch of chunk(cells, batchSize)) {
      try {
        const payload = await getJson(withCoords(buildForecastUrl(0, 0), batch));
        const results = asArray(payload, batch.length);
        results.forEach((r, i) => {
          if (r && r.hourly) hourly.set(batch[i].key, r.hourly);
        });
      } catch (err) {
        failures.push({ cells: batch.map(c => c.key), error: String(err && err.message || err) });
      }
    }
    return { hourly, failures };
  }

  /** Elevation is static, so it is only fetched for cells that ask for it. */
  async function fetchElevation(cells) {
    const elevation = new Map();
    const failures = [];
    for (const batch of chunk(cells, batchSize)) {
      try {
        const payload = await getJson(withCoords(buildElevationUrl(0, 0), batch));
        // The elevation endpoint answers a single object whose `elevation`
        // array is parallel to the coordinate list.
        const values = Array.isArray(payload && payload.elevation) ? payload.elevation : [];
        batch.forEach((c, i) => {
          if (typeof values[i] === 'number') elevation.set(c.key, values[i]);
        });
      } catch (err) {
        failures.push({ cells: batch.map(c => c.key), error: String(err && err.message || err) });
      }
    }
    return { elevation, failures };
  }

  return { fetchHourly, fetchElevation };
}
