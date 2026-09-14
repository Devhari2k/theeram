// Theeram — client-side FCM foundation.
//
// Obtains an FCM registration token on Android and stores it against the
// signed-in user, and creates the notification channel the server addresses.
// The server side is live: monitor/notify.js delivers real flood alerts to the
// tokens registered here.
//
// Display is handled NATIVELY in both app states, not by the listeners below.
// Backgrounded, the Firebase SDK posts the notification itself; foregrounded,
// it hands off to the Capacitor plugin, which posts it because
// capacitor.config.json declares PushNotifications.presentationOptions. The
// JS listeners are therefore intentionally passive — they observe, they do not
// draw. Removing presentationOptions would silently break foreground alerts.
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
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.17.1/firebase-auth.js';
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

/**
 * Whether initPush() should call requestPermissions() for this status.
 *
 * The rule is simply "anything that is not granted". The earlier version only
 * requested when the state was exactly 'prompt', which left a dead end:
 * Capacitor's Bridge.getPermissionStates() reports PROMPT only while no state
 * has ever been cached, and once a 'denied' has been written to its
 * PERMISSION_PREFS the state is returned verbatim from then on. A single
 * missed or dismissed first attempt therefore meant the app never asked
 * again, and the only route left was Android Settings — exactly the symptom
 * reported from the device.
 *
 * Asking when the OS has permanently denied is harmless: requestPermissions()
 * resolves without showing anything.
 */
export function shouldRequestPermission(status) {
  const receive = status && status.receive;
  return receive !== 'granted';
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

// ---------------------------------------------------------------------------
// Android notification channel
// ---------------------------------------------------------------------------

// The server sends android.notification.channelId = this. It must exist before
// the first notification arrives, or FCM falls back to its auto-created
// "Miscellaneous" channel at IMPORTANCE_DEFAULT — the alert would land quietly
// in the tray under a meaningless heading. Note that the `priority: 'high'` the
// server sets governs FCM *transport* (waking the device from Doze); heads-up
// display, sound and lock-screen behaviour come from the channel alone.
export const FLOOD_CHANNEL_ID = 'theeram-flood-alerts';

export const FLOOD_CHANNEL = {
  id: FLOOD_CHANNEL_ID,
  // Name and description are shown verbatim in Android notification settings,
  // so they are written for the person reading them there.
  name: 'Flood alerts',
  description: 'Urgent rainfall and flood risk alerts for your saved places. '
    + 'These are rainfall-based estimates, not official forecasts.',
  importance: 5,    // IMPORTANCE_HIGH — heads-up. Fixed at creation; see below.
  visibility: 1,    // VISIBILITY_PUBLIC — a 3am alert is useless if the lock screen hides it.
  vibration: true,
  lights: true
};

function isAndroid() {
  return typeof window !== 'undefined' && window.Capacitor
    && typeof window.Capacitor.getPlatform === 'function'
    && window.Capacitor.getPlatform() === 'android';
}

let channelEnsured = false;

/**
 * Create the flood-alert channel. Android only, and safe to call repeatedly:
 * a module flag short-circuits within a session, and Android's own
 * createNotificationChannel is a no-op for an id that already exists.
 *
 * Importance cannot be RAISED after creation — only the user can, in Settings —
 * so this must be right the first time rather than tightened later.
 *
 * Never throws: a missing channel degrades the alert, it must not break sign-in.
 */
export async function ensureFloodChannel() {
  if (channelEnsured) return true;
  const plugin = pushPlugin();
  if (!plugin || !isAndroid() || typeof plugin.createChannel !== 'function') return false;
  try {
    await plugin.createChannel({ ...FLOOD_CHANNEL });
    channelEnsured = true;
    console.log('[push] notification channel ready:', FLOOD_CHANNEL_ID);
    return true;
  } catch (err) {
    console.warn('[push] could not create notification channel:', String(err && err.message || err));
    return false;
  }
}

// Last known state, surfaced for UI that wants to tell the user alerts are off.
export const pushState = {
  supported: false,
  permission: 'unknown',   // 'granted' | 'denied' | 'prompt' | 'unknown'
  registered: false,
  token: null,
  pendingProfile: false,
  error: null
};

let listenersBound = false;
let currentUid = null;
let currentKey = null;
// One permission prompt per app run. Retry triggers (profile saved, app
// resumed) must not re-prompt within the same session after a refusal.
let permissionRequestedThisSession = false;
let lastToken = null;

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

  // The profile document must already exist. Writing devices into a missing
  // one would CREATE it, and auth.js decides whether to show the profile gate
  // with snap.exists() — a half-made document would send a brand-new user
  // straight into the app with no name. Registration is retried on
  // theeram:profilesaved instead.
  if (!snap.exists()) {
    pushState.pendingProfile = true;
    return { key, written: false, deferred: true };
  }
  pushState.pendingProfile = false;

  const existing = (snap.data().devices || {})[key] || null;
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
    lastToken = token;
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

    // Before the permission branch on purpose. Creating a channel needs no
    // permission, and a user who denies in-app but later enables alerts from
    // Android Settings must still find a properly configured channel waiting.
    await ensureFloodChannel();

    let status = await plugin.checkPermissions();
    pushState.permission = status && status.receive;
    console.log('[push] checkPermissions ->', pushState.permission);

    if (shouldRequestPermission(status)) {
      // Ask whenever it is not already granted — see shouldRequestPermission().
      // Once per app session, so a denial does not re-prompt on every retry
      // trigger (resume, profile save) within the same run.
      if (permissionRequestedThisSession) {
        console.log('[push] already asked this session; not re-prompting');
        emit();
        return false;
      }
      permissionRequestedThisSession = true;
      console.log('[push] requesting notification permission…');
      status = await plugin.requestPermissions();
      pushState.permission = status && status.receive;
      console.log('[push] requestPermissions ->', pushState.permission);
    }

    if (!status || status.receive !== 'granted') {
      // A legitimate end state, not an error to retry around. The app must
      // never imply alerts are working when they are not.
      pushState.registered = false;
      emit();
      return false;
    }

    await plugin.register();   // resolves immediately; 'registration' fires later
    console.log('[push] register() called; awaiting registration event');
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

// Registration must not hang off a single cross-module event. push.js is a
// deferred module loaded after auth.js, so if theeram:authready were ever
// dispatched before this file finished evaluating, the listener would miss it
// and nothing would ever ask for permission — silently, for the life of the
// install. onAuthStateChanged has no such race: Firebase replays the current
// state to every listener as soon as it is added, however late.
onAuthStateChanged(auth, (user) => {
  if (!user) {
    currentUid = null;
    currentKey = null;
    lastToken = null;
    pushState.registered = false;
    pushState.token = null;
    emit();
    return;
  }
  currentUid = user.uid;
  // upsertDevice() defers if the profile document does not exist yet; the
  // profilesaved listener below picks it up.
  initPush();
});

// A brand-new user reaches the profile gate before a profile document exists,
// so the first registration attempt defers. Retry the moment it is created.
document.addEventListener('theeram:profilesaved', () => { retryRegistration(); });

// Recovery path. Covers the case that prompted this fix: someone who granted
// the permission in Android Settings rather than through the app comes back to
// a foregrounded WebView, and registration should then simply proceed.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') retryRegistration();
  });
}

/** Idempotent: re-runs only what is still outstanding. */
async function retryRegistration() {
  if (!currentUid) return;
  if (pushState.registered && !pushState.pendingProfile) return;
  // A token already in hand just needs storing — no need to re-register.
  if (lastToken) {
    try {
      const { key } = await upsertDevice(currentUid, lastToken);
      if (!pushState.pendingProfile) { currentKey = key; pushState.registered = true; emit(); }
      return;
    } catch (err) {
      console.warn('[push] retry store failed:', err && err.message);
    }
  }
  initPush();
}

// Exposed for the inline script and for manual checks from a device console.
// theeramPush.diagnose() prints why registration has not completed — the
// previous build failed silently on a real device, which is what made this
// hard to pin down.
if (typeof window !== 'undefined') {
  window.theeramPush = {
    initPush, unregisterDevice, isSupported, pushState, retryRegistration,
    ensureFloodChannel, FLOOD_CHANNEL_ID,
    async diagnose() {
      const plugin = pushPlugin();
      // Read the channel back from Android rather than trusting our own flag:
      // what matters is what the OS actually holds, importance included.
      let channel = null;
      try {
        if (plugin && typeof plugin.listChannels === 'function' && isAndroid()) {
          const { channels } = await plugin.listChannels();
          channel = (channels || []).find(c => c.id === FLOOD_CHANNEL_ID) || 'MISSING';
        }
      } catch (err) {
        channel = `ERROR: ${String(err && err.message || err)}`;
      }
      const d = {
        bridgePresent: !!(window.Capacitor && window.Capacitor.Plugins),
        pluginPresent: !!pushPlugin(),
        signedIn: !!(auth.currentUser && auth.currentUser.uid),
        profileExists: !pushState.pendingProfile,
        permission: pushState.permission,
        registered: pushState.registered,
        hasToken: !!pushState.token,
        askedThisSession: permissionRequestedThisSession,
        floodChannel: channel,
        error: pushState.error
      };
      console.log('[push] diagnose:', JSON.stringify(d, null, 2));
      return d;
    }
  };
}
