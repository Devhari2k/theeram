# Theeram — personal data inventory

**Internal engineering reference.** The user-facing document is
[PRIVACY_POLICY.md](PRIVACY_POLICY.md); this one records where each element
actually lives in the code so the policy can be re-verified after a change.

Derived from the code at the commit that introduced this file. Re-audit when
`www/js/auth.js`, `www/js/family.js`, `www/js/push.js`, `monitor/run.js`,
`monitor/notify.js` or `firestore.rules` change.

Legend — **Access**: `self` = the account only · `family` = confirmed members of
the same circle · `server` = Admin SDK processes only (clients denied by rules)
· `google` = the Firebase backend.

---

## 1. Account and profile

| Data element | Where collected | Where stored | Why | Who can access | Third parties | Retention / deletion | Required? |
|---|---|---|---|---|---|---|---|
| Email address | `auth.js:74,77` sign-up/sign-in; or Google | Firebase Auth only — **never copied to Firestore** | Account identity, sign-in | self, google | Google (Firebase Auth) | Deleted with the Auth account, immediately | **Required** |
| Password | `auth.js:74,77` | Firebase Auth only; **never reaches Theeram storage** | Sign-in | google | Google | Deleted with the Auth account | Required for email sign-in |
| Google profile (name, picture, email) | `auth.js:91` `signInWithPopup` | Mirrored to `users/{uid}.name`, `.photoURL` | Identity, display | self, family (denormalised) | Google | Deleted with `users/{uid}` | Alternative to password |
| Firebase UID | Firebase Auth | Doc id of `users/{uid}`, `members/{uid}`; `locations.ownerUid`; `alertDecisions.recipients.<uid>`; `inviteCodes.usedBy`/`createdBy` | Primary key throughout | self, family, server | Google | Immediate except residual refs — see §6 | Required |
| Display name | `auth.js:141` profile form | `users/{uid}.name`, **denormalised** into `members/{uid}.name` | Identity in the circle | self, family | Google | Deleted with both docs | **Required** |
| Profile picture URL | `auth.js:141` | `users/{uid}.photoURL`, denormalised into member doc | Display | self, family | Google | Deleted with both docs | Optional |
| **Phone number** | `auth.js:122` profile form | `users/{uid}.phone` | Available in an emergency | **self only** | Google | Deleted with `users/{uid}`, immediately | **Optional** |
| **Emergency contact name + phone** | `auth.js:123-126` | `users/{uid}.emergencyContact{name,phone}` | Available in an emergency | **self only** | Google | Deleted with `users/{uid}`, immediately | **Optional** |
| `createdAt` | `auth.js:130` `serverTimestamp()` | `users/{uid}.createdAt` | Account age | self | Google | Deleted with the doc | Automatic |

> **Third-party PII.** `emergencyContact` holds a *different person's* name and
> number, collected without their involvement. It is the highest-sensitivity
> field in the app. Never logged, never shared with the circle, never placed in
> a notification payload. `monitor/notify.js` reads `users/{uid}` for `devices`
> only and a path guard prevents any write outside `devices.<sha256>`.

## 2. Location data

| Data element | Where collected | Where stored | Why | Who can access | Third parties | Retention / deletion | Required? |
|---|---|---|---|---|---|---|---|
| **Home location** (name, lat, lon) | `auth.js:134-136` — geocoded from typed text | `users/{uid}.homeLocation` **and denormalised into `members/{uid}.homeLocation` in every circle** | Show the member on the family map | self, **family** | Google; Nominatim receives the typed text | Deleted with both docs | **Optional** |
| Saved location (name, lat, lon) | `index.html:1269` `addLocation` | `families/{fid}/locations/{id}` | The place being monitored | **family** (all members) | Google; Nominatim (text); Open-Meteo (grid-rounded coords) | Deleted on leave / remove / account deletion | Optional |
| `locations.ownerUid` | `family.js` create | same doc | Who may edit/delete it | family | Google | Deleted with the doc | Automatic |
| Geocoding query text | `index.html:1132` | **Not stored** — transient | Place name → coordinates | — | **Nominatim (OpenStreetMap), with client IP** | Not retained by Theeram | Required to add a place |
| Map viewport | Leaflet | Not stored | Render the map | — | **CARTO** `basemaps.cartocdn.com`, with client IP | Not retained by Theeram | Automatic |

> **No GPS.** `git grep` for `navigator.geolocation`, `getCurrentPosition`,
> `watchPosition`, `@capacitor/geolocation` returns zero matches. No location
> permission is declared. Every coordinate originates from typed text.
>
> **Grid rounding.** `monitor/grid.js` `DEFAULT_PRECISION = 2` rounds to ~1.1 km
> before the Open-Meteo call, and no identifier accompanies it.

## 3. Family circle

| Data element | Where collected | Where stored | Why | Who can access | Third parties | Retention / deletion | Required? |
|---|---|---|---|---|---|---|---|
| Circle name, `createdBy`, `createdAt` | `family.js:129` | `families/{fid}` | Group identity | family | Google | Deleted only when the circle is deleted | Optional feature |
| Membership (`uid`, `role`, `status`, `joinedAt`, `lastActiveAt`) | `family.js:131,162` | `families/{fid}/members/{uid}` | Access control, roster | family | Google | Deleted on leave / remove / account deletion | Optional feature |
| `joinedViaCode` | `family.js:167` | member doc | Which invite was used | family | Google | Deleted with the member doc | Automatic |
| Invite code (`code`, `familyId`, `familyName`, `createdBy`, `used`, `usedBy`) | `family.js:277` | `inviteCodes/{code}` | Single-use join | `get` by any signed-in user who knows the code; **never listable** | Google | **Never deleted** (`allow delete: if false`). `usedBy`/`createdBy` cleared by the reconciler — see §6 | Optional feature |

## 4. Device and notification data

| Data element | Where collected | Where stored | Why | Who can access | Third parties | Retention / deletion | Required? |
|---|---|---|---|---|---|---|---|
| **FCM registration token** | `push.js` `upsertDevice` | `users/{uid}.devices[<sha256(token)>].token` | Address an alert to a device | **self only** | Google (FCM) | Removed on sign-out (that device); on FCM `not-registered`; with `users/{uid}` on deletion | **Optional** — only if notifications allowed |
| Device key | `push.js deviceKeyFromToken` | map key, `sha256(token)` | Stable per-device key | self | — | With the record | Automatic |
| `platform`, `enabled`, `createdAt`, `updatedAt` | `push.js buildDeviceRecord` | same record | Bookkeeping | self | Google | With the record | Automatic |
| **Firebase Installation ID** | firebase-installations SDK (82 dex refs) | On device; sent to Google | Prerequisite for FCM | google | **Google** | Google's retention; reset on reinstall/clear data | Automatic with FCM |
| FCM delivery telemetry | `datatransport`/`transport-backend-cct` (414 dex refs) | Google | Delivery diagnostics | google | **Google** | Google's retention | Automatic with FCM — not separately disableable |
| Notification title/body | `notify.js buildNotification` | Transient | The alert text | recipient | Google (FCM) | Not stored by Theeram | Automatic |
| Notification `data` payload | `notify.js buildDataPayload` | Transient | Routing a tap | recipient | Google (FCM) | Not stored | Automatic |

> **Payload is identifiers only** — `type`, `count`, `familyId`, `locationId`,
> `kind`, `level`, `episodeId`. Tests assert no coordinates, names, phone or
> emergency contact can appear.
>
> **The title/body DOES contain the saved place name**, and the Android channel
> is `visibility: 1` (VISIBILITY_PUBLIC, `push.js:161`), so it is readable on a
> locked screen. Disclosed in policy §7.

## 5. Derived and operational data

| Data element | Where collected | Where stored | Why | Who can access | Third parties | Retention / deletion | Required? |
|---|---|---|---|---|---|---|---|
| `rain`, `forecast`, `risk`, `elevation`, `terrainType` | `monitor/run.js` | `families/{fid}/locations/{id}` | The risk estimate shown | family | Google; Open-Meteo supplies the inputs | Deleted with the location | Automatic |
| `alertState` (`band`, `episodeId`, `clearingSince`, `lastDecisionAt`…) | `monitor/alerts.js` via `run.js` | same doc | Hysteresis and cooldown | family | Google | Deleted with the location | Automatic |
| `lastCheckedAt`, `lastUpdated` | `run.js` | same doc | Freshness display | family | Google | Deleted with the location | Automatic |
| **Alert decision** (`locationId`, `familyId`, `kind`, `level`, `band`, `episodeId`, `decidedAt`) | `run.js:258-270` | `alertDecisions/{id}` | Alert history, delivery queue | **server only** — no rule matches this collection | Google | **Never expired.** Survives account deletion; uid refs cleared by the reconciler | Automatic |
| Delivery ledger (`recipients.<uid>{delivered,attempts,lastCode,deliveredAt}`, `undeliveredTo[]`, `deliveredCount`, `failureCount`, `retiredReason`) | `notify.js` | `alertDecisions/{id}` | Per-recipient at-least-once delivery | **server only** | Google | uid refs cleared by the reconciler — §6 | Automatic |
| `syntheticTargetUid` | `monitor/test-fcm.js` | `alertDecisions/{id}` | Marks a synthetic test alert | server only | Google | Cleared by the reconciler | Test-only |
| Monitor heartbeat (counts, status, duration) | `run.js` | `system/monitorHeartbeat` | Liveness | server only | Google | Overwritten each run; **no personal data** | Automatic |
| IP address | Every network request | Not stored by Theeram | Transport | — | **Google, Open-Meteo, Nominatim, CARTO, unpkg, jsDelivr** | Each provider's own policy | Unavoidable |

## 6. Deletion map

`www/js/account-delete.js` runs client-side under the user's own credentials;
`monitor/reconcile.js` runs weekly with the Admin SDK.

| Record | Immediate (in-app) | Residual | Cleaned by |
|---|---|---|---|
| Firebase Auth account | ✅ `deleteUser()` | — | — |
| `users/{uid}` — incl. phone, emergency contact, home location, **all device tokens** | ✅ `deleteDoc` | — | — |
| `families/{fid}/members/{uid}` (every circle) | ✅ | — | — |
| `families/{fid}/locations/*` owned by the user | ✅ | — | — |
| `families/{fid}` where sole member | ✅ deleted | — | — |
| `families/{fid}` where sole admin **with others** | ⚠️ **handed to the longest-serving member**, not deleted | — | — |
| `families/{fid}.createdBy` | ❌ | uid remains on a circle that outlives the user | **Nothing — see gap below** |
| `alertDecisions.recipients.<uid>`, `undeliveredTo[]`, `syntheticTargetUid` | ❌ rules deny all client access | uid, ≤ ~7 days | `monitor/reconcile.js` weekly |
| `inviteCodes.usedBy` / `.createdBy` | ❌ `allow delete: if false`; update requires `used == false` | uid, ≤ ~7 days | `monitor/reconcile.js` weekly |
| `inviteCodes` document itself | ❌ | Kept permanently, `used: true` preserved | Never — un-marking would revive a live invite |
| Locations added by **other** members | ❌ | Theirs, not the departing user's | Never |
| `alertDecisions` for other members' locations | ❌ | Retained as their history | Never |
| `system/monitorHeartbeat` | n/a | Counts only, no personal data | Overwritten hourly |
| Third-party backups/logs (Google, Open-Meteo, Nominatim, CARTO, CDNs, GitHub) | ❌ | Provider-controlled | Their policies |

**Known gap:** `families/{fid}.createdBy` retains the uid of a departed founder
when the circle is handed on. Not currently covered by the reconciler, and not
claimed as deleted in the policy. It is an opaque identifier on a document that
holds no other information about that person.

## 7. Logging

| Sink | Contents | Personal data? |
|---|---|---|
| GitHub Actions (**public repo — logs are world-readable**) | `familyId`, `locationId`, `episodeId`, counts (`run.js:143`) | Opaque ids only. No names, coordinates, tokens or contacts |
| Reconciler summary | counts + uids | Opaque ids only |
| Android logcat (`push.js`, 17 `console.log`) | Permission state, channel id, registration success | **No token** — `emit()` masks it as `[present]`; `diagnose()` reports `hasToken` boolean |
| Firestore / Firebase console | All stored data | Yes — project owners |

## 8. Android permissions (from the built APK)

`INTERNET` · `POST_NOTIFICATIONS` (runtime) · `ACCESS_NETWORK_STATE` ·
`WAKE_LOCK` · `com.google.android.c2dm.permission.RECEIVE` ·
`DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`

**No location, camera, microphone, contacts, storage/photos or device-identifier
permission.** Verified with `aapt2 dump permissions`, not from the manifest source.

## 9. iOS

**No iOS project exists** (`ios/` absent, `@capacitor/ios` not a dependency).
When added it will need a push entitlement and
`NSUserNotificationsUsageDescription`; **no location purpose string**, since no
GPS API is used. Sign in with Apple becomes mandatory because Google Sign-In is
offered.

## 10. Store declaration crib

For Play Data Safety / Apple App Privacy, declare **collected and linked to the
user**: email, name, photo, **phone number**, **emergency contact (third-party
PII)**, **approximate location** (home + saved places), device/FCM token,
Firebase Installation ID, app activity (alert history), diagnostics (FCM
delivery telemetry).

Declare **not collected**: precise GPS location, contacts list, photos/media,
browsing history, advertising ID, purchases, health, financial.

Declare **not shared with third parties for advertising**, **no data sold**, and
**no tracking across apps** — all three are supportable: there is no analytics,
crash-reporting, advertising or attribution SDK anywhere in the build.
