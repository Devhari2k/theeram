// Theeram Cloud Functions — the Auth deletion trigger.
//
// Fires after Firebase Auth removes an account, whether the user deleted it
// themselves in the app or an operator removed it from the console. The
// in-app flow (www/js/account-delete.js) deletes the Auth account LAST,
// precisely so this trigger runs once the client has already cleared
// everything it was permitted to clear.
//
// This is a 1st-generation trigger: `functions.auth.user().onDelete()` is the
// only native Firebase Auth deletion hook. There is no 2nd-gen equivalent.
//
// REQUIRES THE BLAZE PLAN. Cloud Functions cannot be deployed on Spark. See
// functions/README.md for what to do if the project stays on Spark.

import functions from 'firebase-functions/v1';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

import { purgeDeletedUser } from './purge.js';

if (!getApps().length) initializeApp();
const db = getFirestore();

// Asia South 1 (Mumbai) — the users are in Kerala and the data is theirs.
const REGION = 'asia-south1';

export const onUserDeleted = functions
  .region(REGION)
  .runWith({ timeoutSeconds: 540, memory: '256MB' })
  .auth.user()
  .onDelete(async (user) => {
    // Throwing makes Cloud Functions retry, and every operation the purge
    // emits is idempotent, so a retry is always safe. Swallowing the error
    // would silently leave a deleted user's rows behind — the one outcome
    // this function exists to prevent.
    return purgeDeletedUser(db, user.uid, { logger: functions.logger });
  });
