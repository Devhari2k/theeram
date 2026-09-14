// Theeram — privileged cleanup for a deleted user.
//
// The in-app deletion flow (www/js/account-delete.js) erases everything a
// client is permitted to erase. Two collections are deliberately out of its
// reach and are handled here instead:
//
//   alertDecisions — no security rule matches it, so every client request
//     falls to the default-deny catch-all. It is server-owned by design.
//   inviteCodes    — `allow delete: if false`, and `allow update` requires
//     used == false. A code naming a departed uid is already used, so it is
//     immutable to every client.
//
// Neither rule is relaxed. This module runs with the Admin SDK, which bypasses
// rules entirely, and is the only thing that touches these documents.
//
// IDEMPOTENT AND RETRY-SAFE BY CONSTRUCTION. Every operation it emits is a
// no-op when already applied: deleting an absent field, removing an absent
// array element, nulling an already-null field. A run that dies halfway can
// simply be run again — there is no partial state to reconcile and no cursor
// to persist.

import { FieldValue, FieldPath } from 'firebase-admin/firestore';

// Read page size. Kept well under the write batch so a page never produces
// more updates than one batch can hold.
export const SCAN_PAGE = 300;

// Firestore caps a batch at 500 writes.
export const WRITE_BATCH = 400;

// Refuse to scan an unbounded collection. alertDecisions grows by a handful
// of documents an hour; anything past this means something is wrong, and a
// runaway scan on a deletion path is worse than an incomplete one that says so.
export const MAX_SCAN_DOCS = 200000;

// ---------------------------------------------------------------------------
// Planning — pure. No Firestore, no Admin SDK, directly unit-testable.
// ---------------------------------------------------------------------------

/**
 * What must change on one alertDecisions document for `uid` to be gone from it.
 * Returns [] when the document does not mention the user, which is what makes
 * a re-run free.
 */
export function planDecisionCleanup(data, uid) {
  const ops = [];
  if (!data || !uid) return ops;

  const recipients = data.recipients;
  if (recipients && typeof recipients === 'object' &&
      Object.prototype.hasOwnProperty.call(recipients, uid)) {
    ops.push({ op: 'deleteField', path: ['recipients', uid] });
  }

  if (Array.isArray(data.undeliveredTo) && data.undeliveredTo.includes(uid)) {
    ops.push({ op: 'arrayRemove', path: ['undeliveredTo'], value: uid });
  }

  // Written only by monitor/test-fcm.js, but it is still a uid on a document
  // the user can never reach.
  if (data.syntheticTargetUid === uid) {
    ops.push({ op: 'setNull', path: ['syntheticTargetUid'] });
  }

  return ops;
}

/**
 * What must change on one inviteCodes document.
 *
 * `used` is deliberately NOT reset. The code was spent; clearing that would
 * resurrect a live invite into a family the departed user no longer belongs
 * to. Only the uid references are removed.
 */
export function planInviteCleanup(data, uid) {
  const ops = [];
  if (!data || !uid) return ops;
  if (data.usedBy === uid) ops.push({ op: 'setNull', path: ['usedBy'] });
  if (data.createdBy === uid) ops.push({ op: 'setNull', path: ['createdBy'] });
  return ops;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/**
 * Convert planned ops into the varargs form of update().
 *
 * FieldPath is used rather than a dotted string so a uid can never escape its
 * segment — `new FieldPath('recipients', uid)` treats uid as one literal key
 * whatever characters it contains. This is the same class of guard as
 * notify.js's recipient-path check, enforced structurally instead.
 */
export function toUpdateArgs(ops) {
  const args = [];
  for (const o of ops) {
    const path = new FieldPath(...o.path);
    if (o.op === 'deleteField') args.push(path, FieldValue.delete());
    else if (o.op === 'arrayRemove') args.push(path, FieldValue.arrayRemove(o.value));
    else if (o.op === 'setNull') args.push(path, null);
    else throw new Error(`purge: unknown op ${o.op}`);
  }
  return args;
}

/** Commit pending updates, in batches, and reset the accumulator. */
async function flush(db, pending, stats) {
  while (pending.length) {
    const slice = pending.splice(0, WRITE_BATCH);
    const batch = db.batch();
    for (const { ref, args } of slice) batch.update(ref, ...args);
    await batch.commit();
    stats.documentsUpdated += slice.length;
    stats.batches++;
  }
}

/**
 * Sweep alertDecisions.
 *
 * A full paged scan rather than a query on `recipients.<uid>`: that is a
 * dynamic map key, so querying it depends on Firestore having auto-indexed a
 * per-uid subfield, which is exactly the kind of assumption that fails
 * quietly on a deletion path. `undeliveredTo` alone could be found with
 * array-contains, but one scan covers every field at once and needs no index.
 * The collection is small by design — decisions retire after 12 hours.
 */
export async function purgeAlertDecisions(db, uid, { logger = console } = {}) {
  const stats = { scanned: 0, matched: 0, documentsUpdated: 0, batches: 0, truncated: false };
  const pending = [];
  let cursor = null;

  for (;;) {
    let q = db.collection('alertDecisions').orderBy(FieldPath.documentId()).limit(SCAN_PAGE);
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    if (snap.empty) break;

    for (const d of snap.docs) {
      stats.scanned++;
      const ops = planDecisionCleanup(d.data(), uid);
      if (ops.length) {
        stats.matched++;
        pending.push({ ref: d.ref, args: toUpdateArgs(ops) });
      }
    }
    if (pending.length >= WRITE_BATCH) await flush(db, pending, stats);

    cursor = snap.docs[snap.docs.length - 1].id;
    if (snap.size < SCAN_PAGE) break;
    if (stats.scanned >= MAX_SCAN_DOCS) {
      stats.truncated = true;
      logger.warn(`[purge] alertDecisions scan stopped at ${MAX_SCAN_DOCS} documents`);
      break;
    }
  }

  await flush(db, pending, stats);
  return stats;
}

/**
 * Sweep inviteCodes. Both uid-bearing fields are plain top-level equality
 * queries, so these are indexed by default and cost only what they match.
 */
export async function purgeInviteCodes(db, uid) {
  const stats = { scanned: 0, matched: 0, documentsUpdated: 0, batches: 0, truncated: false };
  const pending = [];
  const seen = new Set();

  for (const field of ['usedBy', 'createdBy']) {
    let cursor = null;
    for (;;) {
      let q = db.collection('inviteCodes')
        .where(field, '==', uid)
        .orderBy(FieldPath.documentId())
        .limit(SCAN_PAGE);
      if (cursor) q = q.startAfter(cursor);
      const snap = await q.get();
      if (snap.empty) break;

      for (const d of snap.docs) {
        stats.scanned++;
        // A code can name the user in both fields; update it once.
        if (seen.has(d.id)) continue;
        seen.add(d.id);
        const ops = planInviteCleanup(d.data(), uid);
        if (ops.length) {
          stats.matched++;
          pending.push({ ref: d.ref, args: toUpdateArgs(ops) });
        }
      }
      cursor = snap.docs[snap.docs.length - 1].id;
      if (snap.size < SCAN_PAGE) break;
    }
  }

  await flush(db, pending, stats);
  return stats;
}

/**
 * Everything the client could not reach, for one departed uid.
 * Safe to call repeatedly for the same uid.
 */
export async function purgeDeletedUser(db, uid, { logger = console } = {}) {
  if (!uid || typeof uid !== 'string') throw new Error('purgeDeletedUser: uid is required');
  const startedAt = Date.now();

  const alertDecisions = await purgeAlertDecisions(db, uid, { logger });
  const inviteCodes = await purgeInviteCodes(db, uid);

  const summary = {
    uid,
    alertDecisions,
    inviteCodes,
    durationMs: Date.now() - startedAt
  };
  // uid is an opaque identifier and this log is server-side; no name, place or
  // contact detail is ever printed.
  logger.log('[purge] ' + JSON.stringify({
    uid,
    decisionsMatched: alertDecisions.matched,
    decisionsScanned: alertDecisions.scanned,
    invitesMatched: inviteCodes.matched,
    truncated: alertDecisions.truncated,
    durationMs: summary.durationMs
  }));
  return summary;
}
