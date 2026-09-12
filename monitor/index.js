#!/usr/bin/env node
// Theeram background flood monitor — CLI entry point.
//
//   node monitor/index.js --dry-run          emulator, reports, writes nothing
//   node monitor/index.js                    emulator, writes
//   node monitor/index.js --production       LIVE project, writes
//   node monitor/index.js --production --dry-run   LIVE reads, writes nothing
//
// See monitor/README.md. Nothing is sent to users in this phase: alert
// decisions are logged and recorded in Firestore, never delivered.

import { resolveTarget, initAdmin } from './admin.js';
import { createWeatherClient } from './weather.js';
import { createNotifier } from './notify.js';
import { runOnce } from './run.js';

function parseArgs(argv) {
  return {
    dryRun: argv.includes('--dry-run'),
    production: argv.includes('--production'),
    json: argv.includes('--json')
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const target = resolveTarget(argv);

  console.log(`[monitor] target=${target.production ? 'PRODUCTION' : 'emulator'} ` +
              `project=${target.projectId} dryRun=${args.dryRun}`);
  if (target.production && !args.dryRun) {
    console.log('[monitor] WRITING TO THE LIVE PROJECT');
  }

  const db = initAdmin(target);
  const weather = createWeatherClient();

  // In dry-run the live Messaging object is never constructed: createNotifier
  // does not call getMessaging at all on that path.
  const notifier = createNotifier({
    dryRun: args.dryRun,
    getMessaging: async () => (await import('firebase-admin/messaging')).getMessaging()
  });

  const summary = await runOnce({ db, weather, dryRun: args.dryRun, notifier });

  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    const h = summary.heartbeat;
    console.log(`[monitor] status=${h.lastRunStatus} locations=${h.locationsChecked} ` +
                `cells=${h.cells} updated=${h.updated} unchanged=${h.unchanged} ` +
                `weatherFailures=${h.weatherFailures} locationFailures=${h.locationFailures} ` +
                `alertsWouldSend=${h.alertsWouldSend} durationMs=${h.durationMs}`);
    if (args.dryRun) {
      console.log(`[monitor] DRY RUN — ${summary.plannedWrites.length} document(s) would be written:`);
      for (const w of summary.plannedWrites) {
        console.log(`  ${w.familyId}/${w.locationId} -> ` + JSON.stringify({
          risk: w.payload.risk.level,
          rain: w.payload.rain,
          forecast: w.payload.forecast,
          band: w.payload.alertState.band
        }));
      }
      console.log(`[monitor] DRY RUN — ${summary.decisions.length} alert decision(s), 0 sent`);
      for (const d of summary.decisions) {
        console.log(`  ${d.kind} -> ${d.level} (episode ${d.episodeId})`);
      }
      if (summary.notifications) {
        const n = summary.notifications;
        console.log(`[monitor] DRY RUN — delivery: considered=${n.considered} claimable=${n.claimed} ` +
                    `recipients=${n.recipients} devices=${n.devices}, 0 notifications sent`);
      }
    }
  }

  // A degraded run is still a completed run; only a thrown error is a failure.
  process.exitCode = 0;
}

main().catch((err) => {
  // Message only — a stack can carry file paths and argument values.
  console.error('[monitor] FATAL:', String(err && err.message || err));
  process.exitCode = 1;
});
