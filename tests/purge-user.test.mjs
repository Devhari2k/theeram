// Theeram — privileged cleanup for a deleted user.
// Run with: npm run test:purge
//
// The pure planners run in isolation; the sweeps run against the Firestore
// emulator with the Admin SDK, which is exactly how the Cloud Function runs.
// No Auth account is created or deleted here — the trigger is a thin wrapper
// and the work it delegates to is what needs proving.

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

import {
  planDecisionCleanup, planInviteCleanup, toUpdateArgs,
  purgeAlertDecisions, purgeInviteCodes, purgeDeletedUser,
  SCAN_PAGE, WRITE_BATCH
} from '../functions/purge.js';

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
const PROJECT = 'demo-theeram-purge';

let app, db;
before(() => { app = initializeApp({ projectId: PROJECT }, 'purge-tests'); db = getFirestore(app); });
after(async () => { await deleteApp(app); });

const GONE = 'uid-gone';
const KEEP = 'uid-keep';
const silent = { log() {}, warn() {}, error() {} };

async function wipe() {
  for (const c of ['alertDecisions', 'inviteCodes']) {
    const s = await db.collection(c).get();
    await Promise.all(s.docs.map(d => d.ref.delete()));
  }
}
beforeEach(wipe);

const decision = (id, over = {}) => db.collection('alertDecisions').doc(id).set({
  locationId: 'loc1', familyId: 'f1', kind: 'first', level: 'High', band: 'high',
  episodeId: 1, decidedAt: '2026-09-01T00:00:00.000Z', delivered: false, ...over
});
const read = (c, id) => db.collection(c).doc(id).get().then(d => d.data());

// ---------------------------------------------------------------------------
describe('planDecisionCleanup — pure', () => {
  test('a document that never mentioned the user yields nothing to do', () => {
    assert.deepEqual(planDecisionCleanup({ recipients: { [KEEP]: { delivered: true } } }, GONE), []);
    assert.deepEqual(planDecisionCleanup({}, GONE), []);
    assert.deepEqual(planDecisionCleanup(null, GONE), []);
  });

  test('a recipients entry is removed by field path, not by rewriting the map', () => {
    const ops = planDecisionCleanup({ recipients: { [GONE]: { delivered: false } } }, GONE);
    assert.deepEqual(ops, [{ op: 'deleteField', path: ['recipients', GONE] }]);
  });

  test('a delivered entry is removed just the same', () => {
    // Deletion is not conditional on delivery state — the uid goes either way.
    const ops = planDecisionCleanup({ recipients: { [GONE]: { delivered: true } } }, GONE);
    assert.equal(ops.length, 1);
  });

  test('undeliveredTo membership is removed', () => {
    const ops = planDecisionCleanup({ undeliveredTo: [KEEP, GONE] }, GONE);
    assert.deepEqual(ops, [{ op: 'arrayRemove', path: ['undeliveredTo'], value: GONE }]);
  });

  test('an undeliveredTo without the user is left alone', () => {
    assert.deepEqual(planDecisionCleanup({ undeliveredTo: [KEEP] }, GONE), []);
  });

  test('a synthetic test decision targeting the user is cleared', () => {
    const ops = planDecisionCleanup({ syntheticTargetUid: GONE }, GONE);
    assert.deepEqual(ops, [{ op: 'setNull', path: ['syntheticTargetUid'] }]);
  });

  test('all three at once', () => {
    const ops = planDecisionCleanup({
      recipients: { [GONE]: {}, [KEEP]: {} }, undeliveredTo: [GONE], syntheticTargetUid: GONE
    }, GONE);
    assert.equal(ops.length, 3);
  });
});

// ---------------------------------------------------------------------------
describe('planInviteCleanup — pure', () => {
  test('usedBy and createdBy are both cleared', () => {
    const ops = planInviteCleanup({ usedBy: GONE, createdBy: GONE, used: true }, GONE);
    assert.deepEqual(ops.map(o => o.path[0]).sort(), ['createdBy', 'usedBy']);
  });

  test('`used` is never reset — that would resurrect a live invite', () => {
    const ops = planInviteCleanup({ usedBy: GONE, used: true }, GONE);
    assert.ok(!ops.some(o => o.path[0] === 'used'));
  });

  test('another user\'s code is untouched', () => {
    assert.deepEqual(planInviteCleanup({ usedBy: KEEP, createdBy: KEEP }, GONE), []);
  });
});

// ---------------------------------------------------------------------------
describe('toUpdateArgs', () => {
  test('emits path/value pairs for update()\'s varargs form', () => {
    const args = toUpdateArgs([{ op: 'setNull', path: ['usedBy'] }]);
    assert.equal(args.length, 2);
    assert.equal(args[1], null);
  });

  test('a uid is a literal FieldPath segment, so it cannot escape', () => {
    // A dotted uid must address recipients -> "a.b", never recipients -> a -> b.
    const [path] = toUpdateArgs([{ op: 'deleteField', path: ['recipients', 'a.b'] }]);
    assert.equal(path.toString(), 'recipients.`a.b`');
  });

  test('an unknown op is refused rather than silently skipped', () => {
    assert.throws(() => toUpdateArgs([{ op: 'nope', path: ['x'] }]), /unknown op/);
  });
});

// ---------------------------------------------------------------------------
describe('purgeAlertDecisions — emulator', () => {
  test('removes only the departed user from the ledger', async () => {
    await decision('d1', {
      recipients: { [GONE]: { delivered: true, attempts: 1 }, [KEEP]: { delivered: true, attempts: 1 } },
      undeliveredTo: [GONE, KEEP]
    });
    const s = await purgeAlertDecisions(db, GONE, { logger: silent });
    assert.equal(s.matched, 1);

    const d = await read('alertDecisions', 'd1');
    assert.equal(d.recipients[GONE], undefined, 'the departed uid is gone');
    assert.ok(d.recipients[KEEP], 'the other member survives');
    assert.deepEqual(d.undeliveredTo, [KEEP]);
    assert.equal(d.delivered, false, 'delivery state is not disturbed');
    assert.equal(d.locationId, 'loc1', 'the rest of the decision is intact');
  });

  test('documents that never mentioned the user are not written at all', async () => {
    await decision('d1', { recipients: { [KEEP]: { delivered: true } } });
    const s = await purgeAlertDecisions(db, GONE, { logger: silent });
    assert.equal(s.scanned, 1);
    assert.equal(s.matched, 0);
    assert.equal(s.documentsUpdated, 0);
    assert.equal(s.batches, 0, 'no batch is committed when nothing matches');
  });

  test('IDEMPOTENT: a second run finds nothing and writes nothing', async () => {
    await decision('d1', { recipients: { [GONE]: {} }, undeliveredTo: [GONE], syntheticTargetUid: GONE });
    const first = await purgeAlertDecisions(db, GONE, { logger: silent });
    assert.equal(first.matched, 1);

    const before = await read('alertDecisions', 'd1');
    const second = await purgeAlertDecisions(db, GONE, { logger: silent });
    assert.equal(second.matched, 0);
    assert.equal(second.documentsUpdated, 0);
    assert.deepEqual(await read('alertDecisions', 'd1'), before, 'byte-identical after a re-run');
  });

  test('RETRY-SAFE: re-running over a partially cleaned set converges', async () => {
    await decision('clean', { recipients: { [KEEP]: {} } });
    await decision('dirty', { recipients: { [GONE]: {}, [KEEP]: {} } });
    await purgeAlertDecisions(db, GONE, { logger: silent });   // pretend this run died here
    await decision('late', { recipients: { [GONE]: {} } });    // written after the crash
    const s = await purgeAlertDecisions(db, GONE, { logger: silent });
    assert.equal(s.matched, 1, 'only the newly dirty document');
    for (const id of ['clean', 'dirty', 'late']) {
      const d = await read('alertDecisions', id);
      assert.equal(d.recipients[GONE], undefined, id);
    }
  });

  test('BATCHED: paginates past the read page and commits in batches', async () => {
    // One more than a read page, so the scan must use its cursor, and enough
    // matches to exercise the flush path.
    const n = SCAN_PAGE + 25;
    for (let i = 0; i < n; i += 1) {
      await decision(`d${String(i).padStart(4, '0')}`, { recipients: { [GONE]: {} } });
    }
    const s = await purgeAlertDecisions(db, GONE, { logger: silent });
    assert.equal(s.scanned, n, 'every document was seen across pages');
    assert.equal(s.matched, n);
    assert.equal(s.documentsUpdated, n);
    assert.ok(s.batches >= Math.ceil(n / WRITE_BATCH));

    const spot = await read('alertDecisions', 'd0000');
    assert.equal(spot.recipients[GONE], undefined);
    const last = await read('alertDecisions', `d${String(n - 1).padStart(4, '0')}`);
    assert.equal(last.recipients[GONE], undefined, 'the final page was processed too');
  });

  test('an empty collection is a no-op', async () => {
    const s = await purgeAlertDecisions(db, GONE, { logger: silent });
    assert.deepEqual([s.scanned, s.matched, s.documentsUpdated], [0, 0, 0]);
  });
});

// ---------------------------------------------------------------------------
describe('purgeInviteCodes — emulator', () => {
  const invite = (id, over) => db.collection('inviteCodes').doc(id).set({
    familyId: 'f1', familyName: 'Fam', code: id, used: true,
    createdBy: KEEP, usedBy: KEEP, ...over
  });

  test('clears usedBy but leaves the code spent', async () => {
    await invite('CODE01', { usedBy: GONE });
    const s = await purgeInviteCodes(db, GONE);
    assert.equal(s.matched, 1);
    const d = await read('inviteCodes', 'CODE01');
    assert.equal(d.usedBy, null);
    assert.equal(d.used, true, 'a spent code must not become redeemable again');
    assert.equal(d.createdBy, KEEP, 'the other user is untouched');
  });

  test('clears createdBy too', async () => {
    await invite('CODE02', { createdBy: GONE });
    await purgeInviteCodes(db, GONE);
    const d = await read('inviteCodes', 'CODE02');
    assert.equal(d.createdBy, null);
    assert.equal(d.usedBy, KEEP);
  });

  test('a code naming the user in both fields is updated once', async () => {
    await invite('CODE03', { createdBy: GONE, usedBy: GONE });
    const s = await purgeInviteCodes(db, GONE);
    assert.equal(s.matched, 1, 'deduplicated across the two queries');
    const d = await read('inviteCodes', 'CODE03');
    assert.equal(d.createdBy, null);
    assert.equal(d.usedBy, null);
  });

  test('other users\' codes are never touched', async () => {
    await invite('CODE04');
    await purgeInviteCodes(db, GONE);
    const d = await read('inviteCodes', 'CODE04');
    assert.equal(d.usedBy, KEEP);
    assert.equal(d.createdBy, KEEP);
  });

  test('IDEMPOTENT: a second run matches nothing', async () => {
    await invite('CODE05', { usedBy: GONE, createdBy: GONE });
    await purgeInviteCodes(db, GONE);
    const s = await purgeInviteCodes(db, GONE);
    assert.equal(s.matched, 0);
    assert.equal(s.documentsUpdated, 0);
  });
});

// ---------------------------------------------------------------------------
describe('purgeDeletedUser — both collections', () => {
  test('sweeps everything the client could not reach, and nothing else', async () => {
    await decision('d1', { recipients: { [GONE]: {}, [KEEP]: {} }, undeliveredTo: [GONE] });
    await decision('d2', { recipients: { [KEEP]: {} } });
    await db.collection('inviteCodes').doc('C1').set({
      familyId: 'f1', code: 'C1', used: true, usedBy: GONE, createdBy: KEEP
    });

    const out = await purgeDeletedUser(db, GONE, { logger: silent });
    assert.equal(out.uid, GONE);
    assert.equal(out.alertDecisions.matched, 1);
    assert.equal(out.inviteCodes.matched, 1);

    assert.equal((await read('alertDecisions', 'd1')).recipients[GONE], undefined);
    assert.ok((await read('alertDecisions', 'd2')).recipients[KEEP]);
    assert.equal((await read('inviteCodes', 'C1')).usedBy, null);
  });

  test('refuses to run without a uid rather than sweeping blindly', async () => {
    await assert.rejects(() => purgeDeletedUser(db, '', { logger: silent }), /uid is required/);
    await assert.rejects(() => purgeDeletedUser(db, null, { logger: silent }), /uid is required/);
  });

  test('IDEMPOTENT end to end', async () => {
    await decision('d1', { recipients: { [GONE]: {} } });
    await purgeDeletedUser(db, GONE, { logger: silent });
    const out = await purgeDeletedUser(db, GONE, { logger: silent });
    assert.equal(out.alertDecisions.matched, 0);
    assert.equal(out.inviteCodes.matched, 0);
  });
});
