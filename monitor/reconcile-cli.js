// Theeram — CLI for the account-deletion reconciler.
//
//   node monitor/reconcile-cli.js                        emulator, dry run
//   node monitor/reconcile-cli.js --confirm              emulator, writes
//   node monitor/reconcile-cli.js --production           LIVE reads, writes nothing
//   node monitor/reconcile-cli.js --production --confirm LIVE, writes
//
// DRY RUN IS THE DEFAULT, unlike monitor/index.js. This job deletes data, and
// monitor/test-fcm.js already sets the precedent that a destructive command
// must be armed explicitly. DRY_RUN=false is accepted as an equivalent to
// --confirm so a workflow can toggle it from the environment.
//
// Credentials come from monitor/admin.js exactly as the monitor's do:
// GOOGLE_APPLICATION_CREDENTIALS (what the WIF step writes) or
// FIREBASE_SERVICE_ACCOUNT. No credential is ever read from source.

import { resolveTarget, initAdmin } from './admin.js';
import { reconcileUsers, MAX_DEPARTED_PER_RUN } from './reconcile.js';

export function parseArgs(argv, env = process.env) {
  const confirmed = argv.includes('--confirm') || String(env.DRY_RUN || '').toLowerCase() === 'false';
  const maxArg = argv.find(a => a.startsWith('--max='));
  return {
    production: argv.includes('--production'),
    dryRun: !confirmed,
    json: argv.includes('--json'),
    max: maxArg ? Number(maxArg.slice('--max='.length)) : MAX_DEPARTED_PER_RUN
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);

  if (!Number.isFinite(args.max) || args.max <= 0) {
    console.error('[reconcile] --max must be a positive number');
    process.exitCode = 2;
    return;
  }

  const target = resolveTarget(argv);
  console.log(`[reconcile] target=${target.production ? 'PRODUCTION' : 'emulator'} ` +
              `project=${target.projectId} dryRun=${args.dryRun}`);
  if (target.production && !args.dryRun) console.log('[reconcile] WRITING TO THE LIVE PROJECT');

  const db = initAdmin(target);
  // Imported lazily so a dry run against a project with no Auth access still
  // reaches the point where it can report that, rather than failing at load.
  const { getAuth } = await import('firebase-admin/auth');
  const auth = getAuth();

  const summary = await reconcileUsers({ db, auth, dryRun: args.dryRun, max: args.max });

  if (args.json) console.log(JSON.stringify(summary, null, 2));

  // A run that refused to purge is not a success: it means the live Auth set
  // could not be trusted, and a green tick would hide that.
  if (summary.aborted) {
    console.error(`[reconcile] FAILED: ${summary.abortReason}`);
    process.exitCode = 1;
    return;
  }
  if (summary.deferredCount) {
    console.log(`[reconcile] ${summary.deferredCount} departed uid(s) deferred to the next run (--max=${args.max})`);
  }
  process.exitCode = 0;
}

if (process.argv[1] && process.argv[1].endsWith('reconcile-cli.js')) {
  main().catch((err) => {
    console.error('[reconcile] FATAL:', String((err && err.message) || err));
    process.exitCode = 1;
  });
}
