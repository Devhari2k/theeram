// Theeram — Google Sign-In, native on Android and popup in a browser.
//
// The decision logic is next door in google-auth-plan.js, which imports
// nothing and is unit-tested. This file is the I/O: the Capacitor bridge, the
// Firebase SDK, and nothing else.
//
// THE NATIVE FLOW, END TO END:
//
//   1. SocialLogin.initialize({ google: { webClientId } }) — once per session.
//      webClientId is the OAuth *web* client (client_type 3 in
//      google-services.json). That is not a mistake: Credential Manager uses
//      the web client as the token's audience, and matches the calling app by
//      its package name plus signing-certificate SHA-1 against the *Android*
//      client (client_type 1). Both must exist in the Firebase project.
//   2. SocialLogin.login({ provider: 'google' }) opens the system credential
//      sheet and returns an OpenID Connect ID token.
//   3. GoogleAuthProvider.credential(idToken) wraps it.
//   4. signInWithCredential(auth, credential) hands it to Firebase, which
//      verifies the signature, issuer, audience and expiry server-side and
//      then mints the session.
//
// Step 4 is the security boundary and it is unchanged from the popup flow —
// the same Firebase verification, the same session, the same Firestore rules.
// All the native path changes is how the ID token is obtained.
//
// In a plain browser window.Capacitor.Plugins.SocialLogin is undefined, so
// every entry point below falls back to the popup flow, which now works
// because firebase-init.js supplies a popupRedirectResolver.

import { auth, googleProvider, GOOGLE_WEB_CLIENT_ID } from './firebase-init.js';
import {
  GoogleAuthProvider, signInWithCredential, signInWithPopup,
  reauthenticateWithCredential, reauthenticateWithPopup
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-auth.js";
import {
  socialLoginBridge, hasNativeGoogleSignIn, pickIdToken, describeGoogleError
} from './google-auth-plan.js';

export {
  hasNativeGoogleSignIn, describeGoogleError
} from './google-auth-plan.js';

/**
 * initialize() is idempotent on the plugin side, but it crosses the bridge, so
 * the promise is cached. A failed initialize is NOT cached — the next attempt
 * retries rather than failing forever on one transient error.
 */
let initPromise = null;

async function ensureInitialized() {
  const plugin = socialLoginBridge();
  if (!plugin) throw new Error('Google Sign-In is not available on this platform.');
  if (!initPromise) {
    initPromise = plugin.initialize({ google: { webClientId: GOOGLE_WEB_CLIENT_ID } })
      .catch((err) => { initPromise = null; throw err; });
  }
  await initPromise;
  return plugin;
}

/**
 * Ask the platform for a fresh Google ID token.
 *
 * WHAT ACTUALLY GUARANTEES AN ACCOUNT CHOOSER ON ANDROID: `style`, and only
 * `style`. The plugin's GoogleProvider.java branches on it —
 *
 *   'standard' -> GetSignInWithGoogleOption   always shows the chooser
 *   'bottom'   -> GetGoogleIdOption           can setAutoSelectEnabled(true)
 *                                             and return an account silently
 *
 * so 'standard' is the load-bearing setting here and must not be changed to
 * 'bottom' without rethinking the deletion flow, which depends on the user
 * deliberately re-picking their account.
 *
 * The other three options are NOT what does the work on Android, despite
 * reading as though they might:
 *
 *   - autoSelectEnabled / filterByAuthorizedAccounts are consulted only inside
 *     the 'bottom' branch. They are pinned false anyway, so that switching
 *     `style` cannot quietly turn silent sign-in on as a side effect.
 *   - forcePrompt is iOS-only. `forceAccountChoice` therefore changes nothing
 *     on Android today; it is carried so the deletion path already asks for
 *     the stronger behaviour if and when iOS ships.
 */
async function nativeIdToken({ forceAccountChoice = false } = {}) {
  const plugin = await ensureInitialized();
  const login = await plugin.login({
    provider: 'google',
    options: {
      scopes: ['profile', 'email'],
      style: 'standard',
      autoSelectEnabled: false,
      filterByAuthorizedAccounts: false,
      forcePrompt: forceAccountChoice
    }
  });
  return { idToken: pickIdToken(login), login };
}

// ---------------------------------------------------------------------------
// Sign-in
// ---------------------------------------------------------------------------

/**
 * Sign in with Google. Native where available, popup otherwise.
 *
 * Returns the Firebase UserCredential. The caller does not create or update
 * any profile document: onAuthStateChanged in auth.js already does that for
 * every sign-in method, so a Google user goes through exactly the same
 * first-run profile screen as an email user.
 */
export async function signInWithGoogle() {
  if (!hasNativeGoogleSignIn()) {
    return signInWithPopup(auth, googleProvider);
  }
  const { idToken } = await nativeIdToken();
  const credential = GoogleAuthProvider.credential(idToken);
  return signInWithCredential(auth, credential);
}

// ---------------------------------------------------------------------------
// Reauthentication (account deletion)
// ---------------------------------------------------------------------------

/**
 * Re-confirm the signed-in Google user immediately before an irreversible act.
 *
 * This is a real reauthentication, not a relaxation of one. The ID token is
 * minted seconds earlier by Google, and reauthenticateWithCredential rejects
 * with auth/user-mismatch if it belongs to anyone other than the currently
 * signed-in account — so a second Google account on the device cannot be used
 * to authorise deleting the first.
 */
export async function reauthenticateWithGoogle(user) {
  const target = user || auth.currentUser;
  if (!target) throw new Error('You are not signed in.');

  if (!hasNativeGoogleSignIn()) {
    return reauthenticateWithPopup(target, googleProvider);
  }
  const { idToken } = await nativeIdToken({ forceAccountChoice: true });
  const credential = GoogleAuthProvider.credential(idToken);
  return reauthenticateWithCredential(target, credential);
}

/**
 * Best-effort: drop the native Google session so the next sign-in shows the
 * chooser again. Never allowed to fail the operation that called it — the
 * Firebase session is the one that matters.
 */
export async function signOutNativeGoogle() {
  try {
    const plugin = socialLoginBridge();
    if (plugin && typeof plugin.logout === 'function' && initPromise) {
      await plugin.logout({ provider: 'google' });
    }
  } catch (e) {
    /* ignored on purpose */
  }
}
