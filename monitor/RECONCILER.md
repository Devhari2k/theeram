# Account-deletion reconciler

Cleans up the Firestore references a deleted account leaves behind in
collections no client is allowed to touch.

## Why not Cloud Functions

The obvious implementation is `functions.auth.user().onDelete()`, which fires
the instant an account is removed. It is a **1st-generation Cloud Function**,
and there is no 2nd-generation equivalent — no other native Firebase Auth
deletion hook exists.

**Cloud Functions cannot be deployed on the Spark plan.** Theeram stays on
Spark deliberately: the target is ₹0 recurring Firebase and Google Cloud cost.
Upgrading to Blaze to run one function that fires a handful of times a year is
not a trade worth making.

So there is no trigger. Instead this job runs on a schedule and reconciles:
it works out which uids the residual collections still mention, asks Firebase
Auth which uids still exist, and removes the difference. The infrastructure is
the same free stack the hourly monitor already uses — GitHub Actions, Workload
Identity Federation, the Admin SDK.

**The trade is latency, not correctness.** Deletion is not instantaneous. The
in-app Delete account flow is immediate for everything a signed-in client can
reach; these residual server-owned references are cleared on the next run.

## What it cleans

| Collection | Removed |
|---|---|
| `alertDecisions/*` | `recipients.<uid>`, the uid's entry in `undeliveredTo[]`, `syntheticTargetUid` when it names them |
| `inviteCodes/*` | `usedBy` and `createdBy` where either equals the uid |

Everything else on those documents is left exactly as it was: other members'
ledger entries, `delivered`, `deliveredAt`, `attempts`, decision history,
`familyId`, `code`.

### What it deliberately does NOT delete

- **No document is ever deleted.** Only named fields are updated. The source
  contains no `.delete()`, `deleteDoc`, `recursiveDelete` or `bulkWriter`, and
  a test asserts that.
- **`inviteCodes.used` is never reset.** The code was spent. Clearing that flag
  would turn a dead invite back into a live one for a family the departed user
  no longer belongs to — a working invitation into someone else's circle.
  Only the uid references are removed; the code stays used.
- **Nothing a live user owns.** See below.
- **Nothing the client already handles** — profile, devices, memberships,
  locations. That is `www/js/account-delete.js`'s job and it runs immediately.

## Why it cannot delete a live user's data

A uid is purged only when it is **both**:

1. referenced by a residual record, **and**
2. absent from a **complete** enumeration of Firebase Auth.

"Complete" is load-bearing. `listAllAuthUids()` throws if any page of
`listUsers()` fails, and the caller never falls back to a partial set — a
partial set would classify live users as departed, which is the one mistake
this job must never make. Three guards, all fail-closed:

- **Enumeration must succeed.** Any error and the run aborts before a single
  write, exits non-zero, and reports `abortReason: auth-enumeration-incomplete`.
- **An empty live set with references present aborts.** Zero accounts alongside
  residual data is far more likely to be a credentials or API failure than a
  real state. Reported as `auth-returned-no-users`.
- **Work is bounded.** At most `MAX_DEPARTED_PER_RUN` (500) uids per run;
  the rest are reported in `deferredCount` and picked up next time. Scans stop
  at `MAX_SCAN_DOCS` (200,000) rather than running away.

## How departed uids are identified

`recipients` is a map keyed by uid, and Firestore cannot query or aggregate
dynamic map keys — there is no way to ask "which uids appear here". The only
way to learn them is to read the documents. Discovery therefore scans, and the
design accounts for it:

```
pass 1  scan alertDecisions + inviteCodes  ->  referenced uid set   (read-only)
        listUsers() paginated              ->  live uid set
        referenced - live                  ->  departed
pass 2  scan again, applying EVERY departed uid's cleanup per document
```

Two passes total, regardless of how many accounts departed. Calling the
per-uid sweep once per departed user would re-scan the collection each time.

## Retry and idempotency

Idempotent **by construction**, not by bookkeeping. Every operation is a no-op
once applied — deleting an absent field, removing an absent array element,
nulling an already-null field. So:

- Running twice produces the same final state; the second run finds nothing.
- A run that dies halfway is fixed by running it again. There is no cursor to
  persist and no partial state to reconcile.
- A uid re-referenced after a sweep (a decision written between passes) is
  simply picked up on the next run.

## Running it

Dry run is the **default**. Writing requires `--confirm`, matching the
precedent set by `monitor/test-fcm.js`. `DRY_RUN=false` is accepted as an
equivalent so a workflow can toggle it from the environment.

```sh
# Against the emulators
firebase emulators:exec --only auth,firestore --project demo-theeram \
  "node monitor/reconcile-cli.js"

# Against production, reading only
npm run reconcile:dry          # node monitor/reconcile-cli.js --production

# Against production, writing
npm run reconcile              # ... --production --confirm
```

Flags: `--production`, `--confirm`, `--json`, `--max=<n>`.

### Tests

```sh
npm run test:reconcile
```

Runs against both emulators — real Auth accounts are created and deleted, and
the reconciler enumerates them with `listUsers()` exactly as in production.
The Auth emulator port in `firebase.json` exists for this.

## The GitHub Actions path

`.github/workflows/reconcile-users.yml`, weekly on Sundays at 04:40 UTC
(10:10 IST), plus `workflow_dispatch`. **A push never triggers it.**

- A **manual** run is a dry run unless the operator clears the checkbox.
- A **scheduled** run writes.

Authentication is the same Workload Identity Federation path the monitor uses:
GitHub mints a short-lived OIDC token, Google exchanges it for a short-lived
access token, and `google-github-actions/auth` writes an `external_account`
credential file and exports `GOOGLE_APPLICATION_CREDENTIALS`, which
`monitor/admin.js` consumes through `applicationDefault()`.

**No service-account private key exists anywhere** — not in the repository, not
in GitHub secrets, not in the Android app. The two secrets are
`GCP_WIF_PROVIDER` and `GCP_SERVICE_ACCOUNT`, both non-secret identifiers.
Actions are pinned to full commit SHAs.

### One-time IAM prerequisite

The monitor's service account currently holds `roles/datastore.user` plus the
custom FCM sender role. **`listUsers()` needs Firebase Auth read access as
well**, which it does not yet have. Grant it once:

```sh
gcloud projects add-iam-policy-binding theeram-18e35 \
  --member="serviceAccount:theeram-monitor@theeram-18e35.iam.gserviceaccount.com" \
  --role="roles/firebaseauth.viewer"
```

Until that is granted, the job **fails closed**: enumeration errors, the run
aborts before writing anything, and the workflow goes red. It never guesses.

## Reading the logs

A run ends with one JSON line:

```json
{"dryRun":false,"referencedUids":7,"liveAuthUids":6,"authComplete":true,
 "departedCount":1,"deferredCount":0,"aborted":false,"abortReason":null,
 "scanned":{"alertDecisions":124,"inviteCodes":3},"durationMs":842}
```

| Field | Meaning |
|---|---|
| `referencedUids` | distinct uids the residual collections mention |
| `liveAuthUids` | accounts that still exist; `null` if enumeration failed |
| `departedCount` | referenced but gone from Auth — these were purged |
| `deferredCount` | above the per-run bound; next run picks them up |
| `aborted` / `abortReason` | **a failure.** Nothing was written |
| `purge.*.batches` | committed batches; always `0` on a dry run |

Only counts and opaque uids are logged. No names, places, phone numbers,
emergency contacts, FCM tokens or credentials ever appear.
