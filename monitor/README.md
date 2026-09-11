# Theeram background flood monitor

Scheduled pass that recomputes flood risk for every saved location and decides
whether an alert *would* be sent.

**Nothing is delivered to users in this phase.** There is no FCM and no push.
Alert decisions are logged and written to `alertDecisions` with
`delivered: false`. Wiring delivery is a later phase; the detection logic here
does not change when it lands.

Scheduling is set up in `.github/workflows/monitor.yml` (hourly, authenticated
by Workload Identity Federation — no stored key). It is inert until that
workflow reaches the default branch: see [SCHEDULER.md](SCHEDULER.md).

> The risk model is a **rainfall-and-elevation proxy**, not a hydrological
> flood forecast. It has no river stage, reservoir level, soil moisture,
> drainage or tide input. Running it on a server makes it arrive reliably; it
> does not make it a prediction. Never present its output as an official
> warning.

## Running it

```bash
npm run monitor:dry          # emulator, reports what it WOULD do, writes nothing
npm run monitor              # emulator, writes
node monitor/index.js --production            # LIVE project, writes
node monitor/index.js --production --dry-run  # LIVE reads, writes nothing
node monitor/index.js --dry-run --json        # machine-readable summary
```

The emulator must already be running for the non-production modes:

```bash
npx firebase emulators:start --only firestore --project demo-theeram
```

## Production safety

Production is never the default. `--production` is required to reach the live
project, and the run then refuses to start unless a credential is supplied via
**`GOOGLE_APPLICATION_CREDENTIALS`** (path to a service-account JSON) or
**`FIREBASE_SERVICE_ACCOUNT`** (the JSON itself, for CI secret stores). No
credential is read from source, and neither variable is ever logged. A
production run also refuses to start if `FIRESTORE_EMULATOR_HOST` is set, so a
half-configured shell cannot silently split the difference.

## What it writes

The Admin SDK **bypasses Firestore security rules**, so the rules that stop a
client touching ownership fields do not constrain this process. The allowlist
in `fields.js` is therefore the actual control, and every write passes through
`assertServerOnly()` first.

| | Fields |
|---|---|
| Writable | `rain`, `forecast`, `risk`, `elevation`, `terrainType`, `alertState`, `lastCheckedAt`, `lastUpdated` |
| Refused | `ownerUid`, `name`, `lat`, `lon`, `createdAt` |

Writes happen **only when something changed** — the risk level moved, rainfall
moved by ≥0.05 mm, or an alert was decided. Rewriting every location every hour
would burn the Spark write quota for values nobody can see.

Also written: `system/monitorHeartbeat` (liveness) and `alertDecisions/{id}`.

## Layout

| File | Role |
|---|---|
| `index.js` | CLI entry, flag parsing, human/JSON output |
| `admin.js` | Admin SDK init; emulator/production boundary |
| `run.js` | one pass: read → group → fetch → compute → diff → transact → heartbeat |
| `alerts.js` | the state machine — pure, no I/O |
| `weather.js` | Open-Meteo batch fetch |
| `grid.js` | coordinate de-duplication |
| `fields.js` | server-controlled field allowlist |

Risk logic is **not** here. `computeRisk`, `summarizeRainfall` and
`classifyTerrain` are imported from `../www/js/risk.js`, the same module the
browser uses, so the alert you would receive and the risk the app shows cannot
drift apart.

## Alert state machine

Bands: `normal` (Minimal/Low/Moderate) · `high` (High) · `severe` (Severe).

| From → To | Decision |
|---|---|
| normal → high/severe | `first` — episode opens |
| high → severe | `escalation` — same episode |
| severe → high | *(silent state update)* |
| still elevated, ≥12 h since last | `sustained` |
| high/severe → normal | *(dwell opens — see below)* |
| normal held ≥3 h | `all_clear` — episode closes |
| normal → normal | *(nothing)* |

### Exit hysteresis

Entry is immediate; exit is not. When the level leaves the alert band the
episode enters a **clearing dwell** instead of ending: `clearingSince` is
stamped, the alert `band` is held at its previous value, and nothing is
decided. Only if the level stays out of the band for `clearDwellMs`
(default 3 h) does `all_clear` fire and the episode close.

Any elevated reading during the dwell cancels it. The episode simply
continues — no second `first`, and `episodeId` is unchanged — because from
the user's point of view the alert never ended.

Rainfall parked on a threshold crosses it repeatedly. Without this, r24
oscillating around 115.6 mm emitted an all-clear and a fresh alert every hour;
a test now pins that same 12-hour oscillation to exactly one notification.

The dwell is a duration rather than a run count, so a missed or delayed run
does not restart the clock. It is also not conditioned on the level falling
further (e.g. all the way to Minimal), because risk that plateaus at Moderate
would then never clear and the episode would be stuck open forever.

The sustained-reminder cooldown is measured from the last *decision*, so a dip
and recovery cannot be used to trigger an early reminder.

`episodeId` is fixed when an episode opens and is part of each decision's
document id, so re-deciding the same transition **overwrites** rather than
appending. Combined with the per-location Firestore transaction in `run.js`,
overlapping runs cannot double-alert. Cron schedules do overlap in practice —
a slow run, or a manual run beside a scheduled one — so this is not theoretical.

## Failure behaviour

A failed Open-Meteo batch or location is counted and skipped; the pass
continues and the heartbeat reports `degraded`. **Stale risk is retained rather
than cleared** — a missing forecast must never read as "the risk has passed".

## Logging

Ids and counts only. Never coordinates, family or member names, device tokens,
credentials, or any personal data — the repository is public and CI logs on a
public repo are publicly readable.

## Not yet done

- No FCM / push delivery
- The scheduler exists but is inert until `monitor.yml` is on the default
  branch, and until the two GCP secrets are configured (SCHEDULER.md)
- Client `checkFamilyRiskOnce()` still runs; its cross-member write is removed
  only once the monitor is proven
- No Firestore rules change (device-token storage needs one; see Phase 2.3 §10)
