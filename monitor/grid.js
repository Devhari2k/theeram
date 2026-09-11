// Coordinate de-duplication (Phase 2.3 §D / §12).
//
// Open-Meteo serves a gridded model — its native resolution is kilometres, so
// two saved places a few hundred metres apart resolve to the same forecast.
// Fetching each separately would multiply API calls for identical data, which
// is the constraint that binds first as family count grows.
//
// Rounding to 2 decimal places is ~1.1 km at the equator, comfortably finer
// than the model grid and coarse enough that a family's home and a relative's
// house down the road usually collapse into one request.
//
// It also reduces what leaves Firebase: the request carries the rounded cell
// centre, not the exact saved coordinate.

export const DEFAULT_PRECISION = 2;

export function gridKey(lat, lon, precision = DEFAULT_PRECISION) {
  const rl = round(lat, precision);
  const ro = round(lon, precision);
  return `${rl},${ro}`;
}

function round(v, precision) {
  const f = Math.pow(10, precision);
  // +0 normalises -0 to 0 so "-0,12.34" and "0,12.34" cannot become two cells.
  return Math.round(Number(v) * f) / f + 0;
}

/**
 * Group locations into grid cells.
 * @returns {Map<string, {key, lat, lon, locations: object[]}>}
 */
export function groupByCell(locations, precision = DEFAULT_PRECISION) {
  const cells = new Map();
  for (const loc of locations) {
    if (!isFiniteCoord(loc.lat) || !isFiniteCoord(loc.lon)) continue;
    const key = gridKey(loc.lat, loc.lon, precision);
    let cell = cells.get(key);
    if (!cell) {
      const [lat, lon] = key.split(',').map(Number);
      cell = { key, lat, lon, locations: [] };
      cells.set(key, cell);
    }
    cell.locations.push(loc);
  }
  return cells;
}

export function isFiniteCoord(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Split cells into request-sized chunks. */
export function chunk(items, size) {
  if (!(size > 0)) throw new Error('chunk size must be positive');
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
