// Theeram — FCM delivery against the Firestore emulator.
// Run with: npm run test:monitor:emulator
//
// Messaging is always a fake. No real FCM object is ever constructed and no
// notification is ever sent.

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { notifyUndelivered, CLAIM_LEASE_MS } from '../monitor/notify.js';

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
const PROJECT = 'demo-theeram-notify';

let app, db;
before(() => { app = initializeApp({ projectId: PROJECT }, 'notify-tests'); db = getFirestore(app); });
after(async () => { await deleteApp(app); });

const T0 = Date.UTC(2026, 8, 12, 12, 0, 0);
const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);
const silent = { log() {}, warn() {}, error() {} };

/** Fake messaging: records what it was asked to send, returns scripted results. */
function fakeNotifier(script = () => ({ success: true })) {
  const sent = [];
  return {
    sent,
    dryRun: false,
    async sendEach(messages) {
      sent.push(...messages);
      const responses = messages.map((m, i) => script(m, i));
      return {
        successCount: responses.filter(r => r.success).length,
        failureCount: responses.filter(r => !r.success).length,
        responses
      };
    }
  };
}
const fail = (code) => ({ success: false, error: { code } });

async function wipe() {
  for (const c of ['alertDecisions', 'users', 'families']) {
    const s = await db.collection(c).get();
    await Promise.all(s.docs.map(d => d.ref.delete()));
  }
  for (const cg of ['members', 'locations']) {
    const s = await db.collectionGroup(cg).get();
    await Promise.all(s.docs.map(d => d.ref.delete()));
  }
}

async function seed({ decisions = [], members = ['u1'], devices = { u1: [KEY_A] }, profile = {} } = {}) {
  await wipe();
  await db.collection('families').doc('f1').set({ name: 'Fam' });
  for (const uid of members) {
    await db.collection('families').doc('f1').collection('members').doc(uid)
      .set({ uid, role: 'member', name: `Name-${uid}` });
  }
  await db.collection('families').doc('f1').collection('locations').doc('loc1')
    .set({ ownerUid: 'u1', name: 'Kochi', lat: 9.93, lon: 76.27,
           risk: { level: 'High', reason: 'Heavy rainfall recorded.' } });
  for (const [uid, keys] of Object.entries(devices)) {
    const map = {};
    for (const k of keys) map[k] = { token: `tok-${uid}-${k.slice(0, 4)}`, platform: 'android', enabled: true, createdAt: 'x', updatedAt: 'x' };
    await db.collection('users').doc(uid).set({
      name: `Name-${uid}`,
      phone: '+91-555-0100',
      emergencyContact: { name: 'Kin', phone: '+91-555-0101' },
      devices: map,
      ...(profile[uid] || {})
    });
  }
  for (const d of decisions) {
    await db.collection('alertDecisions').doc(d.id).set({
      locationId: 'loc1', familyId: 'f1', kind: 'first', level: 'High',
      band: 'high', episodeId: 1, decidedAt: new Date(T0).toISOString(),
      delivered: false, deliveredAt: null, ...d
    });
  }
}

const readDec = (id) => db.collection('alertDecisions').doc(id).get().then(d => d.data());
const readUser = (uid) => db.collection('users').doc(uid).get().then(d => d.data());
const run = (notifier, over = {}) => notifyUndelivered({
  db, notifier, now: () => (over.at ?? T0), logger: silent, runId: over.runId || 'r1', ...over
});

// ---------------------------------------------------------------------------
describe('delivery', () => {
  test('undelivered decision -> successful send -> delivered=true', async () => {
    await seed({ decisions: [{ id: 'd1' }] });
    const n = fakeNotifier();
    const s = await run(n);

    assert.equal(s.claimed, 1);
    assert.equal(s.sent, 1);
    assert.equal(s.delivered, 1);
    assert.equal(n.sent.length, 1);

    const d = await readDec('d1');
    assert.equal(d.delivered, true);
    assert.ok(d.deliveredAt);
    assert.equal(d.deliveredCount, 1);
    assert.equal(d.claimedAt, null, 'claim released after delivery');
  });

  test('already delivered -> no resend', async () => {
    await seed({ decisions: [{ id: 'd1', delivered: true, deliveredAt: new Date(T0).toISOString() }] });
    const n = fakeNotifier();
    const s = await run(n);
    assert.equal(s.considered, 0, 'delivered decisions are not even queried');
    assert.equal(n.sent.length, 0);
  });

  test('a previously recorded undelivered decision is recovered on a later run', async () => {
    // Simulates a run that recorded the decision then died before sending.
    await seed({ decisions: [{ id: 'd-orphan', decidedAt: new Date(T0 - 3600e3).toISOString() }] });
    const n = fakeNotifier();
    const s = await run(n);
    assert.equal(s.delivered, 1, 'an orphaned decision must not be lost');
    assert.equal((await readDec('d-orphan')).delivered, true);
  });

  test('one consolidated notification per recipient across several decisions', async () => {
    await seed({ decisions: [
      { id: 'd1', locationId: 'loc1' },
      { id: 'd2', locationId: 'loc1', episodeId: 2 },
      { id: 'd3', locationId: 'loc1', episodeId: 3 }
    ]});
    const n = fakeNotifier();
    const s = await run(n);
    assert.equal(s.claimed, 3);
    assert.equal(n.sent.length, 1, 'one device, one message, three decisions');
    assert.equal(s.delivered, 3, 'all three marked delivered by the one send');
  });

  test('multi-device fan-out sends to every enabled device', async () => {
    await seed({ decisions: [{ id: 'd1' }], devices: { u1: [KEY_A, KEY_B] } });
    const n = fakeNotifier();
    const s = await run(n);
    assert.equal(n.sent.length, 2);
    assert.equal(s.devices, 2);
    assert.equal((await readDec('d1')).deliveredCount, 2);
  });

  test('every family member is a recipient', async () => {
    await seed({
      decisions: [{ id: 'd1' }],
      members: ['u1', 'u2'],
      devices: { u1: [KEY_A], u2: [KEY_B] }
    });
    const n = fakeNotifier();
    const s = await run(n);
    assert.equal(s.recipients, 2);
    assert.equal(n.sent.length, 2);
  });

  test('the wire message carries no _meta and no sensitive data', async () => {
    await seed({ decisions: [{ id: 'd1' }] });
    const n = fakeNotifier();
    await run(n);
    const m = n.sent[0];
    assert.equal('_meta' in m, false);
    const s = JSON.stringify(m.data);
    for (const leak of ['9.93', '76.27', '555', 'phone', 'emergencyContact']) {
      assert.equal(s.includes(leak), false, `data leaked ${leak}`);
    }
    assert.match(m.notification.body, /KSDMA \/ NDMA/);
  });
});

// ---------------------------------------------------------------------------
describe('claim lease', () => {
  test('a fresh claim blocks a concurrent second run', async () => {
    await seed({ decisions: [{ id: 'd1', claimedAt: new Date(T0).toISOString(), claimedBy: 'other' }] });
    const n = fakeNotifier();
    const s = await run(n, { at: T0 + 60e3 });
    assert.equal(s.claimed, 0);
    assert.equal(s.skipped, 1);
    assert.equal(n.sent.length, 0, 'must not double-send while another run holds the claim');
  });

  test('an expired lease permits retry', async () => {
    await seed({ decisions: [{ id: 'd1', claimedAt: new Date(T0).toISOString(), claimedBy: 'dead-run' }] });
    const n = fakeNotifier();
    const s = await run(n, { at: T0 + CLAIM_LEASE_MS + 1000 });
    assert.equal(s.claimed, 1);
    assert.equal(s.delivered, 1, 'at-least-once: a dead run must not strand the alert');
  });

  test('two concurrent passes deliver the decision only once', async () => {
    await seed({ decisions: [{ id: 'd1' }] });
    const a = fakeNotifier(), b = fakeNotifier();
    const [ra, rb] = await Promise.all([
      run(a, { runId: 'A' }), run(b, { runId: 'B' })
    ]);
    assert.equal(ra.claimed + rb.claimed, 1, 'exactly one pass may claim it');
    assert.equal(a.sent.length + b.sent.length, 1);
    assert.equal((await readDec('d1')).delivered, true);
  });
});

// ---------------------------------------------------------------------------
describe('failure handling', () => {
  test('total send failure leaves delivered=false for retry', async () => {
    await seed({ decisions: [{ id: 'd1' }] });
    const n = fakeNotifier(() => fail('messaging/internal-error'));
    const s = await run(n);
    assert.equal(s.delivered, 0);
    assert.equal(s.retained, 1);
    const d = await readDec('d1');
    assert.equal(d.delivered, false);
    assert.equal(d.failureCount, 1);
    assert.equal(d.claimedAt, null, 'claim released so the next run retries immediately');
  });

  test('partial success still marks delivered — at least one device accepted', async () => {
    await seed({ decisions: [{ id: 'd1' }], devices: { u1: [KEY_A, KEY_B] } });
    const n = fakeNotifier((m, i) => i === 0 ? { success: true } : fail('messaging/internal-error'));
    const s = await run(n);
    assert.equal(s.delivered, 1);
    const d = await readDec('d1');
    assert.equal(d.delivered, true);
    assert.equal(d.deliveredCount, 1);
    assert.equal(d.failureCount, 1);
  });

  test('a thrown batch error retains the decision rather than crashing', async () => {
    await seed({ decisions: [{ id: 'd1' }] });
    const n = { sent: [], async sendEach() { throw new Error('network down'); } };
    const s = await run(n);
    assert.equal(s.delivered, 0);
    assert.equal(s.retained, 1);
    assert.equal((await readDec('d1')).delivered, false);
  });
});

// ---------------------------------------------------------------------------
describe('invalid-token cleanup', () => {
  test('registration-token-not-registered removes ONLY that device entry', async () => {
    await seed({ decisions: [{ id: 'd1' }], devices: { u1: [KEY_A, KEY_B] } });
    const n = fakeNotifier((m) => m.token.includes(KEY_A.slice(0, 4))
      ? fail('messaging/registration-token-not-registered') : { success: true });
    const s = await run(n);

    assert.equal(s.tokensRemoved, 1);
    const u = await readUser('u1');
    assert.equal(u.devices[KEY_A], undefined, 'the dead token is gone');
    assert.ok(u.devices[KEY_B], 'the sibling device survives');
    // The guard's whole purpose:
    assert.equal(u.phone, '+91-555-0100', 'profile data untouched');
    assert.deepEqual(u.emergencyContact, { name: 'Kin', phone: '+91-555-0101' });
    assert.equal(u.name, 'Name-u1');
  });

  test('invalid-registration-token also removes the entry', async () => {
    await seed({ decisions: [{ id: 'd1' }] });
    const n = fakeNotifier(() => fail('messaging/invalid-registration-token'));
    await run(n);
    assert.equal((await readUser('u1')).devices[KEY_A], undefined);
  });

  test('invalid-argument RETAINS the token', async () => {
    await seed({ decisions: [{ id: 'd1' }] });
    const n = fakeNotifier(() => fail('messaging/invalid-argument'));
    const s = await run(n);
    assert.equal(s.tokensRemoved, 0);
    assert.ok((await readUser('u1')).devices[KEY_A], 'our bug must not cost the user their token');
  });

  test('transient errors retain the token', async () => {
    await seed({ decisions: [{ id: 'd1' }] });
    const n = fakeNotifier(() => fail('messaging/server-unavailable'));
    const s = await run(n);
    assert.equal(s.tokensRemoved, 0);
    assert.ok((await readUser('u1')).devices[KEY_A]);
  });
});

// ---------------------------------------------------------------------------
describe('no recipients / no devices', () => {
  test('a recipient with no devices is a safe no-op and the decision is retried later', async () => {
    await seed({ decisions: [{ id: 'd1' }], devices: {} });
    await db.collection('users').doc('u1').set({ name: 'Name-u1' });   // no devices field
    const n = fakeNotifier();
    const s = await run(n);
    assert.equal(n.sent.length, 0);
    assert.equal(s.sent, 0);
    const d = await readDec('d1');
    assert.equal(d.delivered, false, 'kept for when a device registers');
    assert.equal(d.claimedAt, null, 'claim released, not stranded for the lease');
  });

  test('a family with no members does not crash the pass', async () => {
    await wipe();
    await db.collection('families').doc('f1').set({ name: 'Empty' });
    await db.collection('alertDecisions').doc('d1').set({
      locationId: 'loc1', familyId: 'f1', kind: 'first', level: 'High',
      band: 'high', episodeId: 1, decidedAt: new Date(T0).toISOString(),
      delivered: false, deliveredAt: null
    });
    const n = fakeNotifier();
    const s = await run(n);
    assert.equal(s.sent, 0);
    assert.equal((await readDec('d1')).delivered, false);
  });

  test('a decision with no alertDecisions at all returns an empty summary', async () => {
    await wipe();
    const n = fakeNotifier();
    const s = await run(n);
    assert.equal(s.considered, 0);
    assert.equal(n.sent.length, 0);
  });
});

// ---------------------------------------------------------------------------
describe('all_clear and sustained', () => {
  test('all_clear IS delivered', async () => {
    await seed({ decisions: [{ id: 'd1', kind: 'all_clear', level: 'Low', band: 'normal' }] });
    const n = fakeNotifier();
    const s = await run(n);
    assert.equal(s.delivered, 1);
    assert.match(n.sent[0].notification.title, /Flood risk has passed/);
    assert.match(n.sent[0].notification.body, /KSDMA \/ NDMA/);
  });

  test('sustained reminders ARE delivered', async () => {
    await seed({ decisions: [{ id: 'd1', kind: 'sustained', level: 'Severe', band: 'severe' }] });
    const n = fakeNotifier();
    const s = await run(n);
    assert.equal(s.delivered, 1);
    assert.match(n.sent[0].notification.title, /still at severe/);
  });
});

// ---------------------------------------------------------------------------
describe('dry run', () => {
  test('performs NO writes and constructs no Messaging', async () => {
    await seed({ decisions: [{ id: 'd1' }] });
    let constructed = 0;
    const { createNotifier } = await import('../monitor/notify.js');
    const notifier = createNotifier({
      dryRun: true,
      getMessaging: () => { constructed++; throw new Error('must never be constructed'); },
      logger: silent
    });

    const s = await run(notifier, { dryRun: true });
    assert.equal(constructed, 0);
    assert.equal(s.dryRun, true);

    const d = await readDec('d1');
    assert.equal(d.delivered, false, 'dry run must not mark delivered');
    assert.equal(d.claimedAt, undefined, 'dry run must not claim');
    assert.ok((await readUser('u1')).devices[KEY_A], 'dry run must not remove devices');
  });
});

// ---------------------------------------------------------------------------
// The delivery ledger: at-least-once PER RECIPIENT, not merely per decision.
describe('recipient ledger', () => {
  test('A succeeds, B transiently fails -> decision stays undelivered', async () => {
    await seed({
      decisions: [{ id: 'd1' }],
      members: ['u1', 'u2'],
      devices: { u1: [KEY_A], u2: [KEY_B] }
    });
    const n = fakeNotifier((m) => m.token.startsWith('tok-u1')
      ? { success: true } : fail('messaging/internal-error'));
    const s = await run(n);

    assert.equal(s.delivered, 0, 'one lucky recipient must not speak for the family');
    assert.equal(s.retained, 1);

    const d = await readDec('d1');
    assert.equal(d.delivered, false);
    assert.equal(d.recipients.u1.delivered, true);
    assert.ok(d.recipients.u1.deliveredAt);
    assert.equal(d.recipients.u2.delivered, false);
    assert.equal(d.recipients.u2.lastCode, 'messaging/internal-error');
    assert.equal(d.attempts, 1);
    assert.equal(d.claimedAt, null, 'claim released so the next run retries');
  });

  test('the next run retries ONLY the missed recipient', async () => {
    await seed({
      decisions: [{ id: 'd1' }],
      members: ['u1', 'u2'],
      devices: { u1: [KEY_A], u2: [KEY_B] }
    });
    const first = fakeNotifier((m) => m.token.startsWith('tok-u1')
      ? { success: true } : fail('messaging/internal-error'));
    await run(first);
    assert.equal(first.sent.length, 2, 'first pass tried both');

    const second = fakeNotifier();
    const s = await run(second, { at: T0 + 3600e3, runId: 'r2' });

    assert.equal(second.sent.length, 1, 'only the missed recipient is retried');
    assert.ok(second.sent[0].token.startsWith('tok-u2'), 'and it is B, not A');
    assert.equal(s.delivered, 1);

    const d = await readDec('d1');
    assert.equal(d.delivered, true, 'now everybody has been reached');
    assert.equal(d.recipients.u1.delivered, true);
    assert.equal(d.recipients.u2.delivered, true);
    assert.equal(d.recipients.u1.attempts, 1, 'A was not attempted a second time');
    assert.equal(d.recipients.u2.attempts, 2);
    assert.equal(d.attempts, 2);
    assert.deepEqual(d.undeliveredTo, []);
    assert.equal(d.retiredReason, null);
  });

  test('an already-delivered recipient is never resent, even across many runs', async () => {
    await seed({
      decisions: [{ id: 'd1' }],
      members: ['u1', 'u2'],
      devices: { u1: [KEY_A], u2: [KEY_B] }
    });
    const onlyU1 = (m) => m.token.startsWith('tok-u1') ? { success: true } : fail('messaging/internal-error');
    for (let i = 0; i < 3; i++) {
      const n = fakeNotifier(onlyU1);
      await run(n, { at: T0 + i * 3600e3, runId: `r${i}` });
      if (i > 0) {
        assert.equal(n.sent.length, 1, `pass ${i} must not re-notify A`);
        assert.ok(n.sent[0].token.startsWith('tok-u2'));
      }
    }
    const d = await readDec('d1');
    assert.equal(d.recipients.u1.attempts, 1, 'A attempted exactly once, ever');
  });

  test('one recipient, several devices: one success delivers the person', async () => {
    await seed({ decisions: [{ id: 'd1' }], devices: { u1: [KEY_A, KEY_B] } });
    const n = fakeNotifier((m, i) => i === 0 ? { success: true } : fail('messaging/internal-error'));
    const s = await run(n);

    assert.equal(s.delivered, 1, 'the person was reached; a second device is redundancy');
    const d = await readDec('d1');
    assert.equal(d.delivered, true);
    assert.equal(d.recipients.u1.delivered, true);
  });

  test('invalid token mixed with a valid one across two recipients', async () => {
    await seed({
      decisions: [{ id: 'd1' }],
      members: ['u1', 'u2'],
      devices: { u1: [KEY_A], u2: [KEY_B] }
    });
    const n = fakeNotifier((m) => m.token.startsWith('tok-u1')
      ? { success: true } : fail('messaging/registration-token-not-registered'));
    const s = await run(n);

    assert.equal(s.tokensRemoved, 1);
    const u2 = await readUser('u2');
    assert.equal(u2.devices[KEY_B], undefined, 'the dead token is gone');
    assert.equal(u2.phone, '+91-555-0100', 'the guard kept the profile intact');
    assert.ok((await readUser('u1')).devices[KEY_A], "A's token is untouched");

    const d = await readDec('d1');
    assert.equal(d.delivered, false, 'B was never reached, so work remains');
    assert.equal(d.recipients.u2.lastCode, 'messaging/registration-token-not-registered');
  });

  test('three recipients with mixed outcomes are tracked independently', async () => {
    await seed({
      decisions: [{ id: 'd1' }],
      members: ['u1', 'u2', 'u3'],
      devices: { u1: [KEY_A], u2: [KEY_B], u3: [KEY_A] }
    });
    const n = fakeNotifier((m) => {
      if (m.token.startsWith('tok-u1')) return { success: true };
      if (m.token.startsWith('tok-u2')) return fail('messaging/internal-error');
      return fail('messaging/invalid-argument');
    });
    await run(n);

    const d = await readDec('d1');
    assert.equal(d.recipients.u1.delivered, true);
    assert.equal(d.recipients.u2.delivered, false);
    assert.equal(d.recipients.u3.delivered, false);
    assert.equal(d.recipients.u3.lastCode, 'messaging/invalid-argument');
    assert.equal(d.delivered, false);
  });

  test('a recipient with zero devices is recorded, not silently skipped', async () => {
    await seed({
      decisions: [{ id: 'd1' }],
      members: ['u1', 'u2'],
      devices: { u1: [KEY_A] }
    });
    await db.collection('users').doc('u2').set({ name: 'Name-u2' });   // no devices
    const n = fakeNotifier();
    const s = await run(n);

    assert.equal(n.sent.length, 1);
    const d = await readDec('d1');
    assert.equal(d.recipients.u1.delivered, true);
    assert.equal(d.recipients.u2.delivered, false);
    assert.equal(d.recipients.u2.lastCode, 'no-devices', 'the reason is recorded for forensics');
    assert.equal(d.delivered, false, 'u2 has not been reached');
    assert.equal(s.retained, 1);
  });

  test('a legacy decision with no recipients map is handled and upgraded', async () => {
    await wipe();
    await db.collection('families').doc('f1').set({ name: 'Fam' });
    await db.collection('families').doc('f1').collection('members').doc('u1').set({ uid: 'u1' });
    await db.collection('users').doc('u1').set({
      name: 'Name-u1',
      devices: { [KEY_A]: { token: 'tok-u1-aaaa', platform: 'android', enabled: true } }
    });
    // Exactly the shape run.js wrote before the ledger existed.
    await db.collection('alertDecisions').doc('legacy').set({
      locationId: 'loc1', familyId: 'f1', kind: 'first', level: 'High',
      band: 'high', episodeId: 1, decidedAt: new Date(T0).toISOString(),
      delivered: false, deliveredAt: null
    });
    const n = fakeNotifier();
    const s = await run(n);

    assert.equal(s.delivered, 1);
    const d = await readDec('legacy');
    assert.equal(d.delivered, true);
    assert.equal(d.recipients.u1.delivered, true);
    assert.equal(d.attempts, 1, 'attempts starts from zero for a legacy decision');
  });
});

// ---------------------------------------------------------------------------
describe('retirement', () => {
  test('retires after the attempt cap, recording who never got it', async () => {
    await seed({
      decisions: [{ id: 'd1' }],
      members: ['u1', 'u2'],
      devices: { u1: [KEY_A], u2: [KEY_B] }
    });
    const onlyU1 = (m) => m.token.startsWith('tok-u1') ? { success: true } : fail('messaging/internal-error');

    let s;
    for (let i = 0; i < 3; i++) {
      s = await run(fakeNotifier(onlyU1), { at: T0 + i * 60e3, runId: `r${i}`, maxAttempts: 3 });
    }

    assert.equal(s.retired, 1);
    const d = await readDec('d1');
    assert.equal(d.delivered, true, 'retired decisions leave the undelivered queue');
    assert.equal(d.retiredReason, 'exhausted');
    assert.deepEqual(d.undeliveredTo, ['u2'], 'exactly who was never reached');
    assert.ok(d.retiredAt);
    assert.equal(d.attempts, 3);
    assert.equal(d.recipients.u1.delivered, true, 'A was still genuinely delivered');
  });

  test('retires a decision that has gone stale, whatever the attempt count', async () => {
    await seed({ decisions: [{ id: 'd1' }] });
    const n = fakeNotifier(() => fail('messaging/internal-error'));
    const s = await run(n, { at: T0 + 13 * 3600e3 });

    assert.equal(s.retired, 1);
    const d = await readDec('d1');
    assert.equal(d.delivered, true);
    assert.equal(d.retiredReason, 'stale');
    assert.deepEqual(d.undeliveredTo, ['u1']);
  });

  test('a family with no members eventually retires instead of accumulating forever', async () => {
    await wipe();
    await db.collection('families').doc('f1').set({ name: 'Empty' });
    await db.collection('alertDecisions').doc('d1').set({
      locationId: 'loc1', familyId: 'f1', kind: 'first', level: 'High',
      band: 'high', episodeId: 1, decidedAt: new Date(T0).toISOString(),
      delivered: false, deliveredAt: null
    });
    let s;
    for (let i = 0; i < 2; i++) {
      s = await run(fakeNotifier(), { at: T0 + i * 60e3, runId: `r${i}`, maxAttempts: 2 });
    }
    assert.equal(s.retired, 1);
    const d = await readDec('d1');
    assert.equal(d.delivered, true);
    assert.equal(d.retiredReason, 'exhausted');
    assert.deepEqual(d.undeliveredTo, [], 'there was nobody to reach');
  });

  test('a decision still within budget is NOT retired', async () => {
    await seed({ decisions: [{ id: 'd1' }] });
    const s = await run(fakeNotifier(() => fail('messaging/internal-error')));
    assert.equal(s.retired, 0);
    assert.equal(s.retained, 1);
    const d = await readDec('d1');
    assert.equal(d.delivered, false);
    assert.equal(d.retiredReason, undefined);
  });
});

// ---------------------------------------------------------------------------
// restrictToUid: the safety valve the synthetic FCM test relies on.
describe('restrictToUid', () => {
  test('confines delivery to one member of a multi-member family', async () => {
    await seed({
      decisions: [{ id: 'd1' }],
      members: ['u1', 'u2', 'u3'],
      devices: { u1: [KEY_A], u2: [KEY_B], u3: [KEY_A] }
    });
    const n = fakeNotifier();
    const s = await run(n, { restrictToUid: 'u2' });

    assert.equal(n.sent.length, 1, 'exactly one message left the building');
    assert.ok(n.sent[0].token.startsWith('tok-u2'), 'and it went to the named uid');
    assert.equal(s.recipients, 1);

    const d = await readDec('d1');
    assert.equal(d.recipients.u2.delivered, true);
    assert.equal(d.recipients.u1, undefined, 'untargeted members are not even ledgered');
    assert.equal(d.recipients.u3, undefined);
  });

  test('an unset restrictToUid leaves production fan-out untouched', async () => {
    await seed({
      decisions: [{ id: 'd1' }],
      members: ['u1', 'u2'],
      devices: { u1: [KEY_A], u2: [KEY_B] }
    });
    const n = fakeNotifier();
    await run(n);
    assert.equal(n.sent.length, 2, 'normal runs still reach the whole family');
  });

  test('a uid that is not a member reaches nobody', async () => {
    await seed({ decisions: [{ id: 'd1' }], members: ['u1'], devices: { u1: [KEY_A] } });
    const n = fakeNotifier();
    const s = await run(n, { restrictToUid: 'not-a-member' });
    assert.equal(n.sent.length, 0, 'fails closed rather than notifying somebody else');
    assert.equal(s.sent, 0);
  });
});
