// Theeram — synthetic FCM delivery test.
//
// Creates ONE clearly-marked synthetic alertDecision for a single named test
// recipient, pushes it through the SAME production notification sender that
// real flood alerts use, and reports what happened at every stage.
//
// This file is never imported by monitor/index.js and never runs as part of
// the hourly workflow. It has to be invoked deliberately.
//
//   node monitor/test-fcm.js --production --confirm \
//        --uid=<uid> --family=<familyId> --location=<locationId>
//
// Safety properties, in order of how much they matter:
//
//   1. --confirm is mandatory. Without it nothing is written or sent.
//   2. Delivery is confined to --uid via the sender's restrictToUid option,
//      so other members of a real family cannot receive a test alert even
//      though the decision is filed under that family.
//   3. The uid must already be a member of the family. A typo therefore fails
//      closed rather than notifying somebody unrelated.
//   4. The decision is closed out (delivered:true, syntheticTest:true) whatever
//      the outcome, so the hourly production monitor never picks it up and
//      fans it out to everybody.
//   5. episodeId is TEST_FCM_<timestamp>, so a synthetic decision is obvious
//      in Firestore and can never collide with a real episode id.
//   6. No FCM token is ever printed, logged, or returned.

import { resolveTarget, initAdmin } from './admin.js';
import { createNotifier, notifyUndelivered, enabledDevices } from './notify.js';

export const SYNTHETIC_PREFIX = 'TEST_FCM_';

export function parseArgs(argv) {
  const get = (name) => {
    const hit = argv.find(a => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : null;
  };
  return {
    production: argv.includes('--production'),
    confirm: argv.includes('--confirm'),
    json: argv.includes('--json'),
    uid: get('uid') || process.env.THEERAM_TEST_UID || null,
    familyId: get('family') || process.env.THEERAM_TEST_FAMILY || null,
    locationId: get('location') || process.env.THEERAM_TEST_LOCATION || null,
    level: get('level') || 'Severe'
  };
}

/** Deterministic, obviously-synthetic decision id. */
export function syntheticDecisionId(locationId, episodeId, level) {
  return `${locationId}__${episodeId}__first__${level}`;
}

export function validate(args) {
  const problems = [];
  if (!args.confirm) problems.push('--confirm is required; this sends a real notification');
  if (!args.uid) problems.push('--uid=<uid> (or THEERAM_TEST_UID) is required');
  if (!args.familyId) problems.push('--family=<familyId> (or THEERAM_TEST_FAMILY) is required');
  if (!args.locationId) problems.push('--location=<locationId> (or THEERAM_TEST_LOCATION) is required');
  if (!['High', 'Severe'].includes(args.level)) problems.push('--level must be High or Severe');
  return problems;
}

const step = (ok, label, detail = '') =>
  `  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const problems = validate(args);
  if (problems.length) {
    console.error('[test-fcm] refusing to run:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exitCode = 2;
    return;
  }

  const target = resolveTarget(process.argv.slice(2));
  console.log(`[test-fcm] target=${target.production ? 'PRODUCTION' : 'emulator'} project=${target.projectId}`);
  const db = initAdmin(target);

  const results = [];
  const fail = (label, detail) => { results.push(step(false, label, detail)); };
  const pass = (label, detail) => { results.push(step(true, label, detail)); };

  // ---- 1. the recipient must really be a member of this family -----------
  const memberSnap = await db.collection('families').doc(args.familyId)
    .collection('members').doc(args.uid).get();
  if (!memberSnap.exists) {
    console.error(`[test-fcm] ${args.uid} is not a member of family ${args.familyId}; refusing.`);
    process.exitCode = 3;
    return;
  }
  pass('recipient is a member of the target family');

  // ---- 2. and must have at least one enabled device ----------------------
  const userSnap = await db.collection('users').doc(args.uid).get();
  const devices = userSnap.exists ? enabledDevices(userSnap.data()) : [];
  if (!devices.length) {
    console.error('[test-fcm] the test user has no enabled device registered; refusing.');
    console.error('[test-fcm] open the app, sign in, and allow notifications first.');
    process.exitCode = 4;
    return;
  }
  // Count only. Never the token, and never the sha256 device key.
  pass('device resolved', `${devices.length} enabled device(s)`);

  // ---- 3. create the synthetic decision ----------------------------------
  const episodeId = `${SYNTHETIC_PREFIX}${Date.now()}`;
  const decisionId = syntheticDecisionId(args.locationId, episodeId, args.level);
  const decidedAt = new Date().toISOString();

  await db.collection('alertDecisions').doc(decisionId).set({
    locationId: args.locationId,
    familyId: args.familyId,
    kind: 'first',
    level: args.level,
    band: args.level === 'Severe' ? 'severe' : 'high',
    episodeId,
    decidedAt,
    delivered: false,
    deliveredAt: null,
    syntheticTest: true,
    syntheticTargetUid: args.uid
  });
  pass('synthetic decision created', decisionId);

  // ---- 4. same sender production uses -----------------------------------
  const notifier = createNotifier({
    dryRun: false,
    getMessaging: async () => (await import('firebase-admin/messaging')).getMessaging()
  });

  let summary;
  try {
    summary = await notifyUndelivered({
      db, notifier,
      runId: `synthetic-${episodeId}`,
      restrictToUid: args.uid        // cannot reach anybody else
    });
  } catch (err) {
    fail('notification sender', String(err && err.message || err));
    summary = null;
  }

  if (summary) {
    if (summary.recipients >= 1) pass('recipient resolved by the sender');
    else fail('recipient resolved by the sender', 'no recipient was produced');

    if (summary.sent >= 1) pass('FCM API accepted the message', `sent=${summary.sent}`);
    else fail('FCM API accepted the message', `sent=0 failures=${summary.failures}`);
  }

  // ---- 5. close the decision out so production never re-sends it ---------
  // Whatever happened above, the hourly monitor must not pick this up and
  // deliver a fake flood alert to the rest of the family.
  try {
    await db.collection('alertDecisions').doc(decisionId).update({
      delivered: true,
      claimedAt: null,
      claimedBy: null,
      syntheticClosedAt: new Date().toISOString()
    });
    pass('decision closed out; the hourly monitor will ignore it');
  } catch (err) {
    fail('decision close-out', String(err && err.message || err));
  }

  const accepted = !!(summary && summary.sent >= 1);

  if (args.json) {
    console.log(JSON.stringify({ decisionId, episodeId, accepted, summary }, null, 2));
  } else {
    console.log('\n[test-fcm] results');
    for (const r of results) console.log(r);
    if (summary) {
      console.log(`\n[test-fcm] sender summary: ${JSON.stringify({
        recipients: summary.recipients, devices: summary.devices,
        sent: summary.sent, failures: summary.failures,
        delivered: summary.delivered, retained: summary.retained
      })}`);
    }
  }

  console.log(
    accepted
      ? '\n[test-fcm] FCM ACCEPTED the message.\n' +
        '[test-fcm] This does NOT prove the phone displayed it. Check the handset now:\n' +
        `[test-fcm]   expected title: a ${args.level} flood-risk alert\n` +
        '[test-fcm]   expected channel: Flood alerts (theeram-flood-alerts)\n'
      : '\n[test-fcm] FCM DID NOT ACCEPT the message. See the failures above.\n'
  );

  process.exitCode = accepted ? 0 : 1;
}

// Only run when invoked directly, so the pure helpers above stay importable.
if (process.argv[1] && process.argv[1].endsWith('test-fcm.js')) {
  main().catch((err) => {
    console.error('[test-fcm] FATAL:', String(err && err.message || err));
    process.exitCode = 1;
  });
}
