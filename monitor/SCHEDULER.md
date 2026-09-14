# Scheduler setup — GitHub Actions + Workload Identity Federation

One-time setup so `.github/workflows/monitor.yml` can reach the live Firestore
project without any long-lived credential existing anywhere.

**No push notifications are involved.** The scheduled run computes risk, writes
changed values, and records alert decisions with `delivered: false`. Nobody's
phone is touched.

## How the authentication works

```
GitHub Actions  ──OIDC token──▶  Google STS  ──▶  short-lived access token
   (id-token:write)                  │                        │
                                     ▼                        ▼
                      attribute-condition gate      impersonate the
                   repository == Devhari2k/theeram   monitor service account
```

Nothing durable is stored. The token lives minutes, and there is no key file
to leak from a public repository, commit by accident, or forget to rotate.

## The one setting that matters

**The provider's `--attribute-condition` is the entire security boundary.**
Without it — or with a loose one — *any* GitHub repository on the internet
could mint a token for your Google Cloud project. Pin it to this repository,
and do not relax it.

## Setup

Run these once, with `gcloud` authenticated as an owner of `theeram-18e35`.

```bash
PROJECT_ID=theeram-18e35
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
REPO=Devhari2k/theeram
POOL=github-pool
PROVIDER=github-provider
SA=theeram-monitor

# 0. APIs
gcloud services enable iamcredentials.googleapis.com sts.googleapis.com \
  --project="$PROJECT_ID"

# 1. A dedicated service account — not the default compute one
gcloud iam service-accounts create "$SA" \
  --project="$PROJECT_ID" --display-name="Theeram flood monitor"

# 2. Least privilege: Firestore read/write and nothing else.
#    NOT Owner, NOT Editor. The monitor only touches Firestore.
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$SA@$PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/datastore.user"

# 3. Identity pool
gcloud iam workload-identity-pools create "$POOL" \
  --project="$PROJECT_ID" --location=global --display-name="GitHub Actions"

# 4. OIDC provider. The attribute-condition is the security boundary —
#    it is what stops any other repository using this pool.
gcloud iam workload-identity-pools providers create-oidc "$PROVIDER" \
  --project="$PROJECT_ID" --location=global --workload-identity-pool="$POOL" \
  --display-name="GitHub OIDC" \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.repository_owner=assertion.repository_owner" \
  --attribute-condition="assertion.repository=='$REPO' && assertion.repository_owner=='Devhari2k'"

# 5. Allow ONLY that repository to impersonate the service account.
#    principalSet scopes it to attribute.repository — a second gate behind
#    the attribute-condition above.
gcloud iam service-accounts add-iam-policy-binding \
  "$SA@$PROJECT_ID.iam.gserviceaccount.com" --project="$PROJECT_ID" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$POOL/attribute.repository/$REPO"

# 6. The two values to paste into GitHub
echo
echo "GCP_WIF_PROVIDER    = projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$POOL/providers/$PROVIDER"
echo "GCP_SERVICE_ACCOUNT = $SA@$PROJECT_ID.iam.gserviceaccount.com"
```

Add both under **Settings → Secrets and variables → Actions → Repository
secrets**, named exactly `GCP_WIF_PROVIDER` and `GCP_SERVICE_ACCOUNT`.

They are resource names rather than true secrets, but this repository is
public and GitHub masks secret values in logs, so storing them as secrets
keeps the project number out of public build output for free.

## Turning it on

`schedule` triggers only fire for workflows on the repository's **default
branch**. While `monitor.yml` lives on `claude/theeram-repo-audit-4vz18b` it
is inert — nothing runs on a timer until it is merged to `main`. Merging is
the on-switch.

Recommended order:

1. Do the GCP setup above and add the two secrets.
2. Merge the branch to `main`.
3. **Actions → Flood monitor → Run workflow**, leaving `dry_run` ticked. This
   authenticates for real and reads production, but writes nothing.
4. Check the log: expect `target=PRODUCTION`, a location count, and a list of
   documents that *would* be written.
5. Run it once more with `dry_run` unticked, then confirm
   `system/monitorHeartbeat` appears in Firestore.
6. Leave it to the hourly schedule.

## Verifying it is alive

`system/monitorHeartbeat` is the source of truth, not the Actions tab:

```json
{ "lastRunAt": "...", "lastRunStatus": "ok", "locationsChecked": 3,
  "alertsWouldSend": 0, "durationMs": 4200, "weatherFailures": 0 }
```

`lastRunStatus: "degraded"` means the pass completed but some cells or
locations failed; stale risk was retained rather than cleared. Persistent
`degraded` is worth investigating. A `lastRunAt` more than a couple of hours
old means the schedule is not running.

## Known failure modes

**GitHub disables scheduled workflows after 60 days without repository
activity.** It does this silently. For a flood alerter that is the dangerous
failure — the app keeps looking healthy while nothing is being checked, which
is worse than having no alerting at all, because it manufactures confidence.
This is exactly why the heartbeat exists and why the app should surface
"last checked" and warn when it goes stale.

**Scheduled runs drift and are occasionally dropped** under GitHub load. At an
hourly cadence against 24-hour rainfall windows this is tolerable; it would not
be at 15 minutes, and it would not be acceptable for flash-flood signals.

**What appears in public logs.** Actions logs on a public repository are
readable by anyone. Normal runs print counts only. Only when an alert is
actually decided does a line carrying opaque `familyId`/`locationId` values
appear — never names, coordinates, or personal data. If even that is too much,
the alternative is moving this workflow to a private repository; the monitor
itself needs no change.

## Hardening worth doing later

- ~~**Pin actions to commit SHAs** rather than major tags.~~ Done — both
  workflows pin full SHAs with the release recorded in a trailing comment.
  When bumping, re-resolve and update the SHA and the comment together:
  `git ls-remote https://github.com/actions/checkout refs/tags/v4`
- **Narrow the attribute-condition to a branch** once merged, e.g. adding
  `&& assertion.ref=='refs/heads/main'`, so only the default branch can
  authenticate.
- **Add a GCP budget alert.** The monitor should cost nothing on Spark, but a
  budget alert is the cheapest way to notice if that ever stops being true.
