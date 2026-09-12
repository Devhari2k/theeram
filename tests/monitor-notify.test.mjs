// Theeram — FCM delivery, pure-unit tests with fake messaging.
// Run with: npm run test:monitor
//
// No emulator, no network, no real Messaging object anywhere in this file.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  chunk, isClaimable, classifyFcmError, enabledDevices, groupBy,
  buildNotification, buildDataPayload, buildMessages, toWireMessage,
  createNotifier, deviceFieldPath, assertDevicePath,
  recipientFieldPath, assertRecipientPath, isValidRecipientUid,
  recipientState, outstandingRecipients, retirementReason,
  FCM_BATCH_LIMIT, CLAIM_LEASE_MS,
  MAX_DELIVERY_ATTEMPTS, MAX_DECISION_AGE_MS
} from '../monitor/notify.js';

const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);
const T0 = Date.UTC(2026, 8, 12, 0, 0, 0);

const dec = (over = {}) => ({
  id: 'loc1__1__first__High', locationId: 'loc1', familyId: 'f1',
  kind: 'first', level: 'High', band: 'high', episodeId: 1,
  placeName: 'Kochi', reason: 'Heavy rainfall recorded — 80mm in the last 24h.',
  ...over
});

// ---------------------------------------------------------------------------
describe('device-path guard', () => {
  test('accepts a 64-char lowercase sha256 key', () => {
    assert.equal(deviceFieldPath(KEY_A), `devices.${KEY_A}`);
  });

  test('refuses anything else — this guard protects phone and emergencyContact', () => {
    for (const bad of ['phone', 'emergencyContact', 'devices', 'devices.', '',
                       'devices.' + 'A'.repeat(64), 'devices.' + 'a'.repeat(63),
                       'devices.' + 'a'.repeat(65), 'devices.abc', '../x',
                       'devices.aaa.phone', 'name']) {
      assert.throws(() => assertDevicePath(bad), /non-device user field path/, `accepted: ${bad}`);
    }
  });

  test('refuses an uppercase digest', () => {
    assert.throws(() => deviceFieldPath('A'.repeat(64)), /non-device/);
  });
});

// ---------------------------------------------------------------------------
describe('enabledDevices', () => {
  test('returns enabled devices with string tokens', () => {
    const d = enabledDevices({ devices: {
      [KEY_A]: { token: 'tok-a', enabled: true },
      [KEY_B]: { token: 'tok-b', enabled: true }
    }});
    assert.deepEqual(d.map(x => x.token).sort(), ['tok-a', 'tok-b']);
  });

  test('excludes disabled devices', () => {
    const d = enabledDevices({ devices: {
      [KEY_A]: { token: 'tok-a', enabled: true },
      [KEY_B]: { token: 'tok-b', enabled: false }
    }});
    assert.deepEqual(d.map(x => x.token), ['tok-a']);
  });

  test('excludes missing/empty/non-string tokens and malformed keys', () => {
    const d = enabledDevices({ devices: {
      [KEY_A]: { token: '', enabled: true },
      [KEY_B]: { enabled: true },
      ['nothex']: { token: 'tok', enabled: true },
      ['c'.repeat(64)]: { token: 42, enabled: true }
    }});
    assert.deepEqual(d, []);
  });

  test('a user with no devices field yields none, without throwing', () => {
    assert.deepEqual(enabledDevices({}), []);
    assert.deepEqual(enabledDevices(undefined), []);
    assert.deepEqual(enabledDevices({ devices: {} }), []);
  });

  test('never surfaces profile fields', () => {
    const d = enabledDevices({
      phone: '+91-555-0100',
      emergencyContact: { name: 'X', phone: '+91-555-0101' },
      devices: { [KEY_A]: { token: 'tok-a', enabled: true } }
    });
    assert.deepEqual(d, [{ deviceKey: KEY_A, token: 'tok-a' }]);
    assert.equal(JSON.stringify(d).includes('555'), false);
  });
});

// ---------------------------------------------------------------------------
describe('buildNotification', () => {
  test('single High alert names the place', () => {
    const n = buildNotification([dec()]);
    assert.match(n.title, /High flood risk — Kochi/);
  });

  test('Severe outranks High when several places are affected', () => {
    const n = buildNotification([dec(), dec({ id: 'd2', level: 'Severe', placeName: 'Alappuzha' })]);
    assert.match(n.title, /2 saved places at flood risk/);
    assert.ok(n.title.startsWith('🆘'), 'the worst level drives the icon');
  });

  test('escalation and sustained read differently from a first alert', () => {
    assert.match(buildNotification([dec({ kind: 'escalation', level: 'Severe' })]).title, /escalated to severe/);
    assert.match(buildNotification([dec({ kind: 'sustained' })]).title, /still at high/);
  });

  test('all_clear alone is a positive message', () => {
    const n = buildNotification([dec({ kind: 'all_clear', level: 'Low' })]);
    assert.match(n.title, /Flood risk has passed — Kochi/);
    assert.match(n.body, /back to normal/);
  });

  test('multiple all_clears are consolidated', () => {
    const n = buildNotification([
      dec({ kind: 'all_clear', placeName: 'Kochi' }),
      dec({ id: 'd2', kind: 'all_clear', placeName: 'Alappuzha' })
    ]);
    assert.match(n.title, /2 places/);
  });

  test('an alert alongside an all_clear leads with the alert', () => {
    const n = buildNotification([
      dec({ placeName: 'Kochi' }),
      dec({ id: 'd2', kind: 'all_clear', placeName: 'Alappuzha' })
    ]);
    assert.match(n.title, /High flood risk — Kochi/);
    assert.match(n.body, /Alappuzha has returned to normal/);
  });

  test('EVERY message carries the informational framing and official sources', () => {
    const cases = [
      [dec()], [dec({ level: 'Severe' })], [dec({ kind: 'sustained' })],
      [dec({ kind: 'all_clear' })], [dec(), dec({ id: 'd2' })]
    ];
    for (const c of cases) {
      const n = buildNotification(c);
      assert.match(n.body, /rainfall-based estimate, not an official forecast/,
        'must not read as a validated forecast');
      assert.match(n.body, /KSDMA \/ NDMA and local authority/);
    }
  });

  test('a missing place name degrades gracefully', () => {
    const n = buildNotification([dec({ placeName: null })]);
    assert.match(n.title, /a saved place/);
  });
});

// ---------------------------------------------------------------------------
describe('buildDataPayload — identifiers only', () => {
  const payload = buildDataPayload([dec()]);

  test('carries only identifier fields', () => {
    assert.deepEqual(Object.keys(payload).sort(),
      ['count', 'episodeId', 'familyId', 'kind', 'level', 'locationId', 'type']);
  });

  test('every value is a string, as FCM requires', () => {
    for (const [k, v] of Object.entries(payload)) {
      assert.equal(typeof v, 'string', `${k} must be a string`);
    }
  });

  test('NO coordinates, names, phone numbers or emergency contacts', () => {
    const serialised = JSON.stringify(buildDataPayload([
      dec({ placeName: 'Kochi', reason: 'Heavy rainfall', lat: 9.93, lon: 76.27 })
    ]));
    for (const leak of ['lat', 'lon', '9.93', '76.27', 'Kochi', 'phone',
                        'emergencyContact', 'reason', 'placeName', 'homeLocation']) {
      assert.equal(serialised.includes(leak), false, `data payload leaked ${leak}`);
    }
  });
});

// ---------------------------------------------------------------------------
describe('buildMessages — grouping and fan-out', () => {
  const devA = { deviceKey: KEY_A, token: 'tok-a' };
  const devB = { deviceKey: KEY_B, token: 'tok-b' };

  test('several decisions for one recipient become ONE consolidated notification', () => {
    const msgs = buildMessages([{ uid: 'u1', devices: [devA], decisions: [
      dec({ id: 'd1', placeName: 'Kochi' }),
      dec({ id: 'd2', placeName: 'Alappuzha' }),
      dec({ id: 'd3', placeName: 'Kollam' })
    ]}]);
    assert.equal(msgs.length, 1, 'one device, one message, regardless of decision count');
    assert.match(msgs[0].notification.title, /3 saved places/);
    assert.deepEqual(msgs[0]._meta.decisionIds, ['d1', 'd2', 'd3']);
  });

  test('a user in TWO families gets one notification covering both', () => {
    const msgs = buildMessages([{ uid: 'u1', devices: [devA], decisions: [
      dec({ id: 'd1', familyId: 'f1', placeName: 'Kochi' }),
      dec({ id: 'd2', familyId: 'f2', placeName: 'Kollam' })
    ]}]);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0]._meta.decisionIds.length, 2);
  });

  test('multi-device fan-out: one message per device, same content', () => {
    const msgs = buildMessages([{ uid: 'u1', devices: [devA, devB], decisions: [dec()] }]);
    assert.equal(msgs.length, 2);
    assert.deepEqual(msgs[0].notification, msgs[1].notification);
    assert.deepEqual(msgs.map(m => m.token).sort(), ['tok-a', 'tok-b']);
    assert.deepEqual(msgs.map(m => m._meta.deviceKey).sort(), [KEY_A, KEY_B].sort());
  });

  test('a recipient with ZERO devices produces no message and does not throw', () => {
    assert.deepEqual(buildMessages([{ uid: 'u1', devices: [], decisions: [dec()] }]), []);
    assert.deepEqual(buildMessages([{ uid: 'u1', decisions: [dec()] }]), []);
  });

  test('a recipient with no decisions produces no message', () => {
    assert.deepEqual(buildMessages([{ uid: 'u1', devices: [devA], decisions: [] }]), []);
  });

  test('several recipients each get their own message', () => {
    const msgs = buildMessages([
      { uid: 'u1', devices: [devA], decisions: [dec()] },
      { uid: 'u2', devices: [devB], decisions: [dec()] }
    ]);
    assert.equal(msgs.length, 2);
    assert.deepEqual(msgs.map(m => m._meta.uid).sort(), ['u1', 'u2']);
  });

  test('exact message shape', () => {
    const m = buildMessages([{ uid: 'u1', devices: [devA], decisions: [dec()] }])[0];
    assert.deepEqual(Object.keys(m).sort(), ['_meta', 'android', 'data', 'notification', 'token']);
    assert.equal(m.android.priority, 'high');
    assert.equal(m.android.notification.channelId, 'theeram-flood-alerts');
    assert.deepEqual(Object.keys(m.notification).sort(), ['body', 'title']);
  });

  test('the internal _meta never reaches the wire', () => {
    const m = buildMessages([{ uid: 'u1', devices: [devA], decisions: [dec()] }])[0];
    const wire = toWireMessage(m);
    assert.equal('_meta' in wire, false);
    assert.deepEqual(Object.keys(wire).sort(), ['android', 'data', 'notification', 'token']);
  });
});

// ---------------------------------------------------------------------------
describe('chunking at the FCM limit', () => {
  test('the limit is 500', () => assert.equal(FCM_BATCH_LIMIT, 500));

  test('501 messages split into 500 + 1', () => {
    const batches = chunk(new Array(501).fill(0), FCM_BATCH_LIMIT);
    assert.equal(batches.length, 2);
    assert.equal(batches[0].length, 500);
    assert.equal(batches[1].length, 1);
  });

  test('exactly 500 stays a single batch', () => {
    assert.equal(chunk(new Array(500).fill(0), FCM_BATCH_LIMIT).length, 1);
  });

  test('1200 messages become 3 batches with nothing lost', () => {
    const batches = chunk(new Array(1200).fill(0), FCM_BATCH_LIMIT);
    assert.equal(batches.length, 3);
    assert.equal(batches.reduce((n, b) => n + b.length, 0), 1200);
  });

  test('a 600-device fan-out chunks correctly end to end', () => {
    const devices = Array.from({ length: 600 }, (_, i) => ({
      deviceKey: i.toString(16).padStart(64, '0'), token: `tok-${i}`
    }));
    const msgs = buildMessages([{ uid: 'u1', devices, decisions: [dec()] }]);
    assert.equal(msgs.length, 600);
    assert.equal(chunk(msgs, FCM_BATCH_LIMIT).length, 2);
  });
});

// ---------------------------------------------------------------------------
describe('FCM error classification', () => {
  test('unregistered tokens are deleted', () => {
    assert.equal(classifyFcmError('messaging/registration-token-not-registered'), 'delete');
    assert.equal(classifyFcmError('registration-token-not-registered'), 'delete');
  });

  test('invalid registration tokens are deleted', () => {
    assert.equal(classifyFcmError('messaging/invalid-registration-token'), 'delete');
  });

  test('invalid-argument RETAINS the token — that is our bug, not theirs', () => {
    assert.equal(classifyFcmError('messaging/invalid-argument'), 'retain-log');
  });

  test('everything else is retained for retry', () => {
    for (const c of ['messaging/internal-error', 'messaging/server-unavailable',
                     'messaging/quota-exceeded', 'messaging/third-party-auth-error',
                     'unknown', '', null, undefined]) {
      assert.equal(classifyFcmError(c), 'retain', `wrong verdict for ${String(c)}`);
    }
  });
});

// ---------------------------------------------------------------------------
describe('claim lease', () => {
  test('an unclaimed undelivered decision is claimable', () => {
    assert.equal(isClaimable({ delivered: false }, T0), true);
  });

  test('a delivered decision is never claimable', () => {
    assert.equal(isClaimable({ delivered: true }, T0), false);
    assert.equal(isClaimable({ delivered: true, claimedAt: null }, T0), false);
  });

  test('a freshly claimed decision is not claimable by another run', () => {
    const d = { delivered: false, claimedAt: new Date(T0).toISOString() };
    assert.equal(isClaimable(d, T0 + 60e3), false);
    assert.equal(isClaimable(d, T0 + CLAIM_LEASE_MS - 1), false);
  });

  test('an expired lease is claimable again — at-least-once', () => {
    const d = { delivered: false, claimedAt: new Date(T0).toISOString() };
    assert.equal(isClaimable(d, T0 + CLAIM_LEASE_MS), true);
    assert.equal(isClaimable(d, T0 + 2 * CLAIM_LEASE_MS), true);
  });

  test('an unparseable claim timestamp does not strand the decision', () => {
    assert.equal(isClaimable({ delivered: false, claimedAt: 'nonsense' }, T0), true);
    assert.equal(isClaimable({ delivered: false, claimedAt: null }, T0), true);
  });

  test('the lease is 10 minutes', () => assert.equal(CLAIM_LEASE_MS, 10 * 60 * 1000));
});

// ---------------------------------------------------------------------------
describe('dry-run notifier — structural guarantee', () => {
  test('getMessaging is NEVER called in dry-run', async () => {
    let called = 0;
    const n = createNotifier({ dryRun: true, getMessaging: () => { called++; throw new Error('must not construct Messaging'); }, logger: { log() {} } });
    const res = await n.sendEach([{ token: 't' }, { token: 'u' }]);
    assert.equal(called, 0, 'dry-run must not construct the Messaging object');
    assert.equal(n.dryRun, true);
    assert.equal(res.simulated, true);
    assert.equal(res.successCount, 2);
    assert.equal(res.failureCount, 0);
  });

  test('a dry-run notifier works even with NO getMessaging at all', async () => {
    const n = createNotifier({ dryRun: true, logger: { log() {} } });
    const res = await n.sendEach([{ token: 't' }]);
    assert.equal(res.simulated, true);
  });

  test('a live notifier constructs Messaging lazily, on first send only', async () => {
    let constructed = 0;
    const fake = { sendEach: async (m) => ({ successCount: m.length, failureCount: 0, responses: m.map(() => ({ success: true })) }) };
    const n = createNotifier({ dryRun: false, getMessaging: () => { constructed++; return fake; } });
    assert.equal(constructed, 0, 'not constructed at factory time');
    await n.sendEach([{ token: 't' }]);
    assert.equal(constructed, 1);
    await n.sendEach([{ token: 't' }]);
    assert.equal(constructed, 1, 'reused, not reconstructed');
  });

  test('a live notifier without getMessaging is refused up front', () => {
    assert.throws(() => createNotifier({ dryRun: false }), /getMessaging is required/);
  });
});

// ---------------------------------------------------------------------------
describe('groupBy', () => {
  test('groups decisions by family', () => {
    const g = groupBy([dec({ familyId: 'f1' }), dec({ familyId: 'f2' }), dec({ familyId: 'f1' })], d => d.familyId);
    assert.equal(g.size, 2);
    assert.equal(g.get('f1').length, 2);
  });
});

// ---------------------------------------------------------------------------
describe('recipient path guard', () => {
  test('accepts a normal Firebase uid', () => {
    assert.equal(recipientFieldPath('AbC123_xyz-789'), 'recipients.AbC123_xyz-789');
  });

  test('refuses a uid containing a dot — it would escape into another field', () => {
    // `recipients.a.delivered` would address a nested key, not a recipient.
    assert.throws(() => recipientFieldPath('a.delivered'), /non-recipient decision field path/);
  });

  test('refuses paths that would hit decision fields directly', () => {
    for (const p of ['delivered', 'episodeId', 'recipients', 'undeliveredTo', 'recipients.', '']) {
      assert.throws(() => assertRecipientPath(p), /non-recipient decision field path/, `allowed ${p}`);
    }
  });

  test('refuses traversal and separator characters', () => {
    for (const uid of ['../x', 'a/b', 'a b', 'a`b', 'a[0]', 'a"b']) {
      assert.equal(isValidRecipientUid(uid), false, `allowed ${uid}`);
    }
  });

  test('refuses an over-long uid', () => {
    assert.equal(isValidRecipientUid('u'.repeat(129)), false);
    assert.equal(isValidRecipientUid('u'.repeat(128)), true);
  });
});

// ---------------------------------------------------------------------------
describe('recipientState', () => {
  test('a decision with no recipients map reads as nobody delivered', () => {
    const s = recipientState(dec(), 'u1');
    assert.deepEqual(s, { delivered: false, attempts: 0, lastCode: null, deliveredAt: null });
  });

  test('reads an existing entry', () => {
    const d = dec({ recipients: { u1: { delivered: true, attempts: 2, lastCode: null, deliveredAt: 'T' } } });
    assert.deepEqual(recipientState(d, 'u1'), { delivered: true, attempts: 2, lastCode: null, deliveredAt: 'T' });
  });

  test('a truthy-but-not-true delivered flag does not count as delivered', () => {
    const d = dec({ recipients: { u1: { delivered: 'yes' } } });
    assert.equal(recipientState(d, 'u1').delivered, false);
  });

  test('tolerates a malformed entry', () => {
    assert.equal(recipientState(dec({ recipients: { u1: 'nonsense' } }), 'u1').delivered, false);
    assert.equal(recipientState(dec({ recipients: null }), 'u1').attempts, 0);
  });
});

// ---------------------------------------------------------------------------
describe('outstandingRecipients', () => {
  test('a legacy decision owes everybody', () => {
    assert.deepEqual(outstandingRecipients(dec(), ['u1', 'u2', 'u3']), ['u1', 'u2', 'u3']);
  });

  test('delivered recipients drop out', () => {
    const d = dec({ recipients: { u1: { delivered: true }, u2: { delivered: false, attempts: 1 } } });
    assert.deepEqual(outstandingRecipients(d, ['u1', 'u2', 'u3']), ['u2', 'u3']);
  });

  test('everyone delivered means nothing outstanding', () => {
    const d = dec({ recipients: { u1: { delivered: true }, u2: { delivered: true } } });
    assert.deepEqual(outstandingRecipients(d, ['u1', 'u2']), []);
  });

  test('a delivered recipient who is no longer a member is simply absent', () => {
    const d = dec({ recipients: { gone: { delivered: true } } });
    assert.deepEqual(outstandingRecipients(d, ['u1']), ['u1']);
  });
});

// ---------------------------------------------------------------------------
describe('retirementReason', () => {
  const decided = new Date(T0).toISOString();

  test('keeps trying early on', () => {
    assert.equal(retirementReason({ decidedAt: decided }, T0 + 3600e3, 1), null);
  });

  test('exhausted at the attempt cap', () => {
    assert.equal(retirementReason({ decidedAt: decided }, T0 + 3600e3, MAX_DELIVERY_ATTEMPTS), 'exhausted');
  });

  test('one attempt short of the cap is not retired', () => {
    assert.equal(retirementReason({ decidedAt: decided }, T0 + 3600e3, MAX_DELIVERY_ATTEMPTS - 1), null);
  });

  test('stale once older than the age cutoff, whatever the attempt count', () => {
    assert.equal(retirementReason({ decidedAt: decided }, T0 + MAX_DECISION_AGE_MS, 1), 'stale');
  });

  test('age wins over attempts when both apply', () => {
    const r = retirementReason({ decidedAt: decided }, T0 + MAX_DECISION_AGE_MS, MAX_DELIVERY_ATTEMPTS);
    assert.equal(r, 'stale', 'a 12-hour-old warning is stale first and foremost');
  });

  test('a decision with no decidedAt still retires on attempts', () => {
    assert.equal(retirementReason({}, T0, 1), null);
    assert.equal(retirementReason({}, T0, MAX_DELIVERY_ATTEMPTS), 'exhausted');
  });

  test('thresholds are overridable for testing', () => {
    assert.equal(retirementReason({ decidedAt: decided }, T0, 2, { maxAttempts: 2 }), 'exhausted');
    assert.equal(retirementReason({ decidedAt: decided }, T0 + 10, 1, { maxAgeMs: 5 }), 'stale');
  });
});
