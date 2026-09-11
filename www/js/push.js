// Theeram — client-side FCM foundation.
//
// Obtains an FCM registration token on Android and stores it against the
// signed-in user. NOTHING IS SENT OR RECEIVED MEANINGFULLY YET: the server has
// no delivery code, and the receive handlers here only log. Wiring alert
// decisions to FCM is a later phase.
//
// Two deliberate choices worth reading before changing anything:
//
// 1. WHERE THE TOKEN LIVES.  users/{uid}.devices[<sha256(token)>], a map field
//    on the existing profile document — NOT a users/{uid}/devices/*
//    subcollection. Firestore rules do not cascade into subcollections, so a
//    subcollection would need a new rules block before a single token could be
//    written. The profile document is already governed by
//        match /users/{uid} { allow read, write: if isOwner(uid); }
//    which is owner-only for both read and write and is already covered by the
//    deployed rules test suite. A token stored there is protected exactly as
//    well as the phone number and emergency contact already sitting beside it,
//    and no rules change is required.
//
// 2. HOW THE TOKEN IS BOUND TO ITS OWNER.  The uid is part of the document
//    PATH, not a field in the payload. A client can therefore only ever write
//    under its own uid — there is no ownership field to spoof, so the class of
//    bug fixed in 5899bca cannot recur here.
//
// The document id for each device is the SHA-256 of the token rather than the
// token itself: it is deterministic, so re-registration and token refresh
// overwrite in place instead of accumulating duplicates, and it keeps a long
// opaque credential out of map keys that end up in logs and console URLs.
//
// This module degrades to a no-op in a plain browser (no Capacitor bridge),
// so the web build keeps working unchanged.

import { auth, db } from './firebase-init.js';
import {
  doc, getDoc, setDoc, updateDoc, deleteField
} from 'https://www.gstatic.com/firebasejs/12.17.1/firebase-firestore.js';

export const PLATFORM = 'android';

// Re-register at most once a day. The token rarely changes, so rewriting the
// profile document on every launch would be pure write-quota noise; but
// updatedAt still needs to move often enough to be worth reading.
export const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Pure helpers — no Firestore, no plugin, no DOM. Unit-tested in
// tests/push.test.mjs.
// ---------------------------------------------------------------------------

/** SHA-256 hex of the token; stable map key for one device. */
export async function deviceKeyFromToken(token) {
  const t = String(token == null ? '' : token);
  if (!t) throw new Error('deviceKeyFromToken: empty token');
  const bytes = new TextEncoder().encode(t);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The stored shape. createdAt is preserved across refreshes so the record
 * still says when this device first registered, not when it last checked in.
 */
export function buildDeviceRecord({ token, platform = PLATFORM, existing = null, nowIso }) {
  return {
    token: String(token),
    platform,
    enabled: true,
    createdAt: (existing && existing.createdAt) || nowIso,
    updatedAt: nowIso
  };
}

/**
 * Whether the stored record is stale enough to be worth a write.
 * Any change of token or enabled flag writes immediately; an otherwise
 * identical record only rewrites once REFRESH_AFTER_MS has passed.
 */
export function shouldWriteDevice(existing, record, nowMs, maxAgeMs = REFRESH_AFTER_MS) {
  if (!existing || typeof existing !== 'object') return true;
  if (existing.token !== record.token) return true;
  if (existing.enabled !== true) return true;
  const prev = Date.parse(existing.updatedAt);
  if (!Number.isFinite(prev)) return true;
  return (nowMs - prev) >= maxAgeMs;
}

/** Dotted path addressing one device inside the profile document. */
export function deviceFieldPath(key) {
  if (!/^[0-9a-f]{64}$/.test(String(key))) {
    throw new Error('deviceFieldPath: expected a sha256 hex key');
  }
  return `devices.${key}`;
}

// ---------------------------------------------------------------------------
// Capacitor bridge
// ---------------------------------------------------------------------------

// Accessed through the global bridge rather than an ESM import: Theeram has no
// bundler, so `import { PushNotifications } from '@capacitor/push-notifications'`
// would not resolve in the browser. Capacitor registers native plugins on
// window.Capacitor.Plugins, which is the bundler-free access path.
function pushPlugin() {
  return (typeof window !== 'undefined' && window.Capacitor
    && window.Capacitor.Plugins && window.Capacitor.Plugins.PushNotifications) || null;
}

export function isSupported() {
  return !!pushPlugin();
}

// Last known state, surfaced for UI that wants to tell the user alerts are off.
export const pushState = {
  supported: false,
  permission: 'unknown',   // 'granted' | 'denied' | 'prompt' | 'unknown'
  registered: false,
  token: null,
  error: null
};

let listenersBound = false;
let currentUid = null;
let currentKey = null;

function emit() {
  document.dispatchEvent(new CustomEvent('theeram:pushstatechanged', {
    detail: { ...pushState, token: pushState.token ? '[present]' : null }
  }));
}

// ---------------------------------------------------------------------------
// Firestore
// ---------------------------------------------------------------------------

async function upsertDevice(uid, token) {
  const key = await deviceKeyFromToken(token);
  const ref = doc(db, 'users', uid);
  const snap = await getDoc(ref);
  const existing = snap.exists() ? ((snap.data().devices || {})[key] || null) : null;
  const record = buildDeviceRecord({ token, existing, nowIso: new Date().toISOString() });

  if (!shouldWriteDevice(existing, record, Date.now())) return { key, written: false };

  // merge:true deep-merges the devices map, so registering this device never
  // disturbs the user's other devices or the rest of their profile.
  await setDoc(ref, { devices: { [key]: record } }, { merge: true });
  return { key, written: true };
}

/**
 * Remove this device's registration from the CURRENT user's profile.
 *
 * Must run BEFORE signOut(): the rule is isOwner(uid), so once the session is
 * gone the write is denied. Without this, the next person to sign in on this
 * handset would inherit a token still filed under the previous account, and
 * the server would eventually push one family's flood alert to another
 * family's phone.
 */
export async function unregisterDevice() {
  const uid = currentUid;
  const key = currentKey;
  if (!uid || !key) return false;
  try {
    await updateDoc(doc(db, 'users', uid), { [deviceFieldPath(key)]: deleteField() });
    return true;
  } catch (err) {
    console.warn('[push] could not remove device registration:', err && err.message);
    return false;
  } finally {
    currentKey = null;
    pushState.registered = false;
    pushState.token = null;
    emit();
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

function bindListeners(plugin) {
  if (listenersBound) return;
  listenersBound = true;

  plugin.addListener('registration', async (tokenEvent) => {
    // Fires on first registration AND on every token refresh — the plugin's
    // MessagingService.onNewToken() routes back through this same event, so
    // one handler covers both and refresh needs no separate path.
    const token = tokenEvent && tokenEvent.value;
    if (!token) return;
    pushState.token = token;
    pushState.error = null;
    try {
      const uid = auth.currentUser && auth.currentUser.uid;
      if (!uid) return;                 // signed out mid-flight; nothing to attach to
      const { key, written } = await upsertDevice(uid, token);
      currentUid = uid;
      currentKey = key;
      pushState.registered = true;
      console.log(`[push] device registered (${written ? 'stored' : 'already current'})`);
    } catch (err) {
      pushState.error = String(err && err.message || err);
      console.warn('[push] could not store device token:', pushState.error);
    }
    emit();
  });

  plugin.addListener('registrationError', (err) => {
    // The usual cause is a missing google-services.json, i.e. no Android app
    // registered in the Firebase project yet.
    pushState.registered = false;
    pushState.error = String((err && (err.error || err.message)) || 'registration failed');
    console.warn('[push] registration error:', pushState.error);
    emit();
  });

  // Deliberately inert. No banner, no alert state, no risk logic — delivery
  // and its UI are a later phase, and a half-wired handler now would be worse
  // than none.
  plugin.addListener('pushNotificationReceived', (n) => {
    console.log('[push] notification received (inert):', n && n.title);
  });
  plugin.addListener('pushNotificationActionPerformed', (a) => {
    console.log('[push] notification tapped (inert):', a && a.actionId);
  });
}

/**
 * Ask for permission if needed and register. Safe to call repeatedly.
 * Never throws: push failing must not break sign-in.
 */
export async function initPush() {
  const plugin = pushPlugin();
  pushState.supported = !!plugin;
  if (!plugin) {
    // Plain browser, or the plugin is not reachable through the bridge.
    pushState.permission = 'unsupported';
    emit();
    return false;
  }

  try {
    bindListeners(plugin);

    let status = await plugin.checkPermissions();
    if (status.receive === 'prompt' || status.receive === 'prompt-with-rationale') {
      status = await plugin.requestPermissions();
    }
    pushState.permission = status.receive;

    if (status.receive !== 'granted') {
      // Denied is a legitimate end state, not an error to retry around. The
      // app must not imply alerts are working when they are not.
      pushState.registered = false;
      console.log('[push] notification permission not granted:', status.receive);
      emit();
      return false;
    }

    await plugin.register();   // resolves immediately; 'registration' fires later
    emit();
    return true;
  } catch (err) {
    pushState.error = String(err && err.message || err);
    console.warn('[push] init failed:', pushState.error);
    emit();
    return false;
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

document.addEventListener('theeram:authready', (e) => {
  currentUid = (e.detail && e.detail.user && e.detail.user.uid) || null;
  initPush();
});

// Sign-out cleanup is driven from auth.js, which awaits unregisterDevice()
// before calling signOut() — see the comment on unregisterDevice().
document.addEventListener('theeram:signedout', () => {
  currentUid = null;
  currentKey = null;
  pushState.registered = false;
  pushState.token = null;
  emit();
});

// Exposed for the inline script and for manual checks from a device console.
if (typeof window !== 'undefined') {
  window.theeramPush = { initPush, unregisterDevice, isSupported, pushState };
}
