// Theeram — FCM delivery for alert decisions.
//
// Reads alertDecisions that have not been delivered, works out who should be
// told, and sends one consolidated notification per recipient. It does NOT
// decide anything: the risk engine and the alert state machine (including the
// 3-hour exit hysteresis and the 12-hour sustained cooldown) are untouched and
// remain the sole source of what constitutes an alert.
//
// Why it reads decisions back from Firestore rather than taking them from the
// run that just produced them: the alertDecisions write happens inside the
// per-location transaction in run.js, so if the process dies between that
// commit and the send, the alert state has already advanced and no future run
// will re-decide it. Querying `delivered == false` recovers those, and makes
// detection and delivery independently restartable.
//
// Semantics are deliberately AT-LEAST-ONCE. A duplicate flood warning is an
// annoyance; a missed one is the system failing at the only job it has.
//
// The model behind these notifications is a rainfall-and-elevation proxy, not
// a hydrological forecast. Every message says so, and points at the official
// sources, because a lock-screen alert at 3am carries far more implied
// authority than the same sentence inside an app someone chose to open.

import { FieldValue } from 'firebase-admin/firestore';

// FCM accepts at most 500 messages per sendEach() call.
export const FCM_BATCH_LIMIT = 500;

// How long a claimed-but-unsent decision stays claimed before another run may
// retry it. The scheduler's concurrency group already stops scheduled runs
// overlapping; this covers a manual run beside a scheduled one, and a run that
// dies mid-send.
export const CLAIM_LEASE_MS = 10 * 60 * 1000;

// One pass will not try to deliver more than this many decisions.
export const MAX_DECISIONS_PER_RUN = 500;

// Retirement. A decision that cannot be delivered has to stop being retried,
// or permanently-undeliverable decisions (a family that uninstalled, a member
// whose only token died) accumulate until they fill the MAX_DECISIONS_PER_RUN
// query and starve live alerts. Runs are hourly, so ~6 attempts is ~6 hours;
// the age cutoff catches decisions the monitor could not reach for a while.
// A 13-hour-old flood warning is worse than no warning at all.
export const MAX_DELIVERY_ATTEMPTS = 6;
export const MAX_DECISION_AGE_MS = 12 * 60 * 60 * 1000;

// The ONLY shape of user-document field path this module may write. users/{uid}
// also holds phone and emergencyContact; the Admin SDK bypasses security rules,
// so this guard is the actual control preventing a bug here from clobbering
// somebody's profile.
const DEVICE_PATH_RE = /^devices\.[0-9a-f]{64}$/;

export function assertDevicePath(path) {
  if (!DEVICE_PATH_RE.test(String(path))) {
    throw new Error(`notify refused a non-device user field path: ${String(path)}`);
  }
  return path;
}

export function deviceFieldPath(deviceKey) {
  return assertDevicePath(`devices.${deviceKey}`);
}

// Same reasoning one collection over. Recipient uids come from member document
// ids, and a dotted update path is how Firestore addresses a nested field — so
// an id containing a dot would let a write escape `recipients` and land on
// `delivered`, `episodeId`, or any other decision field. The character class
// excludes '.', which is the point.
const RECIPIENT_PATH_RE = /^recipients\.[A-Za-z0-9_-]{1,128}$/;

export function assertRecipientPath(path) {
  if (!RECIPIENT_PATH_RE.test(String(path))) {
    throw new Error(`notify refused a non-recipient decision field path: ${String(path)}`);
  }
  return path;
}

export function recipientFieldPath(uid) {
  return assertRecipientPath(`recipients.${uid}`);
}

/** True when a uid is safe to use as a `recipients.<uid>` path segment. */
export function isValidRecipientUid(uid) {
  try { recipientFieldPath(uid); return true; } catch { return false; }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function chunk(items, size = FCM_BATCH_LIMIT) {
  if (!(size > 0)) throw new Error('chunk size must be positive');
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * A decision may be claimed if it is undelivered and either unclaimed or its
 * lease has expired. Pure so the race semantics are testable without an
 * emulator; run.js's transaction applies it atomically.
 */
export function isClaimable(decision, nowMs, leaseMs = CLAIM_LEASE_MS) {
  if (!decision || decision.delivered === true) return false;
  const claimedAt = decision.claimedAt ? Date.parse(decision.claimedAt) : NaN;
  if (!Number.isFinite(claimedAt)) return true;
  return (nowMs - claimedAt) >= leaseMs;
}

/**
 * FCM error code -> what to do with the token.
 * Codes arrive as 'messaging/<code>'; bare codes are accepted too.
 */
export function classifyFcmError(code) {
  const c = String(code || '').replace(/^messaging\//, '');
  if (c === 'registration-token-not-registered') return 'delete';
  if (c === 'invalid-registration-token') return 'delete';
  // Almost always our payload rather than their token — deleting would punish
  // the user for our bug.
  if (c === 'invalid-argument') return 'retain-log';
  return 'retain';
}

/**
 * One recipient's ledger entry, with the defaults a decision written before
 * the ledger existed implies: nobody delivered, nothing attempted.
 */
export function recipientState(decision, uid) {
  const entry = ((decision && decision.recipients) || {})[uid];
  if (!entry || typeof entry !== 'object') {
    return { delivered: false, attempts: 0, lastCode: null, deliveredAt: null };
  }
  return {
    delivered: entry.delivered === true,
    attempts: Number.isFinite(entry.attempts) ? entry.attempts : 0,
    lastCode: entry.lastCode == null ? null : String(entry.lastCode),
    deliveredAt: entry.deliveredAt || null
  };
}

/** Members who have not yet been reached for this decision. */
export function outstandingRecipients(decision, memberUids) {
  return memberUids.filter(uid => !recipientState(decision, uid).delivered);
}

/**
 * Why this decision should stop being retried, or null to keep trying.
 * Age is checked first: it is the more fundamental reason, and a stale warning
 * should be dropped even if the attempt budget is untouched.
 */
export function retirementReason(decision, nowMs, attemptsAfter, opts = {}) {
  const maxAttempts = opts.maxAttempts == null ? MAX_DELIVERY_ATTEMPTS : opts.maxAttempts;
  const maxAgeMs = opts.maxAgeMs == null ? MAX_DECISION_AGE_MS : opts.maxAgeMs;
  const decidedAt = decision && decision.decidedAt ? Date.parse(decision.decidedAt) : NaN;
  if (Number.isFinite(decidedAt) && (nowMs - decidedAt) >= maxAgeMs) return 'stale';
  if (attemptsAfter >= maxAttempts) return 'exhausted';
  return null;
}

export function groupBy(items, keyFn) {
  const m = new Map();
  for (const it of items) {
    const k = keyFn(it);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(it);
  }
  return m;
}

/** Enabled devices only, as {deviceKey, token} pairs. */
export function enabledDevices(userData) {
  const devices = (userData && userData.devices) || {};
  const out = [];
  for (const [deviceKey, d] of Object.entries(devices)) {
    if (!d || d.enabled !== true) continue;
    if (typeof d.token !== 'string' || !d.token) continue;
    if (!/^[0-9a-f]{64}$/.test(deviceKey)) continue;   // ignore malformed keys
    out.push({ deviceKey, token: d.token });
  }
  return out;
}

const LEVEL_ICON = { Severe: '🆘', High: '⚠️' };

function placeLabel(d) {
  return d.placeName || 'a saved place';
}

function joinPlaces(names) {
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} more`;
}

// The framing is not decoration. It is the difference between an informational
// signal and something a person might treat as an evacuation order.
const FRAMING = 'This is a rainfall-based estimate, not an official forecast. ' +
  'Follow KSDMA / NDMA and local authority instructions.';

/**
 * One consolidated notification for one recipient, covering every decision
 * that affects them this pass.
 *
 * @param {Array} decisions  enriched decisions: {kind, level, placeName, isOwn}
 * @returns {{title:string, body:string}}
 */
export function buildNotification(decisions) {
  const alerts = decisions.filter(d => d.kind !== 'all_clear');
  const clears = decisions.filter(d => d.kind === 'all_clear');

  // All-clear only.
  if (!alerts.length && clears.length) {
    const names = clears.map(placeLabel);
    return {
      title: clears.length === 1
        ? `✅ Flood risk has passed — ${names[0]}`
        : `✅ Flood risk has passed at ${clears.length} places`,
      body: `${joinPlaces(names)} ${clears.length === 1 ? 'is' : 'are'} back to normal rainfall levels. ${FRAMING}`
    };
  }

  const severe = alerts.filter(a => a.level === 'Severe');
  const worst = severe.length ? 'Severe' : 'High';
  const icon = LEVEL_ICON[worst] || '⚠️';
  const names = alerts.map(placeLabel);

  let title;
  if (alerts.length === 1) {
    const a = alerts[0];
    const verb = a.kind === 'escalation' ? 'escalated to' : a.kind === 'sustained' ? 'still at' : '';
    title = verb
      ? `${icon} ${names[0]} ${verb} ${a.level.toLowerCase()} flood risk`
      : `${icon} ${a.level} flood risk — ${names[0]}`;
  } else {
    title = `${icon} ${alerts.length} saved places at flood risk`;
  }

  const lead = alerts.length === 1
    ? (alerts[0].reason || 'Heavy rainfall recorded near this saved place.')
    : `${joinPlaces(names)} — heavy rainfall recorded nearby.`;

  const tail = clears.length
    ? ` ${joinPlaces(clears.map(placeLabel))} ${clears.length === 1 ? 'has' : 'have'} returned to normal.`
    : '';

  return { title, body: `${lead}${tail} ${FRAMING}` };
}

/**
 * FCM data payload. IDENTIFIERS ONLY — never coordinates, phone numbers,
 * emergency contacts, or any profile field. `data` is readable by the OS and
 * by anything handling the intent, so it carries only what the app needs to
 * route a tap.
 */
export function buildDataPayload(decisions) {
  const first = decisions[0] || {};
  return {
    type: 'flood_alert',
    count: String(decisions.length),
    familyId: String(first.familyId || ''),
    locationId: String(first.locationId || ''),
    kind: String(first.kind || ''),
    level: String(first.level || ''),
    episodeId: String(first.episodeId == null ? '' : first.episodeId)
  };
}

/** One FCM Message per (recipient, device). */
export function buildMessages(recipients) {
  const messages = [];
  for (const r of recipients) {
    if (!r.devices || !r.devices.length) continue;      // no devices: safe no-op
    if (!r.decisions || !r.decisions.length) continue;
    const notification = buildNotification(r.decisions);
    const data = buildDataPayload(r.decisions);
    const decisionIds = r.decisions.map(d => d.id);
    for (const dev of r.devices) {
      messages.push({
        _meta: { uid: r.uid, deviceKey: dev.deviceKey, decisionIds },
        token: dev.token,
        notification,
        data,
        android: {
          priority: 'high',
          notification: { channelId: 'theeram-flood-alerts' }
        }
      });
    }
  }
  return messages;
}

/** Strip the internal routing field before the message reaches FCM. */
export function toWireMessage(m) {
  const { _meta, ...wire } = m;
  return wire;
}

// ---------------------------------------------------------------------------
// Notifier — the dry-run boundary
// ---------------------------------------------------------------------------

/**
 * In dry-run the real Messaging object is NEVER constructed: getMessaging is
 * not called, so there is no branch anywhere that could fall through to a live
 * send. That is a structural guarantee rather than a conditional inside the
 * send path.
 */
export function createNotifier({ getMessaging, dryRun = false, logger = console } = {}) {
  if (dryRun) {
    return {
      dryRun: true,
      async sendEach(messages) {
        logger.log(`[notify] DRY RUN — ${messages.length} message(s) would be sent, 0 sent`);
        return {
          successCount: messages.length,
          failureCount: 0,
          responses: messages.map(() => ({ success: true, messageId: 'dry-run' })),
          simulated: true
        };
      }
    };
  }
  if (typeof getMessaging !== 'function') {
    throw new Error('createNotifier: getMessaging is required for a live notifier');
  }
  let messaging = null;
  return {
    dryRun: false,
    async sendEach(messages) {
      if (!messaging) messaging = getMessaging();

      if (typeof messaging.sendEach === 'function') {
        return messaging.sendEach(messages);
      }

      const responses = await Promise.all(
        messages.map(async (message) => {
          try {
            const messageId = await messaging.send(message);
            return { success: true, messageId };
          } catch (error) {
            return { success: false, error };
          }
        })
      );

      return {
        successCount: responses.filter((r) => r.success).length,
        failureCount: responses.filter((r) => !r.success).length,
        responses
      };
    }
  };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Deliver every undelivered alert decision.
 *
 * Never throws for ordinary trouble — a family with no registered devices is
 * the normal state until everyone reinstalls, and a send failure must leave
 * the decision for the next hourly run rather than abort the monitor.
 */
export async function notifyUndelivered(deps) {
  const {
    db, notifier,
    now = () => Date.now(),
    logger = console,
    runId = `run-${Date.now()}`,
    dryRun = false,
    leaseMs = CLAIM_LEASE_MS,
    limit = MAX_DECISIONS_PER_RUN,
    maxAttempts = MAX_DELIVERY_ATTEMPTS,
    maxAgeMs = MAX_DECISION_AGE_MS
  } = deps;

  const summary = {
    considered: 0, claimed: 0, skipped: 0,
    recipients: 0, devices: 0,
    sent: 0, failures: 0,
    delivered: 0, retained: 0, retired: 0,
    tokensRemoved: 0,
    dryRun
  };
  if (!notifier) return summary;

  // ---- 1. undelivered decisions ------------------------------------------
  const snap = await db.collection('alertDecisions')
    .where('delivered', '==', false).limit(limit).get();
  summary.considered = snap.size;
  if (snap.empty) return summary;

  const nowMs = now();

  // ---- 2. claim (atomic per decision) ------------------------------------
  const claimed = [];
  for (const docSnap of snap.docs) {
    if (dryRun) {
      // Dry run must not write. Evaluate claimability so the report is
      // honest about what a live run would have picked up.
      if (isClaimable(docSnap.data(), nowMs, leaseMs)) claimed.push({ id: docSnap.id, ...docSnap.data() });
      else summary.skipped++;
      continue;
    }
    try {
      const got = await db.runTransaction(async (tx) => {
        const fresh = await tx.get(docSnap.ref);
        if (!fresh.exists) return null;
        const d = fresh.data();
        if (!isClaimable(d, nowMs, leaseMs)) return null;
        tx.update(docSnap.ref, {
          claimedAt: new Date(nowMs).toISOString(),
          claimedBy: runId
        });
        return { id: fresh.id, ...d };
      });
      if (got) claimed.push(got); else summary.skipped++;
    } catch (err) {
      summary.skipped++;
      logger.warn(`[notify] claim failed for ${docSnap.id}: ${String(err && err.message || err)}`);
    }
  }
  summary.claimed = claimed.length;
  if (!claimed.length) return summary;

  // ---- 3. enrich: place names and OUTSTANDING family membership ----------
  // Outstanding is the whole point of the ledger: a member already recorded as
  // delivered for a decision is not a recipient of it again, so a retry reaches
  // exactly the people the previous pass missed.
  const byFamily = groupBy(claimed, d => d.familyId);
  const recipientsMap = new Map();   // uid -> { uid, decisions[] }
  const metaById = new Map();        // decisionId -> { memberUids, outstanding, membersReadable }

  for (const [familyId, decisions] of byFamily) {
    let memberUids = null;           // null means "could not be determined"
    if (!familyId) {
      memberUids = [];
    } else {
      try {
        const members = await db.collection('families').doc(familyId).collection('members').get();
        memberUids = members.docs.map(m => m.id).filter(uid => {
          if (isValidRecipientUid(uid)) return true;
          // Cannot be ledgered, so cannot be tracked to at-least-once.
          logger.warn('[notify] skipping a member whose id is not a usable ledger key');
          return false;
        });
      } catch (err) {
        logger.warn(`[notify] could not read members of ${familyId}: ${String(err && err.message || err)}`);
        memberUids = null;
      }
    }

    for (const d of decisions) {
      if (memberUids === null) {
        metaById.set(d.id, { memberUids: [], outstanding: [], membersReadable: false });
        continue;
      }
      const outstanding = outstandingRecipients(d, memberUids);
      metaById.set(d.id, { memberUids, outstanding, membersReadable: true });
      if (!outstanding.length) continue;

      // Place names for the notification text. Read only for decisions that
      // still have someone to reach — this is not a per-run cost.
      let placeName = null, reason = null;
      try {
        const locSnap = await db.collection('families').doc(familyId)
          .collection('locations').doc(d.locationId).get();
        if (locSnap.exists) {
          const l = locSnap.data();
          placeName = l.name || null;
          reason = (l.risk && l.risk.reason) || null;
        }
      } catch { /* name is cosmetic; carry on without it */ }
      const enriched = { ...d, placeName, reason };

      for (const uid of outstanding) {
        if (!recipientsMap.has(uid)) recipientsMap.set(uid, { uid, decisions: [] });
        recipientsMap.get(uid).decisions.push(enriched);
      }
    }
  }

  // ---- 4. devices --------------------------------------------------------
  const recipients = [];
  for (const r of recipientsMap.values()) {
    let devices = [];
    try {
      const userSnap = await db.collection('users').doc(r.uid).get();
      // Only `devices` is ever touched. phone and emergencyContact live on
      // this document and are neither read into a variable nor logged.
      devices = userSnap.exists ? enabledDevices(userSnap.data()) : [];
    } catch (err) {
      logger.warn(`[notify] could not read devices for a recipient: ${String(err && err.message || err)}`);
      devices = [];
    }
    recipients.push({ ...r, devices });
  }
  summary.recipients = recipients.length;
  summary.devices = recipients.reduce((n, r) => n + r.devices.length, 0);

  // ---- 5. build + send ---------------------------------------------------
  // No messages is NOT an early exit any more: recipients with zero devices
  // still need this pass recorded against them, or a decision nobody can
  // receive would be retried forever and eventually starve the queue.
  const messages = buildMessages(recipients);
  if (!messages.length) {
    logger.log('[notify] no registered devices for any outstanding recipient; nothing to send');
  }

  const successByDecision = new Map();   // decisionId -> device success count
  const failureByDecision = new Map();
  const recipientOk = new Set();         // `${decisionId} ${uid}`
  const recipientCode = new Map();       // same key -> last failure code seen
  const toRemove = [];                   // {uid, deviceKey}
  const rkey = (id, uid) => `${id} ${uid}`;

  for (const batch of chunk(messages, FCM_BATCH_LIMIT)) {
    let res;
    try {
      res = await notifier.sendEach(batch.map(toWireMessage));
    } catch (err) {
      // Whole batch failed (network, auth). Retain everything for retry.
      summary.failures += batch.length;
      logger.warn(`[notify] batch send failed: ${String(err && err.message || err)}`);
      const code = (err && err.code) || 'batch-error';
      for (const m of batch) {
        for (const id of m._meta.decisionIds) {
          failureByDecision.set(id, (failureByDecision.get(id) || 0) + 1);
          recipientCode.set(rkey(id, m._meta.uid), String(code));
        }
      }
      continue;
    }

    const responses = (res && res.responses) || [];
    batch.forEach((m, i) => {
      const r = responses[i] || { success: false };
      if (!r.success) {
        logger.warn(`[notify] FCM send error: ${String(r.error && (r.error.message || r.error.code) || r.error || 'unknown error')}`);
      }
      if (r.success) {
        summary.sent++;
        for (const id of m._meta.decisionIds) {
          successByDecision.set(id, (successByDecision.get(id) || 0) + 1);
          // Any one accepted device reaches the person. That is the unit the
          // ledger guarantees; a second device is redundancy, not a promise.
          recipientOk.add(rkey(id, m._meta.uid));
        }
        return;
      }
      summary.failures++;
      const code = r.error && (r.error.code || r.error.errorInfo && r.error.errorInfo.code);
      for (const id of m._meta.decisionIds) {
        failureByDecision.set(id, (failureByDecision.get(id) || 0) + 1);
        recipientCode.set(rkey(id, m._meta.uid), String(code || 'unknown'));
      }
      const verdict = classifyFcmError(code);
      if (verdict === 'delete') {
        toRemove.push({ uid: m._meta.uid, deviceKey: m._meta.deviceKey });
      } else if (verdict === 'retain-log') {
        logger.warn(`[notify] invalid-argument for a message; token retained (code=${code})`);
      }
    });
  }

  // ---- 6. stale token cleanup -------------------------------------------
  if (!dryRun && toRemove.length) {
    const seen = new Set();
    for (const { uid, deviceKey } of toRemove) {
      const k = `${uid}:${deviceKey}`;
      if (seen.has(k)) continue;
      seen.add(k);
      try {
        const path = deviceFieldPath(deviceKey);   // throws unless devices.<sha256>
        await db.collection('users').doc(uid).update({ [path]: FieldValue.delete() });
        summary.tokensRemoved++;
      } catch (err) {
        logger.warn(`[notify] could not remove a stale device: ${String(err && err.message || err)}`);
      }
    }
  }

  // ---- 7. update the ledger and settle each decision ---------------------
  // A decision is delivered only when NO delivery work remains: every member
  // reached, or the decision retired. One lucky recipient no longer speaks for
  // the rest of the family.
  const nowIso = new Date(now()).toISOString();

  for (const d of claimed) {
    const meta = metaById.get(d.id) || { memberUids: [], outstanding: [], membersReadable: false };
    const ok = successByDecision.get(d.id) || 0;
    const bad = failureByDecision.get(d.id) || 0;
    const attemptsAfter = (Number.isFinite(d.attempts) ? d.attempts : 0) + 1;

    // Per-recipient ledger entries for everyone we tried to reach this pass.
    const ledger = {};
    const missed = [];
    for (const uid of meta.outstanding) {
      const reached = recipientOk.has(rkey(d.id, uid));
      const prev = recipientState(d, uid);
      ledger[recipientFieldPath(uid)] = {
        delivered: reached,
        attempts: prev.attempts + 1,
        // 'no-devices' is the honest code when nothing was even built for them.
        lastCode: reached ? null : (recipientCode.get(rkey(d.id, uid)) || 'no-devices'),
        deliveredAt: reached ? nowIso : prev.deliveredAt
      };
      if (!reached) missed.push(uid);
    }

    // Work remains if someone was missed, or if we could not even establish
    // who the recipients are, or if the family has no members to reach yet.
    const workRemains = missed.length > 0 || !meta.membersReadable || meta.memberUids.length === 0;
    const reason = workRemains ? retirementReason(d, nowMs, attemptsAfter, { maxAttempts, maxAgeMs }) : null;

    if (dryRun) {
      if (!workRemains) summary.delivered++;
      else if (reason) summary.retired++;
      else summary.retained++;
      continue;
    }

    const patch = {
      ...ledger,
      attempts: attemptsAfter,
      deliveredCount: ok,
      failureCount: bad,
      claimedAt: null,
      claimedBy: null
    };

    if (!workRemains) {
      patch.delivered = true;
      patch.deliveredAt = nowIso;
      patch.retiredReason = null;
      patch.undeliveredTo = [];
      summary.delivered++;
    } else if (reason) {
      // Give up, but leave behind exactly who never got it and why.
      patch.delivered = true;
      patch.retiredReason = reason;
      patch.retiredAt = nowIso;
      patch.undeliveredTo = missed;
      summary.retired++;
      logger.warn('[notify] RETIRED ' + JSON.stringify({
        decisionId: d.id, reason, attempts: attemptsAfter, undeliveredTo: missed.length
      }));
    } else {
      // Still worth another hour. Claim released so the next run picks it up.
      summary.retained++;
    }

    try {
      await db.collection('alertDecisions').doc(d.id).update(patch);
    } catch (err) {
      logger.warn(`[notify] could not update decision ${d.id}: ${String(err && err.message || err)}`);
    }
  }

  logger.log('[notify] ' + JSON.stringify({
    considered: summary.considered, claimed: summary.claimed,
    recipients: summary.recipients, devices: summary.devices,
    sent: summary.sent, failures: summary.failures,
    delivered: summary.delivered, retained: summary.retained,
    retired: summary.retired, tokensRemoved: summary.tokensRemoved, dryRun
  }));

  return summary;
}
