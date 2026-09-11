// Which fields on a location document the monitor is allowed to write.
//
// The monitor runs with the Admin SDK, which bypasses Firestore security
// rules entirely. The rules that protect ownership fields from the CLIENT
// (Phase 2.2 / commit 5899bca) do not constrain this process at all, so the
// allowlist below IS the control. Every write goes through assertServerOnly()
// before it reaches Firestore.
//
// The existing schema does not mark server-controlled fields explicitly, so
// the split is inferred from who writes them today (see www/js/family.js and
// the handleAdd/loadTerrain/checkFamilyRiskOnce paths in www/index.html):
//
//   Client-owned identity/ownership — the monitor must NEVER touch these:
//     ownerUid, name, lat, lon, createdAt
//
//   Derived observation fields — written by the client today, and by the
//   monitor from now on. Recomputing them is the monitor's whole job:
//     rain, forecast, risk, elevation, terrainType
//
//   Monitor-only bookkeeping, introduced by this phase:
//     alertState, lastCheckedAt
//
//   lastUpdated is shared: the client stamps it on every write and so does
//   the monitor, because the client UI renders "Updated <relTime>" from it.

export const SERVER_CONTROLLED_FIELDS = Object.freeze([
  'rain',
  'forecast',
  'risk',
  'elevation',
  'terrainType',
  'alertState',
  'lastCheckedAt',
  'lastUpdated'
]);

// Never writable by the monitor under any circumstance. Listed explicitly so
// that a mistake is a loud throw rather than a silent overwrite of somebody's
// saved place — a bug here would corrupt user data the monitor does not own.
export const PROTECTED_FIELDS = Object.freeze([
  'ownerUid',
  'name',
  'lat',
  'lon',
  'createdAt'
]);

export function assertServerOnly(payload) {
  const keys = Object.keys(payload);
  const forbidden = keys.filter(k => PROTECTED_FIELDS.includes(k));
  if (forbidden.length) {
    throw new Error(`monitor refused to write protected field(s): ${forbidden.join(', ')}`);
  }
  const unknown = keys.filter(k => !SERVER_CONTROLLED_FIELDS.includes(k));
  if (unknown.length) {
    throw new Error(`monitor refused to write non-allowlisted field(s): ${unknown.join(', ')}`);
  }
  return payload;
}
