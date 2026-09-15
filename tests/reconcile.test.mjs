// Theeram — account-deletion reconciler.
// Run with: npm run test:reconcile
//
// Runs against BOTH emulators: real Auth accounts are created and deleted, and
// the reconciler enumerates them with listUsers() exactly as it does in
// production. The pure decision logic is exercised directly, and Auth
// pagination uses a scripted fake so the loop can be proven without creating a
// thousand accounts.

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

import {
  uidsInDecision, uidsInInvite, decideDeparted, discoverReferencedUids,
  listAllAuthUids, purgeDeparted, reconcileUsers,
  MAX_DEPARTED_PER_RUN
} from '../monitor/reconcile.js';
import { SCAN_PAGE } from '../monitor/purge.js';

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';
const PROJECT = 'demo-theeram-reconcile';

let app, db, auth;
before(() => {
  app = initializeApp({ projectId: PROJECT }, 'reconcile-tests');
  db = getFirestore(app);
  auth = getAuth(app);
});
after(async () => { await deleteApp(app); });

const silent = { log() {}, warn() {}, error() {} };
const read = (c, id) => db.collection(c).doc(id).get().then(d => d.data());

async function wipeFirestore() {
  for (const c of ['alertDecisions', 'inviteCodes']) {
    const s = await db.collection(c).get();
    await Promise.all(s.docs.map(d => d.ref.delete()));
  }
}
async function wipeAuth() {
  const res = await auth.listUsers(1000);
  if (res.users.length) await auth.deleteUsers(res.users.map(u => u.uid));
}
beforeEach(async () => { await wipeFirestore(); await wipeAuth(); });

/** A real Auth account; returns its uid. */
let seq = 0;
async function makeUser() {
  const u = await auth.createUser({ email: `u${++seq}-${Date.now()}@example.test`, password: 'passw0rd!' });
  return u.uid;
}

const decision = (id, over = {}) => db.collection('alertDecisions').doc(id).set({
  locationId: 'loc1', familyId: 'f1', kind: 'first', level: 'High', band: 'high',
  episodeId: 1, decidedAt: '2026-09-01T00:00:00.000Z', delivered: false, ...over
});
const invite = (id, over = {}) => db.collection('inviteCodes').doc(id).set({
  familyId: 'f1', familyName: 'Fam', code: id, used: true, usedBy: null, createdBy: null, ...over
});

// ---------------------------------------------------------------------------
describe('candidate discovery — pure extraction', () => {
  test('every uid-bearing field of a decision is found', () => {
    const uids = uidsInDecision({
      recipients: { a: {}, b: {} }, undeliveredTo: ['b', 'c'], syntheticTargetUid: 'd'
    });
    assert.deepEqual([...uids].sort(), ['a', 'b', 'c', 'd']);
  });

  test('a decision mentioning nobody yields nothing', () => {
    assert.equal(uidsInDecision({ delivered: true }).size, 0);
    assert.equal(uidsInDecision(null).size, 0);
  });

  test('malformed entries are ignored rather than becoming candidates', () => {
    const uids = uidsInDecision({ undeliveredTo: [null, '', 42, 'ok'], syntheticTargetUid: null });
    assert.deepEqual([...uids], ['ok']);
  });

  test('both invite fields are found', () => {
    assert.deepEqual([...uidsInInvite({ usedBy: 'a', createdBy: 'b' })].sort(), ['a', 'b']);
    assert.equal(uidsInInvite({ usedBy: null, createdBy: null }).size, 0);
  });
});

// ---------------------------------------------------------------------------
describe('reconciliation decision — pure', () => {
  const live = new Set(['live1', 'live2']);

  test('17: a referenced uid absent from Auth is eligible', () => {
    const d = decideDeparted({ referenced: new Set(['live1', 'gone1']), live, authComplete: true });
    assert.deepEqual(d.departed, ['gone1']);
    assert.equal(d.abort, false);
  });

  test('16: a uid still present in Auth is NEVER treated as departed', () => {
    const d = decideDeparted({ referenced: new Set(['live1', 'live2']), live, authComplete: true });
    assert.deepEqual(d.departed, []);
  });

  test('15: an incomplete Auth enumeration aborts and purges nothing', () => {
    const d = decideDeparted({ referenced: new Set(['live1', 'gone']), live: new Set(), authComplete: false });
    assert.equal(d.abort, true);
    assert.equal(d.reason, 'auth-enumeration-incomplete');
    assert.deepEqual(d.departed, [], 'not one uid is eligible');
  });

  test('15: an empty live set alongside references aborts — that smells like a failure', () => {
    const d = decideDeparted({ referenced: new Set(['a', 'b']), live: new Set(), authComplete: true });
    assert.equal(d.abort, true);
    assert.equal(d.reason, 'auth-returned-no-users');
    assert.deepEqual(d.departed, []);
  });

  test('an empty live set with NO references is fine, not an abort', () => {
    const d = decideDeparted({ referenced: new Set(), live: new Set(), authComplete: true });
    assert.equal(d.abort, false);
    assert.deepEqual(d.departed, []);
  });

  test('work is bounded per run, with the remainder deferred not dropped', () => {
    const referenced = new Set(Array.from({ length: 12 }, (_, i) => `gone${i}`));
    const d = decideDeparted({ referenced, live: new Set(['x']), authComplete: true, max: 5 });
    assert.equal(d.departed.length, 5);
    assert.equal(d.deferred.length, 7);
    assert.equal(new Set([...d.departed, ...d.deferred]).size, 12, 'nothing is lost');
  });

  test('the default bound is the exported constant', () => {
    assert.equal(MAX_DEPARTED_PER_RUN, 500);
  });
});

// ---------------------------------------------------------------------------
describe('Auth enumeration', () => {
  test('a real Auth account is enumerated', async () => {
    const uid = await makeUser();
    const live = await listAllAuthUids(auth, { logger: silent });
    assert.ok(live.has(uid));
  });

  test('a deleted account is absent from the live set', async () => {
    const uid = await makeUser();
    await auth.deleteUser(uid);
    const live = await listAllAuthUids(auth, { logger: silent });
    assert.equal(live.has(uid), false);
  });

  test('pagination follows every page token', async () => {
    // A scripted fake rather than 1000 real accounts: what needs proving is
    // that the loop keeps going while pageToken is set.
    const pages = [
      { users: [{ uid: 'a' }, { uid: 'b' }], pageToken: 't1' },
      { users: [{ uid: 'c' }], pageToken: 't2' },
      { users: [{ uid: 'd' }], pageToken: undefined }
    ];
    const seen = [];
    const fake = { listUsers: async (_n, token) => { seen.push(token); return pages.shift(); } };
    const live = await listAllAuthUids(fake, { logger: silent });
    assert.deepEqual([...live].sort(), ['a', 'b', 'c', 'd']);
    assert.deepEqual(seen, [undefined, 't1', 't2'], 'each token was followed exactly once');
  });

  test('a failing page throws rather than returning a partial set', async () => {
    const fake = {
      listUsers: async (_n, token) => {
        if (!token) return { users: [{ uid: 'a' }], pageToken: 't1' };
        throw new Error('network');
      }
    };
    await assert.rejects(() => listAllAuthUids(fake, { logger: silent }), /network/);
  });
});

// ---------------------------------------------------------------------------
describe('reconcileUsers — end to end against both emulators', () => {
  test('1 + 2: a live user referenced anywhere is NOT purged', async () => {
    const liveUid = await makeUser();
    await decision('d1', { recipients: { [liveUid]: { delivered: true } }, undeliveredTo: [liveUid] });
    await invite('C1', { usedBy: liveUid, createdBy: liveUid });

    const s = await reconcileUsers({ db, auth, dryRun: false, logger: silent });
    assert.equal(s.departedCount, 0);

    const d = await read('alertDecisions', 'd1');
    assert.ok(d.recipients[liveUid], 'live recipient survives');
    assert.deepEqual(d.undeliveredTo, [liveUid]);
    const c = await read('inviteCodes', 'C1');
    assert.equal(c.usedBy, liveUid);
    assert.equal(c.createdBy, liveUid);
  });

  test('3 + 4 + 5: a departed uid is cleaned from both collections', async () => {
    const goneUid = await makeUser();
    const liveUid = await makeUser();
    await decision('d1', {
      recipients: { [goneUid]: { delivered: false }, [liveUid]: { delivered: true } },
      undeliveredTo: [goneUid, liveUid],
      syntheticTargetUid: goneUid
    });
    await invite('C1', { usedBy: goneUid, createdBy: goneUid });
    await auth.deleteUser(goneUid);

    const s = await reconcileUsers({ db, auth, dryRun: false, logger: silent });
    assert.deepEqual(s.departedCount, 1);

    // 6 + 7 + 9: the other user and the delivery state are untouched.
    const d = await read('alertDecisions', 'd1');
    assert.equal(d.recipients[goneUid], undefined);
    assert.ok(d.recipients[liveUid], 'other recipient survives');
    assert.deepEqual(d.undeliveredTo, [liveUid]);
    assert.equal(d.syntheticTargetUid, null);
    assert.equal(d.delivered, false, 'delivery state unchanged');
    assert.equal(d.locationId, 'loc1');

    // 8: the code stays spent.
    const c = await read('inviteCodes', 'C1');
    assert.equal(c.usedBy, null);
    assert.equal(c.createdBy, null);
    assert.equal(c.used, true, 'used is never reset');
    assert.equal(c.familyId, 'f1');
  });

  test('7: another user\'s invite is never touched', async () => {
    const goneUid = await makeUser();
    const liveUid = await makeUser();
    await invite('MINE', { usedBy: goneUid });
    await invite('THEIRS', { usedBy: liveUid, createdBy: liveUid });
    await auth.deleteUser(goneUid);

    await reconcileUsers({ db, auth, dryRun: false, logger: silent });
    const theirs = await read('inviteCodes', 'THEIRS');
    assert.equal(theirs.usedBy, liveUid);
    assert.equal(theirs.createdBy, liveUid);
  });

  test('10: running twice produces the same final state', async () => {
    const goneUid = await makeUser();
    await decision('d1', { recipients: { [goneUid]: {} }, undeliveredTo: [goneUid] });
    await invite('C1', { usedBy: goneUid });
    await auth.deleteUser(goneUid);

    await reconcileUsers({ db, auth, dryRun: false, logger: silent });
    const afterFirst = { d: await read('alertDecisions', 'd1'), c: await read('inviteCodes', 'C1') };

    const second = await reconcileUsers({ db, auth, dryRun: false, logger: silent });
    assert.equal(second.departedCount, 0, 'nothing is referenced by a departed uid any more');
    assert.deepEqual(await read('alertDecisions', 'd1'), afterFirst.d);
    assert.deepEqual(await read('inviteCodes', 'C1'), afterFirst.c);
  });

  test('11: partial failure followed by retry converges', async () => {
    await makeUser();                      // a live bystander, as production always has
    const goneUid = await makeUser();
    await decision('early', { recipients: { [goneUid]: {} } });
    await auth.deleteUser(goneUid);

    await reconcileUsers({ db, auth, dryRun: false, logger: silent });   // "crashes" after this
    await decision('late', { recipients: { [goneUid]: {} } });           // written afterwards

    const s = await reconcileUsers({ db, auth, dryRun: false, logger: silent });
    assert.equal(s.departedCount, 1, 'the uid is referenced again, so it is eligible again');
    for (const id of ['early', 'late']) {
      assert.equal((await read('alertDecisions', id)).recipients[goneUid], undefined, id);
    }
  });

  test('13: a dry run performs no writes', async () => {
    await makeUser();                      // a live bystander
    const goneUid = await makeUser();
    await decision('d1', { recipients: { [goneUid]: { delivered: true } }, undeliveredTo: [goneUid] });
    await invite('C1', { usedBy: goneUid });
    await auth.deleteUser(goneUid);

    const s = await reconcileUsers({ db, auth, dryRun: true, logger: silent });
    assert.equal(s.dryRun, true);
    assert.equal(s.departedCount, 1, 'it still reports what it would do');
    assert.ok(s.purge.alertDecisions.documentsUpdated >= 1);
    assert.equal(s.purge.alertDecisions.batches, 0, 'no batch was committed');

    assert.ok((await read('alertDecisions', 'd1')).recipients[goneUid], 'untouched');
    assert.deepEqual((await read('alertDecisions', 'd1')).undeliveredTo, [goneUid]);
    assert.equal((await read('inviteCodes', 'C1')).usedBy, goneUid);
  });

  test('the empty-live-set guard fires on real data, not just in unit tests', async () => {
    // Deleting the last remaining account leaves live empty. That is
    // indistinguishable from a credentials failure, so the run refuses rather
    // than treating every referenced uid as departed.
    const goneUid = await makeUser();
    await decision('d1', { recipients: { [goneUid]: {} } });
    await auth.deleteUser(goneUid);
    const s = await reconcileUsers({ db, auth, dryRun: false, logger: silent });
    assert.equal(s.aborted, true);
    assert.equal(s.abortReason, 'auth-returned-no-users');
    assert.ok((await read('alertDecisions', 'd1')).recipients[goneUid], 'data intact');
  });

  test('14: an empty run succeeds and does nothing', async () => {
    const s = await reconcileUsers({ db, auth, dryRun: false, logger: silent });
    assert.equal(s.aborted, false);
    assert.equal(s.referencedUids, 0);
    assert.equal(s.departedCount, 0);
    assert.equal(s.purge, null);
  });

  test('15: an Auth failure aborts before any write', async () => {
    const goneUid = 'uid-never-existed';
    await decision('d1', { recipients: { [goneUid]: { delivered: true } } });
    const broken = { listUsers: async () => { throw new Error('permission denied'); } };

    const s = await reconcileUsers({ db, auth: broken, dryRun: false, logger: silent });
    assert.equal(s.aborted, true);
    assert.equal(s.abortReason, 'auth-enumeration-incomplete');
    assert.equal(s.authComplete, false);
    assert.equal(s.purge, null, 'the purge never ran');
    assert.ok((await read('alertDecisions', 'd1')).recipients[goneUid], 'data intact');
  });

  test('15: missing db or auth is refused rather than guessed at', async () => {
    await assert.rejects(() => reconcileUsers({ auth }), /db is required/);
    await assert.rejects(() => reconcileUsers({ db }), /auth is required/);
  });

  test('12: discovery and purge page past the scan boundary', async () => {
    await makeUser();                      // a live bystander
    const goneUid = await makeUser();
    const n = SCAN_PAGE + 25;
    const writes = [];
    for (let i = 0; i < n; i++) {
      writes.push(decision(`d${String(i).padStart(4, '0')}`, { recipients: { [goneUid]: {} } }));
    }
    await Promise.all(writes);
    await auth.deleteUser(goneUid);

    const s = await reconcileUsers({ db, auth, dryRun: false, logger: silent });
    assert.equal(s.scanned.alertDecisions, n, 'discovery crossed the page boundary');
    assert.equal(s.purge.alertDecisions.scanned, n, 'so did the purge pass');
    assert.equal(s.purge.alertDecisions.documentsUpdated, n);
    assert.equal((await read('alertDecisions', 'd0000')).recipients[goneUid], undefined);
    assert.equal((await read('alertDecisions', `d${String(n - 1).padStart(4, '0')}`)).recipients[goneUid], undefined);
  });
});

// ---------------------------------------------------------------------------
describe('18: the reconciler never blind-deletes', () => {
  const SRC = readFileSync(new URL('../monitor/reconcile.js', import.meta.url), 'utf8');

  test('it deletes no document and no collection, only named fields', () => {
    const code = SRC.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
    for (const forbidden of ['.delete()', 'deleteDoc', 'recursiveDelete', 'batch.delete', 'bulkWriter']) {
      assert.ok(!code.includes(forbidden), `reconcile.js must not call ${forbidden}`);
    }
    assert.ok(code.includes('batch.update('), 'field-level updates only');
  });

  test('purging an empty departed set writes nothing at all', async () => {
    await decision('d1', { recipients: { someone: {} } });
    const stats = await purgeDeparted(db, [], { dryRun: false, logger: silent });
    assert.equal(stats.alertDecisions.documentsUpdated, 0);
    assert.ok((await read('alertDecisions', 'd1')).recipients.someone, 'untouched');
  });

  test('discovery is read-only', async () => {
    await decision('d1', { recipients: { a: {} } });
    const before = await read('alertDecisions', 'd1');
    const { referenced } = await discoverReferencedUids(db);
    assert.deepEqual([...referenced], ['a']);
    assert.deepEqual(await read('alertDecisions', 'd1'), before);
  });
});
