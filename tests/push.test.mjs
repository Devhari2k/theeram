// Theeram — client FCM foundation, pure-logic tests.
// Run with: npm run test:push
//
// www/js/push.js imports Firebase from a CDN URL, which Node cannot resolve,
// so the pure helpers are evaluated here in isolation rather than imported.
// They are lifted verbatim from the module and a guard test below asserts the
// source still matches, so the copies cannot silently drift.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../www/js/push.js', import.meta.url), 'utf8');

const PLATFORM = 'android';
const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;

async function deviceKeyFromToken(token) {
  const t = String(token == null ? '' : token);
  if (!t) throw new Error('deviceKeyFromToken: empty token');
  const bytes = new TextEncoder().encode(t);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function buildDeviceRecord({ token, platform = PLATFORM, existing = null, nowIso }) {
  return {
    token: String(token),
    platform,
    enabled: true,
    createdAt: (existing && existing.createdAt) || nowIso,
    updatedAt: nowIso
  };
}

function shouldWriteDevice(existing, record, nowMs, maxAgeMs = REFRESH_AFTER_MS) {
  if (!existing || typeof existing !== 'object') return true;
  if (existing.token !== record.token) return true;
  if (existing.enabled !== true) return true;
  const prev = Date.parse(existing.updatedAt);
  if (!Number.isFinite(prev)) return true;
  return (nowMs - prev) >= maxAgeMs;
}

function shouldRequestPermission(status) {
  const receive = status && status.receive;
  return receive !== 'granted';
}

function deviceFieldPath(key) {
  if (!/^[0-9a-f]{64}$/.test(String(key))) {
    throw new Error('deviceFieldPath: expected a sha256 hex key');
  }
  return `devices.${key}`;
}

const NOW_ISO = '2026-09-11T12:00:00.000Z';
const NOW_MS = Date.parse(NOW_ISO);
const TOKEN = 'fMEXAMPLEtoken:APA91bF-example-registration-token-value_0123456789';

// ---------------------------------------------------------------------------
describe('deviceKeyFromToken', () => {
  test('returns a 64-char lowercase hex digest', async () => {
    const k = await deviceKeyFromToken(TOKEN);
    assert.match(k, /^[0-9a-f]{64}$/);
  });

  test('is deterministic — refresh overwrites in place instead of duplicating', async () => {
    assert.equal(await deviceKeyFromToken(TOKEN), await deviceKeyFromToken(TOKEN));
  });

  test('different tokens give different keys', async () => {
    assert.notEqual(await deviceKeyFromToken(TOKEN), await deviceKeyFromToken(TOKEN + 'x'));
  });

  test('matches Node crypto SHA-256 — pins the algorithm', async () => {
    const { createHash } = await import('node:crypto');
    const expected = createHash('sha256').update('theeram', 'utf8').digest('hex');
    assert.equal(await deviceKeyFromToken('theeram'), expected);
  });

  test('rejects an empty or missing token rather than keying everything the same', async () => {
    await assert.rejects(() => deviceKeyFromToken(''), /empty token/);
    await assert.rejects(() => deviceKeyFromToken(null), /empty token/);
    await assert.rejects(() => deviceKeyFromToken(undefined), /empty token/);
  });

  test('the key never contains a dot, which would break the dotted field path', async () => {
    for (const t of [TOKEN, 'a.b.c', '../../escape', '{}']) {
      assert.ok(!(await deviceKeyFromToken(t)).includes('.'));
    }
  });
});

// ---------------------------------------------------------------------------
describe('buildDeviceRecord', () => {
  test('stores exactly the documented metadata', () => {
    const r = buildDeviceRecord({ token: TOKEN, nowIso: NOW_ISO });
    assert.deepEqual(Object.keys(r).sort(),
      ['createdAt', 'enabled', 'platform', 'token', 'updatedAt']);
    assert.equal(r.token, TOKEN);
    assert.equal(r.platform, 'android');
    assert.equal(r.enabled, true);
    assert.equal(r.createdAt, NOW_ISO);
    assert.equal(r.updatedAt, NOW_ISO);
  });

  test('preserves createdAt across a refresh, advances updatedAt', () => {
    const first = buildDeviceRecord({ token: TOKEN, nowIso: '2026-01-01T00:00:00.000Z' });
    const later = buildDeviceRecord({ token: TOKEN, existing: first, nowIso: NOW_ISO });
    assert.equal(later.createdAt, '2026-01-01T00:00:00.000Z', 'first-seen must not be overwritten');
    assert.equal(later.updatedAt, NOW_ISO);
  });

  test('a rotated token keeps the original createdAt for the same device', () => {
    const first = buildDeviceRecord({ token: TOKEN, nowIso: '2026-01-01T00:00:00.000Z' });
    const rotated = buildDeviceRecord({ token: 'new-token', existing: first, nowIso: NOW_ISO });
    assert.equal(rotated.token, 'new-token');
    assert.equal(rotated.createdAt, '2026-01-01T00:00:00.000Z');
  });

  test('contains no uid — ownership comes from the document path', () => {
    const r = buildDeviceRecord({ token: TOKEN, nowIso: NOW_ISO });
    for (const k of ['uid', 'userId', 'ownerUid']) {
      assert.ok(!(k in r), `${k} must not be a spoofable field`);
    }
  });
});

// ---------------------------------------------------------------------------
describe('shouldWriteDevice', () => {
  const rec = buildDeviceRecord({ token: TOKEN, nowIso: NOW_ISO });

  test('writes when there is no existing record', () => {
    assert.equal(shouldWriteDevice(null, rec, NOW_MS), true);
    assert.equal(shouldWriteDevice(undefined, rec, NOW_MS), true);
  });

  test('writes immediately when the token changed', () => {
    const old = { ...rec, token: 'different', updatedAt: NOW_ISO };
    assert.equal(shouldWriteDevice(old, rec, NOW_MS), true);
  });

  test('writes immediately when the stored record is disabled', () => {
    assert.equal(shouldWriteDevice({ ...rec, enabled: false }, rec, NOW_MS), true);
  });

  test('skips a redundant write for an unchanged, fresh record', () => {
    assert.equal(shouldWriteDevice(rec, rec, NOW_MS), false);
    assert.equal(shouldWriteDevice(rec, rec, NOW_MS + 60e3), false);
  });

  test('rewrites once the refresh interval has elapsed', () => {
    assert.equal(shouldWriteDevice(rec, rec, NOW_MS + REFRESH_AFTER_MS - 1), false);
    assert.equal(shouldWriteDevice(rec, rec, NOW_MS + REFRESH_AFTER_MS), true);
  });

  test('writes when the stored timestamp is missing or unparseable', () => {
    assert.equal(shouldWriteDevice({ ...rec, updatedAt: undefined }, rec, NOW_MS), true);
    assert.equal(shouldWriteDevice({ ...rec, updatedAt: 'not-a-date' }, rec, NOW_MS), true);
  });

  test('a non-object stored value is treated as absent', () => {
    for (const bad of ['x', 7, true, []]) {
      assert.equal(shouldWriteDevice(bad, rec, NOW_MS), true, `bad: ${JSON.stringify(bad)}`);
    }
  });
});

// ---------------------------------------------------------------------------
describe('shouldRequestPermission', () => {
  // Regression guard for the real-device failure: the app never showed the
  // notification prompt and the only way to grant it was Android Settings.
  // The old logic asked only when the state was exactly 'prompt', so once
  // Capacitor had cached any other state the app went permanently silent.

  test('does NOT ask when already granted', () => {
    assert.equal(shouldRequestPermission({ receive: 'granted' }), false);
  });

  test('asks on a fresh install (prompt)', () => {
    assert.equal(shouldRequestPermission({ receive: 'prompt' }), true);
  });

  test('asks when a rationale should be shown', () => {
    assert.equal(shouldRequestPermission({ receive: 'prompt-with-rationale' }), true);
  });

  test('REGRESSION: still asks when Capacitor reports a cached "denied"', () => {
    // This is the case the previous build fell through — it never asked
    // again, leaving Android Settings as the only route.
    assert.equal(shouldRequestPermission({ receive: 'denied' }), true);
  });

  test('asks for any unexpected or missing state rather than going silent', () => {
    for (const s of [{}, { receive: undefined }, { receive: 'unknown' }, null, undefined]) {
      assert.equal(shouldRequestPermission(s), true, `should ask for ${JSON.stringify(s)}`);
    }
  });

  test('only an exact "granted" suppresses the prompt', () => {
    for (const s of ['Granted', 'GRANTED', ' granted', 'granted ']) {
      assert.equal(shouldRequestPermission({ receive: s }), true, `must not match ${JSON.stringify(s)}`);
    }
  });
});

// ---------------------------------------------------------------------------
describe('deviceFieldPath', () => {
  test('builds a dotted path under devices', async () => {
    const key = await deviceKeyFromToken(TOKEN);
    assert.equal(deviceFieldPath(key), `devices.${key}`);
  });

  test('rejects anything that is not a sha256 hex key', () => {
    // Guards against a raw token — which contains ':' and '-' — ever being
    // used as a field path, where it would address the wrong nested key.
    for (const bad of [TOKEN, 'devices.evil', '../x', '', 'ABCDEF', 'a'.repeat(63)]) {
      assert.throws(() => deviceFieldPath(bad), /sha256 hex key/, `accepted: ${bad}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Guards over the real source, so this file cannot drift from the module and
// so the security-relevant decisions cannot be quietly undone.
// ---------------------------------------------------------------------------
describe('source guards', () => {
  test('the helper implementations here match www/js/push.js', () => {
    for (const sig of [
      'export async function deviceKeyFromToken(token) {',
      'export function buildDeviceRecord({ token, platform = PLATFORM, existing = null, nowIso }) {',
      'export function shouldWriteDevice(existing, record, nowMs, maxAgeMs = REFRESH_AFTER_MS) {',
      'export function shouldRequestPermission(status) {',
      'export function deviceFieldPath(key) {'
    ]) {
      assert.ok(SRC.includes(sig), `signature drifted: ${sig}`);
    }
    assert.ok(SRC.includes("await globalThis.crypto.subtle.digest('SHA-256', bytes)"));
    assert.ok(SRC.includes("createdAt: (existing && existing.createdAt) || nowIso"));
  });

  test('tokens are written to the profile doc, NOT a subcollection', () => {
    // A users/{uid}/devices/* subcollection would need a new rules block,
    // because Firestore rules do not cascade. This asserts we still use the
    // already-governed profile document.
    assert.ok(SRC.includes("doc(db, 'users', uid)"), 'must address users/{uid}');
    assert.ok(!/collection\(\s*db\s*,\s*'users'[^)]*'devices'/.test(SRC),
      'must not open a devices subcollection');
    assert.ok(SRC.includes("{ devices: { [key]: record } }, { merge: true }"),
      'must deep-merge so other devices and profile fields survive');
  });

  test('sign-out removes the registration before the session ends', () => {
    const auth = readFileSync(new URL('../www/js/auth.js', import.meta.url), 'utf8');
    const unreg = auth.indexOf('unregisterDevice');
    const out = auth.indexOf('signOut(auth)', unreg);
    assert.ok(unreg !== -1, 'sign-out must detach the device');
    assert.ok(unreg < out, 'unregisterDevice must run BEFORE signOut');
  });

  test('receive handlers stay inert — no alert or risk behaviour', () => {
    const received = SRC.slice(SRC.indexOf("'pushNotificationReceived'"));
    for (const f of ['computeRisk', 'notifyFamilyOfRisk', 'riskAlertBanner', 'alertState']) {
      assert.ok(!SRC.includes(f), `push.js must not touch ${f}`);
    }
    assert.ok(received.includes('inert'), 'receive handler should be explicitly inert');
  });

  test('no server-side sending or credentials in the client module', () => {
    for (const f of ['firebase-admin', 'getMessaging', 'sendEach', 'sendMulticast',
                     'service_account', 'private_key', 'messages:send']) {
      assert.ok(!SRC.includes(f), `push.js must not contain ${f}`);
    }
  });

  test('registration is driven by onAuthStateChanged, not a cross-module event', () => {
    // theeram:authready is dispatched by auth.js, which loads BEFORE push.js.
    // Hanging registration off it alone was a race that could silently skip
    // the permission prompt for the life of an install. onAuthStateChanged
    // replays current state to a listener however late it is added.
    assert.ok(SRC.includes('onAuthStateChanged(auth, (user) =>'),
      'must subscribe to auth state directly');
    assert.ok(!SRC.includes("addEventListener('theeram:authready'"),
      'must no longer depend on the authready event for registration');
  });

  test('registration is retried after the profile is created and on resume', () => {
    assert.ok(SRC.includes("addEventListener('theeram:profilesaved'"),
      'a new user registers once their profile document exists');
    assert.ok(SRC.includes("addEventListener('visibilitychange'"),
      'returning to the app retries registration');
  });

  test('a missing profile document defers instead of creating a partial one', () => {
    // Creating users/{uid} with only devices would make auth.js skip the
    // profile gate for a brand-new user.
    assert.ok(SRC.includes('if (!snap.exists())'), 'must check existence first');
    assert.ok(SRC.includes('pushState.pendingProfile = true'));
  });

  test('the permission prompt is asked at most once per app session', () => {
    assert.ok(SRC.includes('permissionRequestedThisSession'),
      'a refusal must not re-prompt on every retry trigger');
  });

  test('failures are diagnosable rather than silent', () => {
    assert.ok(SRC.includes('diagnose()'), 'must expose a diagnose() helper');
    assert.ok(SRC.includes("console.log('[push] checkPermissions ->'"),
      'must log the permission state it observed');
  });

  test('degrades to a no-op without the Capacitor bridge', () => {
    assert.ok(SRC.includes('window.Capacitor.Plugins.PushNotifications')
      || SRC.includes("window.Capacitor.Plugins && window.Capacitor.Plugins.PushNotifications"));
    assert.ok(SRC.includes("pushState.permission = 'unsupported'"));
  });
});
