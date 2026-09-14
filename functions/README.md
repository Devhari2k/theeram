# Theeram Cloud Functions

One function: `onUserDeleted`, the privileged cleanup for a deleted account.

## Why this exists

`www/js/account-delete.js` erases everything a signed-in client is *permitted*
to erase. Two collections are deliberately beyond its reach, and no security
rule was relaxed to change that:

| Collection | Why the client cannot touch it |
|---|---|
| `alertDecisions` | No rule matches it, so every client request hits the default-deny catch-all. It is server-owned by design. |
| `inviteCodes` | `allow delete: if false`, and `allow update` requires `used == false`. A code naming a departed uid is already used, so it is immutable to every client. |

This function runs with the Admin SDK, which bypasses rules entirely, and is
the only thing that touches those documents on a deletion path.

## What it removes

For the departed `uid`:

- `alertDecisions/*` — the `recipients.<uid>` ledger entry, the uid's entry in
  `undeliveredTo[]`, and `syntheticTargetUid` when it names them.
- `inviteCodes/*` — `usedBy` and `createdBy` where either equals the uid.

`inviteCodes.used` is deliberately **not** reset. The code was spent; clearing
that would resurrect a live invite into a family the user no longer belongs to.

Nothing else is written. Delivery state, decision history and other members'
ledger entries are left exactly as they were.

## Guarantees

- **Idempotent.** Every emitted operation is a no-op when already applied:
  deleting an absent field, removing an absent array element, nulling an
  already-null field. Re-running for the same uid matches nothing.
- **Retry-safe.** There is no cursor to persist and no partial state to
  reconcile, so a run that dies halfway is fixed by running it again. The
  trigger rethrows on failure precisely so Cloud Functions retries it.
- **Batched.** Reads page at `SCAN_PAGE` (300); writes commit at `WRITE_BATCH`
  (400), under Firestore's 500 limit. `MAX_SCAN_DOCS` stops a runaway scan
  and reports `truncated: true` rather than running unbounded.
- **Escape-proof.** Field paths are built with `FieldPath('recipients', uid)`,
  so a uid is always one literal segment whatever characters it contains.

`alertDecisions` is swept with a paged full scan rather than a query on
`recipients.<uid>`. That is a dynamic map key, so querying it would depend on
Firestore having auto-indexed a per-uid subfield — exactly the kind of
assumption that fails quietly on a deletion path. One scan covers every field
and needs no index. The collection is small by design: decisions retire after
12 hours.

## Deploying — requires the Blaze plan

**Cloud Functions cannot be deployed on the Spark plan.** Theeram is currently
on Spark (see `monitor/SCHEDULER.md`), so this function is committed and tested
but **not yet deployable**. Upgrading to Blaze with a low budget alert is the
intended path; the function's own cost at Theeram's scale is effectively zero,
since it runs once per account deletion.

Once the project is on Blaze:

```sh
cd functions && npm install && cd ..
firebase deploy --only functions:onUserDeleted
```

**Deploy scope caveat.** `firebase.json` now has a `functions` block, so a bare
`firebase deploy` will attempt to deploy functions as well as rules. Keep using
an explicit target:

```sh
firebase deploy --only firestore:rules     # rules, as before
firebase deploy --only functions           # functions
```

The function is pinned to `asia-south1` (Mumbai) — the users are in Kerala and
the data is theirs.

## If the project stays on Spark

There is no native Auth-deletion hook outside Cloud Functions, so the trigger
itself cannot be replicated. The purge logic is deliberately a plain module
taking an injected `db`, so it can be driven from anywhere with Admin SDK
credentials — including the existing GitHub Actions + Workload Identity
Federation path the monitor already uses.

The reconciliation shape that needs no trigger, no rules change and no client
change: enumerate live Auth accounts with `listUsers()`, collect the uids
referenced in `alertDecisions` and `inviteCodes`, and call `purgeDeletedUser`
for every referenced uid that no longer exists. It is idempotent by the same
construction, so it can run on a schedule. That reconciler is **not built** —
this repository currently contains only the trigger.

## Testing

```sh
npm run test:purge
```

Runs `tests/purge-user.test.mjs` against the Firestore emulator with the Admin
SDK — the same way the function runs in production. The pure planners are
tested in isolation; the sweeps are tested for correctness, idempotency,
retry-safety, pagination past a read page, and for leaving other users' data
alone. No Auth account is created or deleted: the trigger is a thin wrapper
around `purgeDeletedUser`, which is what the tests exercise.
