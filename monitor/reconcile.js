// Theeram — reconcile residual records against live Firebase Auth accounts.
//
// WHY THIS EXISTS INSTEAD OF A CLOUD FUNCTION
//
// The natural hook is functions.auth.user().onDelete(), which fires the moment
// an account is removed. It is a 1st-generation Cloud Function, and Cloud
// Functions cannot be deployed on the Spark plan. Theeram stays on Spark at
// ₹0 recurring cost, so there is no trigger to hang this off.
//
// What is available is the infrastructure the monitor already uses: GitHub
// Actions, Workload Identity Federation, and the Admin SDK — all free. So
// instead of reacting to a deletion event, this job periodically reconciles:
// it asks which uids the residual collections still mention, asks Firebase Auth
// which uids still exist, and cleans up the difference.
//
// The trade is latency, not correctness. Cleanup is eventual — bounded by the
// schedule, not instant. The client-side deletion flow is immediate for
// everything it can reach; this closes the remainder on the next run.
//
// WHY IT CANNOT DELETE A LIVE USER'S DATA
//
// A uid is only ever purged when it is BOTH referenced by a residual record
// AND absent from a COMPLETE enumeration of Firebase Auth. "Complete" is the
// load-bearing word: if listUsers() throws on any page, the run aborts before
// a single write. A partial live set would misclassify live users as departed,
// which is the one failure this job must never have. It fails closed.

import { planDecisionCleanup, planInviteCleanup, toUpdateArgs, SCAN_PAGE, WRITE_BATCH }
  from './purge.js';

/** Firebase Auth's maximum page size for listUsers(). */
export const AUTH_PAGE = 1000;

/** Bounded work per run. Anything left over is reported and picked up next run. */
export const MAX_DEPARTED_PER_RUN = 500;

/** Refuse to scan an unbounded collection rather than run away on a delete path. */
export const MAX_SCAN_DOCS = 200000;

export const RESIDUAL_COLLECTIONS = Object.freeze(['alertDecisions', 'inviteCodes']);

// ---------------------------------------------------------------------------
// 1. Candidate discovery — pure extraction
// ---------------------------------------------------------------------------

/**
 * Every uid one alertDecisions document mentions.
 *
 * `recipients` is a map keyed by uid, and Firestore cannot query or aggregate
 * dynamic map keys — there is no way to ask "which uids appear here". The only
 * way to learn them is to read the documents, which is why discovery scans
 * rather than queries.
 */
export function uidsInDecision(data) {
  const out = new Set();
  if (!data) return out;
  const r = data.recipients;
  if (r && typeof r === 'object') for (const uid of Object.keys(r)) out.add(uid);
  if (Array.isArray(data.undeliveredTo)) for (const uid of data.undeliveredTo) {
    if (typeof uid === 'string' && uid) out.add(uid);
  }
  if (typeof data.syntheticTargetUid === 'string' && data.syntheticTargetUid) {
    out.add(data.syntheticTargetUid);
  }
  return out;
}

/** Every uid one inviteCodes document mentions. */
export function uidsInInvite(data) {
  const out = new Set();
  if (!data) return out;
  for (const f of ['usedBy', 'createdBy']) {
    if (typeof data[f] === 'string' && data[f]) out.add(data[f]);
  }
  return out;
}

/** Page through a collection by document id, calling back with each snapshot. */
async function scanCollection(db, name, onDoc, { max = MAX_SCAN_DOCS } = {}) {
  const { FieldPath } = fieldTypesOf(db);
  let cursor = null, scanned = 0, truncated = false;
  for (;;) {
    let q = db.collection(name).orderBy(FieldPath.documentId()).limit(SCAN_PAGE);
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    if (snap.empty) break;
    for (const d of snap.docs) { scanned++; await onDoc(d); }
    cursor = snap.docs[snap.docs.length - 1].id;
    if (snap.size < SCAN_PAGE) break;
    if (scanned >= max) { truncated = true; break; }
  }
  return { scanned, truncated };
}

function fieldTypesOf(db) {
  const C = db && db.constructor;
  if (!C || typeof C.FieldPath !== 'function') {
    throw new Error('reconcile: could not resolve Firestore field types from the db instance');
  }
  return { FieldPath: C.FieldPath };
}

/** Every uid referenced anywhere in the residual collections. */
export async function discoverReferencedUids(db) {
  const referenced = new Set();
  const stats = {};
  const d = await scanCollection(db, 'alertDecisions', (doc) => {
    for (const uid of uidsInDecision(doc.data())) referenced.add(uid);
  });
  stats.alertDecisions = d;
  const i = await scanCollection(db, 'inviteCodes', (doc) => {
    for (const uid of uidsInInvite(doc.data())) referenced.add(uid);
  });
  stats.inviteCodes = i;
  return { referenced, stats, truncated: d.truncated || i.truncated };
}

// ---------------------------------------------------------------------------
// 2. Auth enumeration
// ---------------------------------------------------------------------------

/**
 * The COMPLETE set of live Auth uids.
 *
 * Throws if any page fails. The caller must not fall back to a partial set:
 * every uid missing from it would be treated as departed.
 */
export async function listAllAuthUids(auth, { pageSize = AUTH_PAGE, logger = console } = {}) {
  const live = new Set();
  let pageToken;
  let pages = 0;
  do {
    const res = await auth.listUsers(pageSize, pageToken);
    for (const u of res.users) if (u && u.uid) live.add(u.uid);
    pageToken = res.pageToken;
    pages++;
  } while (pageToken);
  logger.log(`[reconcile] enumerated ${live.size} live Auth account(s) across ${pages} page(s)`);
  return live;
}

// ---------------------------------------------------------------------------
// 3. Reconciliation decision — pure
// ---------------------------------------------------------------------------

/**
 * Which referenced uids are departed, with the safety checks that decide
 * whether ANY purge may proceed.
 *
 * `authComplete` is not advisory. A false value means the live set cannot be
 * trusted, and nothing is eligible no matter what the sets say.
 */
export function decideDeparted({ referenced, live, authComplete, max = MAX_DEPARTED_PER_RUN }) {
  const ref = [...referenced].sort();
  if (!authComplete) {
    return { departed: [], deferred: [], abort: true, reason: 'auth-enumeration-incomplete' };
  }
  // An empty live set alongside referenced uids is far more likely to be a
  // credentials or API failure than a project with zero accounts and stale
  // data. Treating it as "everyone is departed" would erase the lot.
  if (live.size === 0 && ref.length > 0) {
    return { departed: [], deferred: ref, abort: true, reason: 'auth-returned-no-users' };
  }
  const departedAll = ref.filter(uid => !live.has(uid));
  return {
    departed: departedAll.slice(0, max),
    deferred: departedAll.slice(max),
    abort: false,
    reason: null
  };
}

// ---------------------------------------------------------------------------
// 4. Purge execution — one pass per collection, all departed uids at once
// ---------------------------------------------------------------------------

/**
 * Apply cleanup for EVERY departed uid in a single scan of each collection.
 *
 * Calling the per-uid sweep once per departed user would re-scan the whole
 * collection each time; merging the plans means the cost is two passes total
 * (one to discover, one to apply) regardless of how many accounts departed.
 */
export async function purgeDeparted(db, departed, { dryRun = true, logger = console } = {}) {
  const set = new Set(departed);
  const stats = {
    alertDecisions: { scanned: 0, matched: 0, documentsUpdated: 0, batches: 0 },
    inviteCodes: { scanned: 0, matched: 0, documentsUpdated: 0, batches: 0 },
    dryRun
  };
  if (!set.size) return stats;

  for (const [name, planner] of [['alertDecisions', planDecisionCleanup], ['inviteCodes', planInviteCleanup]]) {
    const s = stats[name];
    let pending = [];
    const flush = async () => {
      while (pending.length) {
        const slice = pending.splice(0, WRITE_BATCH);
        if (!dryRun) {
          const batch = db.batch();
          for (const { ref, args } of slice) batch.update(ref, ...args);
          await batch.commit();
          s.batches++;
        }
        s.documentsUpdated += slice.length;
      }
    };

    const res = await scanCollection(db, name, async (doc) => {
      const data = doc.data();
      const ops = [];
      for (const uid of set) ops.push(...planner(data, uid));
      if (!ops.length) return;
      s.matched++;
      pending.push({ ref: doc.ref, args: toUpdateArgs(db, ops) });
      if (pending.length >= WRITE_BATCH) await flush();
    });
    await flush();
    s.scanned = res.scanned;
    if (res.truncated) s.truncated = true;
  }

  logger.log(`[reconcile] ${dryRun ? 'DRY RUN — would update' : 'updated'} ` +
    `${stats.alertDecisions.documentsUpdated} alertDecisions and ` +
    `${stats.inviteCodes.documentsUpdated} inviteCodes document(s)`);
  return stats;
}

// ---------------------------------------------------------------------------
// The whole pass
// ---------------------------------------------------------------------------

/**
 * Discover, enumerate, decide, purge. Safe to run repeatedly: every operation
 * the planners emit is a no-op once applied, so a second run matches nothing
 * and a run that died halfway is fixed by running it again.
 */
export async function reconcileUsers({ db, auth, dryRun = true, logger = console,
                                       max = MAX_DEPARTED_PER_RUN } = {}) {
  if (!db) throw new Error('reconcile: db is required');
  if (!auth) throw new Error('reconcile: auth is required');
  const startedAt = Date.now();

  const { referenced, stats: scanStats, truncated } = await discoverReferencedUids(db);
  logger.log(`[reconcile] ${referenced.size} uid(s) referenced across ` +
    `${scanStats.alertDecisions.scanned} alertDecisions and ${scanStats.inviteCodes.scanned} inviteCodes`);

  let live = new Set();
  let authComplete = false;
  let authError = null;
  try {
    live = await listAllAuthUids(auth, { logger });
    authComplete = true;
  } catch (err) {
    authError = String((err && err.message) || err);
    logger.warn(`[reconcile] Auth enumeration FAILED, refusing to purge: ${authError}`);
  }

  const decision = decideDeparted({ referenced, live, authComplete, max });

  let purge = null;
  if (decision.abort) {
    logger.warn(`[reconcile] ABORTED before any write: ${decision.reason}`);
  } else if (decision.departed.length) {
    purge = await purgeDeparted(db, decision.departed, { dryRun, logger });
  } else {
    logger.log('[reconcile] no departed uids referenced; nothing to do');
  }

  const summary = {
    dryRun,
    referencedUids: referenced.size,
    liveAuthUids: authComplete ? live.size : null,
    authComplete,
    authError,
    departedCount: decision.departed.length,
    deferredCount: decision.deferred.length,
    aborted: decision.abort,
    abortReason: decision.reason,
    scanTruncated: truncated,
    scanned: {
      alertDecisions: scanStats.alertDecisions.scanned,
      inviteCodes: scanStats.inviteCodes.scanned
    },
    purge,
    durationMs: Date.now() - startedAt
  };
  // Counts and opaque uids only — no names, places, tokens or contact details.
  logger.log('[reconcile] ' + JSON.stringify(summary));
  return summary;
}
