// Theeram — Google Sign-In decisions, with no I/O.
//
// This module imports nothing, so tests/google-auth.test.mjs can import it in
// Node. Everything that touches the Capacitor bridge, the Firebase SDK or the
// DOM lives in google-auth.js beside it.
//
// WHY THERE ARE TWO PATHS AT ALL.  Google's OAuth servers refuse to run the
// consent screen inside an embedded WebView (the `disallowed_useragent`
// policy), and Capacitor's WebChromeClient does not implement onCreateWindow,
// so window.open — which the Firebase popup flow depends on — returns null.
// The packaged Android app therefore cannot use signInWithPopup at all. It
// asks the platform for an ID token through Credential Manager instead and
// hands that to Firebase. A plain browser has none of these constraints, so it
// keeps the popup flow.
//
// Whichever path runs, Firebase does the actual authentication: the ID token
// is verified by Google's servers against the project's OAuth clients before a
// session exists. The native path is not a shortcut around Firebase Auth.

/** The Capacitor bridge name the plugin registers under (@CapacitorPlugin). */
export const SOCIAL_LOGIN_PLUGIN = 'SocialLogin';

/**
 * The plugin object, or null in a plain browser.
 *
 * Deliberately reached through window.Capacitor.Plugins rather than
 * `import { SocialLogin } from '@capgo/capacitor-social-login'`: Theeram has
 * no bundler, so a bare package specifier would not resolve in the WebView.
 * This is the same access path push.js already uses.
 */
export function socialLoginBridge(win) {
  const w = win || (typeof window !== 'undefined' ? window : null);
  return (w && w.Capacitor && w.Capacitor.Plugins &&
          w.Capacitor.Plugins[SOCIAL_LOGIN_PLUGIN]) || null;
}

/** True when the native Google flow is both possible and preferable. */
export function hasNativeGoogleSignIn(win) {
  return socialLoginBridge(win) !== null;
}

// ---------------------------------------------------------------------------
// Reading the plugin's answer
// ---------------------------------------------------------------------------

/**
 * Pull the OpenID Connect ID token out of a login result.
 *
 * Three shapes have to be rejected rather than passed on to Firebase, because
 * each produces a confusing auth/invalid-credential several layers later:
 *
 *   - the 'offline' response, which carries a serverAuthCode and no ID token.
 *     That mode exists for backends that exchange the code themselves; Theeram
 *     has no such backend, so seeing it means the plugin was misconfigured.
 *   - idToken: null, which Credential Manager can return when it authorises
 *     API scopes without authenticating a user.
 *   - anything that is not a three-part JWT.
 */
export function pickIdToken(login) {
  const result = (login && login.result) || null;
  if (!result) {
    throw new Error('Google sign-in returned no result.');
  }
  if (result.responseType === 'offline' || result.serverAuthCode) {
    throw new Error(
      'Google sign-in is configured for offline mode, which returns no ID ' +
      'token. Theeram signs in on the device and needs online mode.'
    );
  }
  const token = result.idToken;
  if (typeof token !== 'string' || !looksLikeJwt(token)) {
    throw new Error('Google did not return an ID token for this account.');
  }
  return token;
}

/**
 * A structural check only — three non-empty dot-separated segments.
 *
 * This is NOT verification and must never be treated as such. The signature,
 * issuer, audience and expiry are checked by Firebase's servers when the
 * credential is redeemed. The check here exists so an obviously malformed
 * value fails here, with a readable message, instead of inside the SDK.
 */
export function looksLikeJwt(token) {
  if (typeof token !== 'string') return false;
  const parts = token.split('.');
  return parts.length === 3 && parts.every(p => p.length > 0);
}

/** The display name and photo Google supplied, for prefilling the profile. */
export function googleProfileHints(login) {
  const p = (login && login.result && login.result.profile) || {};
  return {
    name: p.name || [p.givenName, p.familyName].filter(Boolean).join(' ') || null,
    email: p.email || null,
    photoURL: p.imageUrl || null
  };
}

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

/**
 * Reduce anything thrown by the plugin or by Firebase to one of a small set of
 * kinds. Both sources are handled here because the caller cannot tell which
 * layer failed, and the user does not care.
 *
 * 'cancelled' is separated out because it is not an error: someone dismissed a
 * sheet. The UI shows nothing at all for it.
 */
export function classifyGoogleError(err) {
  const code = String((err && err.code) || '');
  const msg = String((err && err.message) || err || '');
  const hay = `${code} ${msg}`.toLowerCase();

  // The plugin's own cancellation code, plus Firebase's popup equivalents.
  if (code === 'USER_CANCELLED') return 'cancelled';
  if (/popup-closed-by-user|cancelled-popup-request|user-cancelled/.test(hay)) return 'cancelled';
  // Credential Manager cancellation, and the bare status codes Play Services
  // surfaces when a sheet is dismissed.
  if (/getcredentialcancellation|activity is cancelled|\bcanceled\b|\bcancelled\b/.test(hay)) return 'cancelled';
  if (/\b(?:16|12501):/.test(hay)) return 'cancelled';

  // No Google account on the device, or none the user is willing to use.
  if (/nocredentialexception|no credentials available|no google accounts|10:.*account/.test(hay)) {
    return 'no-account';
  }

  // DEVELOPER_ERROR. Almost always the signing certificate's SHA-1 is not
  // registered for this package, or the web client id is wrong.
  if (/\b10:/.test(hay) || /developer_error|api_not_connected/.test(hay)) return 'config';

  // Firebase rejected the token, or the project is not set up for Google.
  if (/invalid-credential|operation-not-allowed|invalid-idp-response/.test(hay)) return 'rejected';

  // The same email already has a password account.
  if (/account-exists-with-different-credential/.test(hay)) return 'different-credential';

  // Reauthentication against the wrong account.
  if (/user-mismatch/.test(hay)) return 'user-mismatch';

  if (/network|timeout|unreachable|failed to connect|econn/.test(hay)) return 'network';

  // Play Services missing or too old — common on de-Googled and emulator images.
  if (/play services|play_services|service_disabled|service_missing/.test(hay)) return 'unavailable';

  return 'unknown';
}

/**
 * The sentence shown to the user. '' means show nothing — used for deliberate
 * cancellation, where any message would be noise.
 */
export function googleErrorMessage(kind, { context = 'signin' } = {}) {
  const confirming = context === 'reauth';
  switch (kind) {
    case 'cancelled':
      return '';
    case 'no-account':
      return 'No Google account is available on this device. Add one in Android Settings, or use email and password.';
    case 'config':
      return 'Google Sign-In is not set up for this build of Theeram. Please use email and password, or report this.';
    case 'rejected':
      return 'Google could not confirm that account. Please try again.';
    case 'different-credential':
      return 'An account already exists with that email address. Sign in with your email and password instead.';
    case 'user-mismatch':
      return confirming
        ? 'That is a different Google account. Choose the account you are signed in as.'
        : 'That Google account does not match the signed-in account.';
    case 'network':
      return 'No connection to Google. Check your network and try again.';
    case 'unavailable':
      return 'Google Play services is unavailable on this device, so Google Sign-In cannot run. Please use email and password.';
    default:
      return confirming
        ? 'Could not confirm your Google account. Please try again.'
        : 'Google Sign-In did not complete. Please try again, or use email and password.';
  }
}

/** Convenience: classify and render in one step. */
export function describeGoogleError(err, opts) {
  const kind = classifyGoogleError(err);
  return { kind, message: googleErrorMessage(kind, opts) };
}
