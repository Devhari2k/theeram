# Theeram Privacy Policy

**Effective date:** 15 September 2026
**Last updated:** 15 September 2026

This policy describes what Theeram collects, why, who it is shared with, and
how to remove it. It describes the app as it is actually built.

---

## 1. What Theeram is

Theeram is a personal flood-risk monitoring app for saved places, built for
families in coastal Kerala, India. You save the places you care about — your
home, a relative's house, a workplace — and Theeram estimates flood risk at
each of them from public rainfall and elevation data, then notifies you when
that estimate rises.

**Theeram is an informational tool, not an official warning service.** The risk
estimate is a rainfall-and-elevation proxy. It has no river-stage, reservoir,
soil-moisture, drainage or tide input, and it is not a hydrological forecast.
Always follow Kerala SDMA, NDMA and local authority guidance in an emergency.

Theeram is operated by Harishreyas Vijay.

## 2. Information you provide

### Account information
When you create an account you provide an **email address and password**, or
you sign in with **Google**, in which case Google provides your email address,
name and profile picture to Theeram. Authentication is handled by Firebase
Authentication. **Theeram never stores your password**; Firebase manages
credentials.

### Profile information
After first sign-in you are asked for:

| Field | Required? |
|---|---|
| Display name | Required |
| Profile picture URL | Optional — supplied by Google sign-in |
| **Phone number** | **Optional** |
| **Emergency contact name and phone number** | **Optional** |
| **Home location** | **Optional** |

You may skip the optional fields, and the app works without them.

**About emergency contacts:** if you enter one, you are providing another
person's name and phone number. Please make sure they are content for you to
do so. Theeram stores it with your profile and does not contact them; the
field exists so the information is to hand in an emergency.

### Home and saved locations
You add places by **typing a place name**. Theeram converts that text into
coordinates using OpenStreetMap's Nominatim service (see §6) and stores the
resolved name, latitude and longitude.

**Theeram does not use your device's GPS.** The app requests no location
permission, and the code contains no call to any geolocation API. Every
coordinate it holds came from a place name you typed.

### Family circles
You may create a family circle or join one with an invite code. Membership,
invite codes and who redeemed them are stored.

## 3. Information collected automatically

### Device and notification information
If you allow notifications, Theeram stores a **Firebase Cloud Messaging
registration token** for that device, along with the platform and the times the
registration was created and updated. The token is what lets Theeram's server
send an alert to that specific device. It is stored under a SHA-256 hash of
itself, so each device has a stable key.

Firebase Cloud Messaging also uses a **Firebase Installation ID**, a
pseudonymous identifier Google assigns to the app installation. The Firebase
SDKs additionally report delivery and diagnostic telemetry to Google.

### Derived flood-risk data
For every saved location, Theeram's scheduled monitor stores the rainfall
totals it computed, the forecast, the resulting risk level, elevation, terrain
type, the alert state, and when it last checked.

### Alert history
When the risk at a location crosses a threshold, Theeram records an **alert
decision**: the location and family it relates to, the kind and level of alert,
the time, and — once delivery is attempted — which member accounts it reached
and which it did not.

### Technical information
Like any internet service, the providers listed in §6 receive your **IP address
and basic device/browser information** as a necessary part of serving a request.

### What Theeram does not collect
Theeram contains **no analytics SDK and no crash-reporting SDK**. There is no
Google Analytics for Firebase, no Crashlytics, and no third-party analytics or
advertising library. Theeram does not track you across apps or websites, does
not build advertising profiles, and does not sell personal information.

## 4. How your information is used

- **Authentication** — email and password or Google identity, to sign you in.
- **Flood-risk estimation** — coordinates for each saved location are rounded
  to roughly a 1.1 km grid cell and sent to Open-Meteo to retrieve rainfall and
  elevation. Your identity is not sent with them.
- **Alerts** — a risk level crossing a threshold generates an alert decision,
  which is delivered to the registered devices of that family's members.
- **Family sharing** — your display name, picture, safety status and home
  location are shown to the other members of circles you join (see §5).
- **Account and support** — your email identifies your account.

Theeram does not use your information for advertising or profiling.

## 5. What family members can see

This is worth reading carefully before you join or create a circle.

Every member of a family circle can see, for every other member:

- display name and profile picture
- safety status
- **home location, including its coordinates**, if you set one

and can see **every saved location in the circle**, including its name and
coordinates, whoever added it.

**Alerts go to every member of the circle.** When a saved place crosses a risk
threshold, all members receive the notification — not only the person who added
that place.

Your **phone number and emergency contact are not shared** with other members.
They are readable only by you.

Family administrators can additionally remove members, which deletes those
members' saved locations in that circle, and can delete the circle.

If you leave a circle, your membership record and the locations you added to it
are deleted.

## 6. Third-party services

Theeram is a small app built on public services. Each of these receives data as
described. Theeram does not control their independent practices — please see
their own privacy policies.

| Service | Provider | What it receives | Why |
|---|---|---|---|
| Firebase Authentication | Google | Email, password or Google credential, IP, device info | Sign-in |
| Cloud Firestore | Google | All stored data in §2–§3 | Storage |
| Firebase Cloud Messaging | Google | Device token, notification content | Alerts |
| Firebase Installations | Google | Installation ID, app and SDK version | Required by messaging |
| Firebase SDK hosting (gstatic) | Google | IP, device info | Loads the app's code |
| Google Fonts | Google | IP, device info | Typography |
| Open-Meteo | Open-Meteo | Grid-rounded coordinates (~1.1 km) | Rainfall and elevation |
| Nominatim | OpenStreetMap Foundation | The place text you type, IP | Converts a place name to coordinates |
| Map tiles | CARTO (OpenStreetMap data) | IP, the map area you view | Displays the map |
| unpkg, jsDelivr | Cloudflare/Fastly CDNs | IP, device info | Map and QR-code libraries |
| GitHub Actions | GitHub (Microsoft) | Runs the scheduled monitor | Scheduling |

**Location data sent to Open-Meteo is coarse and anonymous.** Coordinates are
rounded to about 1.1 km and sent without any identifier, so the request cannot
be tied to you by Open-Meteo. The place name you type is, by contrast, sent to
Nominatim exactly as you typed it.

These providers operate globally. Your information **may be processed and
stored outside India**, including in the United States and the European Union,
depending on the provider's infrastructure. Firebase services for this project
are configured in the `asia-south1` (Mumbai) region where the service supports
regional selection, but this is not a guarantee that no data leaves India.

## 7. Notifications

Alerts are delivered through Firebase Cloud Messaging. A notification contains
the **name of the affected saved place** and the risk level — for example,
"Severe flood risk — Kochi".

The Android notification channel is configured as **publicly visible on the
lock screen**, so an alert is readable without unlocking the device. This is
deliberate: an alert that a locked screen hides is of little use at 3am. It
does mean that **anyone holding your phone can see the name of an affected
saved place**. You can change this in Android's notification settings for
Theeram if you prefer.

The data attached to a notification is limited to identifiers — family,
location and alert ids. **Coordinates, names, phone numbers and emergency
contacts are never included in a notification payload.**

You can turn notifications off at any time in your device settings. Doing so
stops alerts reaching that device.

## 8. Data retention and deletion

### Deleting your account
**Account → Delete account**, inside the app. You are asked to confirm and to
re-enter your password. This cannot be undone.

### Deleted immediately
- your Firebase Authentication account
- your profile, including phone number, emergency contact and home location
- **every device registration and notification token**
- your membership of every family circle
- every saved location you added
- a family circle in which you were the only member

If you are the sole administrator of a circle that still has other members, the
circle is **handed to its longest-serving remaining member** rather than
deleted, so that other people do not lose their saved places.

### Cleaned up shortly afterwards
Some records are held in collections that no app can write to, for security
reasons. After your account is deleted, a scheduled job removes your identifier
from them. **This is not instantaneous.** The job runs weekly, so residual
references may persist for **up to about seven days** after deletion. What
remains in that window is your **account identifier only** — an opaque string —
on records that contain no name, location or contact information.

Specifically: your identifier in alert-delivery records, and in invite codes you
created or redeemed. The invite code itself is kept marked as used, because
un-marking it would turn a dead invitation into a working one for a circle you
have left.

### What is not deleted
- **Saved locations added by other members** of a circle you belonged to, and
  **alert history for those locations**. These belong to the other members.
- Aggregate, non-identifying operational records such as the monitor heartbeat.
- Backups or logs held by the third parties in §6 under their own retention
  policies.

### Retention while your account is active
Theeram keeps your information for as long as your account exists. Alert
decisions are retained as history; they are not automatically expired.

## 9. Security

- All traffic uses HTTPS.
- Passwords are handled entirely by Firebase Authentication and never reach
  Theeram's own storage.
- Firestore security rules restrict access: your profile is readable only by
  you; circle data is readable only by confirmed members; alert-delivery
  records are readable by no client at all.
- Notification tokens are stored under a hash and are never written to logs.
- The scheduled server components authenticate with short-lived federated
  credentials. **No long-lived service-account key exists.**

No system is perfectly secure, and Theeram cannot guarantee absolute security.

## 10. Children's privacy

Theeram is not directed at children under 13, and Theeram does not knowingly
collect personal information from them. If you believe a child has provided
information, contact harishreyasv@gmail.com and it will be deleted.

## 11. Your rights and choices

Within the app you can:

- **view and edit** your profile, including removing your phone number,
  emergency contact and home location
- **add or remove** saved locations
- **leave** a family circle
- **turn off notifications** in device settings
- **delete your account and associated data** (§8)

Depending on where you live, you may have additional rights — access,
correction, deletion, portability, or objection to certain processing — under
laws such as India's Digital Personal Data Protection Act, 2023 or the EU/UK
GDPR. To exercise them, contact harishreyasv@gmail.com.

This policy does not claim that Theeram is certified as compliant with any
particular data-protection regime.

## 12. Changes to this policy

This policy may be updated as Theeram changes. The effective date at the top
will change, and material changes will be signalled in the app. Continuing to
use Theeram after an update means you accept the revised policy.

## 13. Contact

Questions, requests or complaints:

**Harishreyas Vijay**
Email: harishreyasv@gmail.com
Address: Kumar Bhavan, Nellikala, Elanthoor, Pathanamthitta, Kerala 689643, India

---

*Theeram is an informational tool built on public weather data. It is not an
official flood warning service. In an emergency, follow Kerala SDMA, NDMA and
local authority instructions.*
