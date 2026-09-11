// Firebase Admin initialisation, and the boundary between emulator and
// production.
//
// PRODUCTION IS NEVER THE DEFAULT. Reaching the live project requires the
// explicit --production flag; without it the monitor points at the Firestore
// emulator and will refuse to start if one is not running. The Admin SDK
// bypasses security rules, so an accidental production run is an accidental
// privileged write against real family data.
//
// No credential is ever read from source. Production expects one of:
//   GOOGLE_APPLICATION_CREDENTIALS  path to a service-account JSON, or
//   FIREBASE_SERVICE_ACCOUNT        the JSON itself (for CI secret stores)
// and nothing is ever logged from either.

import { initializeApp, cert, applicationDefault, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

export const EMULATOR_PROJECT = 'demo-theeram';
export const PRODUCTION_PROJECT = 'theeram-18e35';
export const DEFAULT_EMULATOR_HOST = '127.0.0.1:8080';

export function resolveTarget(argv = [], env = process.env) {
  const production = argv.includes('--production');
  if (production) {
    return {
      production: true,
      projectId: env.THEERAM_PROJECT_ID || PRODUCTION_PROJECT,
      emulatorHost: null
    };
  }
  return {
    production: false,
    projectId: env.THEERAM_EMULATOR_PROJECT || EMULATOR_PROJECT,
    emulatorHost: env.FIRESTORE_EMULATOR_HOST || DEFAULT_EMULATOR_HOST
  };
}

export function initAdmin(target, env = process.env) {
  if (!target.production) {
    // Setting this before getFirestore() is what redirects the Admin SDK away
    // from the live project. A demo-* project id additionally guarantees the
    // SDK has no real backend to fall through to.
    env.FIRESTORE_EMULATOR_HOST = target.emulatorHost;
    if (!getApps().length) initializeApp({ projectId: target.projectId });
    return getFirestore();
  }

  // Production. Refuse to run without an explicit credential rather than
  // silently falling back to whatever ambient identity happens to exist.
  if (env.FIRESTORE_EMULATOR_HOST) {
    throw new Error('FIRESTORE_EMULATOR_HOST is set while --production was requested; refusing to run');
  }

  let credential;
  if (env.FIREBASE_SERVICE_ACCOUNT) {
    let parsed;
    try {
      parsed = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
    } catch {
      throw new Error('FIREBASE_SERVICE_ACCOUNT is set but is not valid JSON');
    }
    credential = cert(parsed);
  } else if (env.GOOGLE_APPLICATION_CREDENTIALS) {
    credential = applicationDefault();
  } else {
    throw new Error(
      'Production run requires GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_SERVICE_ACCOUNT. ' +
      'Never place a credential in source.'
    );
  }

  if (!getApps().length) initializeApp({ credential, projectId: target.projectId });
  return getFirestore();
}
