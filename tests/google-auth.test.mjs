// Theeram — native Google Sign-In.
// Run with: npm run test:google
//
// The decision half lives in www/js/google-auth-plan.js, which imports
// nothing, so it is imported here directly. The I/O half (google-auth.js)
// pulls Firebase from a CDN and the plugin from the Capacitor bridge, so it is
// exercised by source assertions — the same split account-delete.test.mjs uses.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import {
  SOCIAL_LOGIN_PLUGIN, socialLoginBridge, hasNativeGoogleSignIn,
  pickIdToken, looksLikeJwt, googleProfileHints,
  classifyGoogleError, googleErrorMessage, describeGoogleError
} from '../www/js/google-auth-plan.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const GLUE = read('www/js/google-auth.js');
const INIT = read('www/js/firebase-init.js');
const AUTH = read('www/js/auth.js');
const DELETE = read('www/js/account-delete.js');
const INDEX = read('www/index.html');

// A structurally valid JWT. Not signed, never verified here — Firebase does
// that server-side. It only has to survive the shape check.
const JWT = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJl';

const win = (plugins) => ({ Capacitor: { Plugins: plugins || {} } });

// ---------------------------------------------------------------------------
describe('finding the plugin without a bundler', () => {
  test('it is reached through window.Capacitor.Plugins', () => {
    const plugin = { login: () => {} };
    assert.equal(socialLoginBridge(win({ SocialLogin: plugin })), plugin);
  });

  test('the bridge name matches the @CapacitorPlugin annotation', () => {
    assert.equal(SOCIAL_LOGIN_PLUGIN, 'SocialLogin');
  });

  test('a plain browser yields null, not a throw', () => {
    assert.equal(socialLoginBridge({}), null);
    assert.equal(socialLoginBridge({ Capacitor: {} }), null);
    assert.equal(socialLoginBridge(win({})), null);
    assert.equal(hasNativeGoogleSignIn({}), false);
  });

  test('hasNativeGoogleSignIn is true only with the plugin present', () => {
    assert.equal(hasNativeGoogleSignIn(win({ SocialLogin: {} })), true);
    assert.equal(hasNativeGoogleSignIn(win({ PushNotifications: {} })), false);
  });
});

// ---------------------------------------------------------------------------
describe('reading the ID token out of a login result', () => {
  test('the online response yields its idToken', () => {
    const login = { provider: 'google', result: { responseType: 'online', idToken: JWT, profile: {} } };
    assert.equal(pickIdToken(login), JWT);
  });

  test('the offline response is refused with a message naming the cause', () => {
    // serverAuthCode needs a backend to exchange it. Theeram has none, so
    // passing it to Firebase would fail much later as invalid-credential.
    const login = { result: { responseType: 'offline', serverAuthCode: 'abc' } };
    assert.throws(() => pickIdToken(login), /offline mode/i);
  });

  test('a null idToken is refused rather than forwarded', () => {
    // Credential Manager can authorise API scopes without authenticating a
    // user, and returns idToken: null when it does.
    const login = { result: { responseType: 'online', idToken: null, profile: {} } };
    assert.throws(() => pickIdToken(login), /did not return an ID token/i);
  });

  test('a malformed token is refused', () => {
    for (const bad of ['', 'not-a-jwt', 'only.two', 'a..c', 12345, {}]) {
      assert.throws(() => pickIdToken({ result: { responseType: 'online', idToken: bad } }),
        /ID token/i, `accepted ${JSON.stringify(bad)}`);
    }
  });

  test('an empty result is refused', () => {
    assert.throws(() => pickIdToken(null), /no result/i);
    assert.throws(() => pickIdToken({}), /no result/i);
  });

  test('looksLikeJwt is a shape check only, and says so in its own name', () => {
    assert.equal(looksLikeJwt(JWT), true);
    assert.equal(looksLikeJwt('a.b.c'), true);
    assert.equal(looksLikeJwt('a.b'), false);
    assert.equal(looksLikeJwt('a.b.c.d'), false);
  });

  test('profile hints are extracted, with a fallback to given + family name', () => {
    assert.deepEqual(
      googleProfileHints({ result: { profile: { name: 'Asha R', email: 'a@b.com', imageUrl: 'u' } } }),
      { name: 'Asha R', email: 'a@b.com', photoURL: 'u' });
    assert.equal(
      googleProfileHints({ result: { profile: { givenName: 'Asha', familyName: 'R' } } }).name, 'Asha R');
    assert.deepEqual(googleProfileHints({}), { name: null, email: null, photoURL: null });
  });
});

// ---------------------------------------------------------------------------
describe('classifying what went wrong', () => {
  const cases = [
    // Cancellation — from the plugin, from Credential Manager, from Firebase.
    [{ code: 'USER_CANCELLED' }, 'cancelled'],
    [{ message: 'GetCredentialCancellationException: activity is cancelled by the user.' }, 'cancelled'],
    [{ code: 'auth/popup-closed-by-user' }, 'cancelled'],
    [{ code: 'auth/cancelled-popup-request' }, 'cancelled'],
    [{ message: '16: Cancelled by user' }, 'cancelled'],
    // No usable account on the device.
    [{ message: 'androidx.credentials.exceptions.NoCredentialException: No credentials available' }, 'no-account'],
    // Misconfiguration — the SHA-1 of the signing cert is not registered.
    [{ message: '10: Developer console is not set up correctly.' }, 'config'],
    [{ message: 'DEVELOPER_ERROR' }, 'config'],
    // Firebase refused the token.
    [{ code: 'auth/invalid-credential' }, 'rejected'],
    [{ code: 'auth/operation-not-allowed' }, 'rejected'],
    [{ code: 'auth/account-exists-with-different-credential' }, 'different-credential'],
    [{ code: 'auth/user-mismatch' }, 'user-mismatch'],
    [{ code: 'auth/network-request-failed' }, 'network'],
    [{ message: 'Google Play services is missing' }, 'unavailable'],
    [{ code: 'auth/internal-error' }, 'unknown'],
    [new Error('something else entirely'), 'unknown']
  ];

  for (const [err, expected] of cases) {
    test(`${JSON.stringify(err.code || err.message).slice(0, 52)} -> ${expected}`, () => {
      assert.equal(classifyGoogleError(err), expected);
    });
  }

  test('null and undefined do not throw', () => {
    assert.equal(classifyGoogleError(null), 'unknown');
    assert.equal(classifyGoogleError(undefined), 'unknown');
  });
});

// ---------------------------------------------------------------------------
describe('what the user is told', () => {
  test('cancellation says nothing at all', () => {
    // Dismissing the sheet is a choice, not an error. Any sentence here would
    // read as an accusation.
    assert.equal(googleErrorMessage('cancelled'), '');
    assert.equal(describeGoogleError({ code: 'USER_CANCELLED' }).message, '');
  });

  test('every other kind produces a non-empty sentence', () => {
    for (const kind of ['no-account', 'config', 'rejected', 'different-credential',
                        'user-mismatch', 'network', 'unavailable', 'unknown']) {
      const msg = googleErrorMessage(kind);
      assert.ok(msg.length > 10, `${kind} has no usable message`);
      assert.ok(/[.!]$/.test(msg), `${kind} message is not a sentence: ${msg}`);
    }
  });

  test('no message leaks a raw error code or stack at the user', () => {
    for (const kind of ['no-account', 'config', 'rejected', 'different-credential',
                        'user-mismatch', 'network', 'unavailable', 'unknown']) {
      const msg = googleErrorMessage(kind);
      assert.ok(!/auth\/|exception|androidx|com\.google/i.test(msg),
        `${kind} leaks an internal identifier: ${msg}`);
    }
  });

  test('a missing Google account points at the alternative that works', () => {
    assert.match(googleErrorMessage('no-account'), /email and password/i);
    assert.match(googleErrorMessage('unavailable'), /email and password/i);
  });

  test('the reauth wording differs where it matters', () => {
    // "Choose the account you are signed in as" only makes sense mid-deletion.
    assert.notEqual(googleErrorMessage('user-mismatch', { context: 'reauth' }),
                    googleErrorMessage('user-mismatch', { context: 'signin' }));
    assert.match(googleErrorMessage('user-mismatch', { context: 'reauth' }), /signed in as/i);
  });
});

// ---------------------------------------------------------------------------
describe('the I/O half is wired the way the flow requires', () => {
  test('the ID token becomes a Firebase credential, not a session of its own', () => {
    assert.match(GLUE, /GoogleAuthProvider\.credential\(idToken\)/,
      'the native token must be wrapped as a Firebase credential');
    assert.match(GLUE, /signInWithCredential\(auth, credential\)/,
      'Firebase must mint the session, so it verifies the token server-side');
  });

  test('signInWithPopup survives only as the browser fallback', () => {
    assert.ok(GLUE.includes('signInWithPopup'), 'the browser path is gone');
    assert.match(GLUE, /if \(!hasNativeGoogleSignIn\(\)\) \{\s*\n\s*return signInWithPopup/,
      'the popup must be reached only when the native bridge is absent');
  });

  test('no Firebase token verification is done on the client', () => {
    // Deciding for ourselves that a token is good would be the one change that
    // actually weakens this. The shape check is explicitly not verification.
    for (const bad of ['jwt.verify', 'decodeIdToken', 'atob(', 'JSON.parse(payload']) {
      assert.ok(!GLUE.includes(bad), `google-auth.js appears to inspect the token: ${bad}`);
    }
  });

  test('the web client id is the audience, and is not a secret pretending otherwise', () => {
    assert.match(GLUE, /webClientId: GOOGLE_WEB_CLIENT_ID/);
    assert.match(INIT, /export const GOOGLE_WEB_CLIENT_ID/);
  });

  test('initializeAuth supplies a popupRedirectResolver', () => {
    // Without it signInWithPopup and reauthenticateWithPopup throw
    // auth/argument-error before any network call — on every platform.
    assert.match(INIT, /popupRedirectResolver: browserPopupRedirectResolver/);
    assert.match(INIT, /browserPopupRedirectResolver/);
  });

  test('the persistence chain is unchanged', () => {
    assert.match(INIT,
      /persistence: \[indexedDBLocalPersistence, browserLocalPersistence, inMemoryPersistence\]/,
      'session persistence is a separate, already-solved problem — do not disturb it');
  });
});

// ---------------------------------------------------------------------------
describe('email and password authentication is untouched', () => {
  test('both entry points still call the Firebase email APIs directly', () => {
    assert.match(AUTH, /await signInWithEmailAndPassword\(auth, email, password\)/);
    assert.match(AUTH, /await createUserWithEmailAndPassword\(auth, email, password\)/);
  });

  test('the email error messages are still mapped by friendlyAuthError', () => {
    for (const code of ['auth/invalid-credential', 'auth/user-not-found',
                        'auth/email-already-in-use', 'auth/weak-password']) {
      assert.ok(AUTH.includes(code), `friendlyAuthError no longer handles ${code}`);
    }
  });

  test('password reauthentication for deletion is unchanged', () => {
    assert.match(DELETE, /EmailAuthProvider\.credential\(user\.email, password\)/);
    assert.match(DELETE, /await reauthenticateWithCredential\(user, cred\)/);
  });
});

// ---------------------------------------------------------------------------
describe('Google account deletion is possible and still properly confirmed', () => {
  test('the dead "go and use a browser" path is gone', () => {
    // It told Google users to leave the app, which meant they could not delete
    // their account from the app at all — a Play policy problem.
    assert.ok(!DELETE.includes('Open Theeram in your browser and delete your account there'),
      'the browser-only deletion dead end is back');
    // A call site, not the word — the comment above the new code names the old
    // function to explain what replaced it, and that is worth keeping.
    assert.ok(!/reauthenticateWithPopup\s*\(/.test(DELETE),
      'account-delete.js should reauthenticate through google-auth.js, not the popup');
    assert.ok(!/^\s*EmailAuthProvider[^\n]*reauthenticateWithPopup/m.test(DELETE),
      'reauthenticateWithPopup is still imported into account-delete.js');
  });

  test('it reauthenticates through the native flow', () => {
    assert.match(DELETE, /await reauthenticateWithGoogle\(user\)/);
  });

  test('reauthentication still goes through Firebase, with a fresh credential', () => {
    assert.match(GLUE, /reauthenticateWithCredential\(target, credential\)/,
      'reauth must be verified by Firebase, not asserted by the client');
  });

  test("the account chooser is guaranteed by style: 'standard', the one option that does it", () => {
    // The plugin's GoogleProvider.java branches on `style` and nothing else:
    //   'standard' -> GetSignInWithGoogleOption, which always shows the chooser
    //   'bottom'   -> GetGoogleIdOption, which is the builder that can
    //                 setAutoSelectEnabled(true) and return an account with no
    //                 interaction at all.
    // Switching to 'bottom' would make deletion confirmable without the user
    // choosing anything, so it is pinned here rather than left to review.
    assert.match(GLUE, /style: 'standard'/,
      "the native login must request style 'standard'");
    assert.ok(!/style:\s*['"]bottom['"]/.test(GLUE),
      "style 'bottom' can auto-select an account, which would make reauthentication silent");
  });

  test('the auto-select flags stay pinned off, so switching style cannot silently enable it', () => {
    // Both are read only inside the 'bottom' branch, so they are inert today.
    // They are asserted because they are the second line of defence if anyone
    // ever does change `style`.
    assert.match(GLUE, /autoSelectEnabled: false/);
    assert.match(GLUE, /filterByAuthorizedAccounts: false/);
  });

  test('deletion asks for the stronger iOS behaviour too', () => {
    // forcePrompt is iOS-only, so this changes nothing on Android. It is
    // asserted so the deletion path does not lose it if iOS ships later.
    assert.match(GLUE, /nativeIdToken\(\{ forceAccountChoice: true \}\)/,
      'the deletion path should still request forcePrompt for iOS');
    assert.match(GLUE, /forcePrompt: forceAccountChoice/);
  });

  test('nothing destructive can run before reauthentication', () => {
    const body = DELETE.slice(DELETE.indexOf('export async function deleteAccount'));
    const reauth = body.indexOf('await reauthenticate(');
    const purge = body.indexOf('await purgeFirestoreData(');
    const del = body.indexOf('await deleteUser(');
    assert.ok(reauth > -1 && purge > reauth && del > purge,
      'the reauthenticate -> purge -> delete order has been disturbed');
  });

  test('a cancelled confirmation says the account was NOT deleted', () => {
    assert.match(DELETE, /Confirmation cancelled\. Your account has not been deleted\./);
  });

  test('the dialog warns Google users what confirming will involve', () => {
    assert.match(INDEX, /id="deleteAccountGoogleNote"/);
    assert.match(DELETE, /googleNote\.style\.display = usesPassword \? 'none' : 'block'/);
  });
});

// ---------------------------------------------------------------------------
describe('the button is still there, and still wired', () => {
  test('the UI keeps the Google option', () => {
    assert.match(INDEX, /id="googleSignIn"/);
    assert.match(INDEX, /Continue with Google/);
  });

  test('the click handler calls the new flow', () => {
    assert.match(AUTH, /await signInWithGoogle\(\)/);
    assert.ok(!AUTH.includes('signInWithPopup'),
      'auth.js should delegate the platform choice to google-auth.js');
  });

  test('sign-out clears the native Google session too', () => {
    assert.match(AUTH, /await signOutNativeGoogle\(\)/);
  });
});

// ---------------------------------------------------------------------------
describe('the Capacitor and Firebase configuration agrees with the code', () => {
  const capConfig = JSON.parse(read('capacitor.config.json'));

  test('the package id is unchanged', () => {
    assert.equal(capConfig.appId, 'com.theeram.app');
  });

  test('only the Google provider is compiled in', () => {
    // Every other provider drags in an SDK the privacy policy says is absent.
    // false maps to compileOnly, so those classes never reach the APK.
    const providers = capConfig.plugins.SocialLogin.providers;
    assert.equal(providers.google, true);
    for (const other of ['facebook', 'apple', 'twitter']) {
      assert.equal(providers[other], false, `${other} would be packaged into the APK`);
    }
  });

  test('push notification configuration is untouched', () => {
    assert.deepEqual(capConfig.plugins.PushNotifications.presentationOptions,
      ['alert', 'badge', 'sound']);
  });

  test('the plugin is a real dependency, not a dev one', () => {
    const pkg = JSON.parse(read('package.json'));
    assert.ok(pkg.dependencies['@capgo/capacitor-social-login'],
      'the plugin ships in the app, so it belongs in dependencies');
  });

  // google-services.json carries real client ids and is gitignored, so this
  // runs only where it exists — a developer machine and any build host.
  const gsPath = new URL('../android/app/google-services.json', import.meta.url);
  const hasGs = existsSync(gsPath);

  test('the hard-coded web client id matches google-services.json', { skip: !hasGs && 'no google-services.json' }, () => {
    const gs = JSON.parse(readFileSync(gsPath, 'utf8'));
    const web = gs.client
      .flatMap(c => c.oauth_client || [])
      .filter(o => o.client_type === 3)
      .map(o => o.client_id);
    const inCode = INIT.match(/GOOGLE_WEB_CLIENT_ID\s*=\s*\n?\s*'([^']+)'/);
    assert.ok(inCode, 'GOOGLE_WEB_CLIENT_ID is not a plain string literal any more');
    assert.ok(web.includes(inCode[1]),
      `firebase-init.js uses a web client id that is not in google-services.json: ${inCode[1]}`);
  });

  test('an Android OAuth client exists for this package', { skip: !hasGs && 'no google-services.json' }, () => {
    // Without a client_type 1 entry bound to the signing certificate's SHA-1,
    // Credential Manager returns no ID token and sign-in fails with a bare 10:.
    const gs = JSON.parse(readFileSync(gsPath, 'utf8'));
    const android = gs.client
      .flatMap(c => c.oauth_client || [])
      .filter(o => o.client_type === 1);
    assert.ok(android.length >= 1, 'no Android OAuth client in google-services.json');
    for (const o of android) {
      assert.equal(o.android_info.package_name, 'com.theeram.app');
      assert.match(o.android_info.certificate_hash, /^[0-9a-f]{40}$/,
        'certificate_hash is not a SHA-1 fingerprint');
    }
  });
});
