// The alert state machine from the Phase 2.3 design.
//
// Pure: no Firestore, no clock of its own, no I/O. Everything it needs is an
// argument, which is what makes every transition unit-testable without an
// emulator and what makes overlapping runs safe to reason about.
//
// NOTHING IS SENT IN THIS PHASE. decide() returns a DECISION describing the
// notification that would go out; the caller records it and updates state.
// When FCM lands, the send is bolted onto the decision — the detection logic
// below does not change.

// computeRisk() returns exactly these five levels. Anything unrecognised is
// treated as 'normal' rather than throwing: an unknown level must never be
// able to manufacture an alert.
const BAND_BY_LEVEL = Object.freeze({
  Minimal: 'normal',
  Low: 'normal',
  Moderate: 'normal',
  High: 'high',
  Severe: 'severe'
});

export const DEFAULTS = Object.freeze({
  // Phase 2.3: while a location stays in High/Severe, re-notify at most once
  // every 12 hours so a multi-day monsoon does not produce 24 pushes a day.
  sustainedReminderMs: 12 * 60 * 60 * 1000,

  // EXIT HYSTERESIS. Leaving the alert band does not immediately clear the
  // alert: the episode enters a "clearing" dwell and only ends if the level
  // stays out of the band for this long. Rainfall sitting near a threshold
  // crosses it repeatedly — r24 oscillating around 115.6mm would otherwise
  // emit an all-clear and a fresh alert every hour, which trains people to
  // ignore the notification that matters.
  //
  // Three hours is roughly three consecutive clean readings at the hourly
  // cadence. It is expressed as a duration rather than a run count so a
  // missed or delayed run does not restart the clock. Entry stays immediate:
  // slow to stand down, fast to warn.
  clearDwellMs: 3 * 60 * 60 * 1000
});

export function bandForLevel(level) {
  return BAND_BY_LEVEL[level] || 'normal';
}

export function isElevated(band) {
  return band === 'high' || band === 'severe';
}

// A fresh location, or one that predates this phase, has no alertState.
export function initialState() {
  return {
    band: 'normal',
    episodeId: null,
    enteredAt: null,
    // Set the first time an episode's level drops out of the alert band, and
    // cleared the moment it comes back. Non-null means "we are waiting to see
    // whether this recovery holds" — the episode is still open.
    clearingSince: null,
    // Reserved for real delivery. Deliberately left null/0 in this phase:
    // no notification has been sent, so claiming one was would be wrong, and
    // when FCM lands the first alert of an in-flight episode should still go
    // out. The cooldown below keys off lastDecisionAt instead.
    lastNotifiedLevel: null,
    lastNotifiedAt: null,
    notifyCount: 0,
    // Decision bookkeeping — what the monitor CONCLUDED, as opposed to what
    // was delivered.
    lastDecisionLevel: null,
    lastDecisionAt: null,
    decisionCount: 0
  };
}

/**
 * Decide what should happen for one location on one run.
 *
 * @param {object|null|undefined} previous  stored alertState, if any
 * @param {string} newLevel                 level from computeRisk()
 * @param {number} nowMs                    run timestamp, injected for tests
 * @param {object} [config]
 * @returns {{ state: object, decision: object|null }}
 *
 * decision.kind is one of:
 *   'first'      normal -> high | severe        (episode opens)
 *   'escalation' high -> severe                 (same episode)
 *   'sustained'  still elevated, cooldown spent
 *   'all_clear'  high | severe -> normal        (episode closes)
 */
export function decide(previous, newLevel, nowMs, config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const prev = previous && typeof previous === 'object'
    ? { ...initialState(), ...previous }
    : initialState();

  const prevBand = isElevated(prev.band) || prev.band === 'normal' ? prev.band : 'normal';
  const observedBand = bandForLevel(newLevel);

  // `band` is the ALERT band, which is not the same thing as the observed
  // band: during a clearing dwell the level has left the band but the alert
  // has not, so it is assigned per-branch rather than eagerly from the level.
  const state = { ...prev };
  let decision = null;

  const record = (kind, episodeId, decisionBand) => {
    decision = { kind, level: newLevel, band: decisionBand, episodeId, at: nowMs };
    state.lastDecisionLevel = newLevel;
    state.lastDecisionAt = nowMs;
    state.decisionCount = (prev.decisionCount || 0) + 1;
  };

  if (prevBand === 'normal') {
    state.clearingSince = null;
    if (observedBand === 'normal') {
      // Nothing to say. Keep the cleared episode fields stable so repeated
      // runs produce byte-identical state and therefore no spurious writes.
      state.band = 'normal';
      state.episodeId = null;
      state.enteredAt = null;
    } else {
      // Episode opens. episodeId is the entry timestamp and stays fixed for
      // the life of the episode, which is what makes decision ids
      // deterministic and a re-run of the same transition a no-op.
      state.band = observedBand;
      state.episodeId = nowMs;
      state.enteredAt = nowMs;
      record('first', nowMs, observedBand);
    }
  } else if (observedBand === 'normal') {
    // ---- inside an episode, level has dropped out of the alert band ----
    // The alert band is deliberately held at its previous value here: until
    // the dwell completes we have not concluded the episode is over, and
    // saying so early is exactly the flapping this guards against.
    state.band = prevBand;
    const since = prev.clearingSince;
    if (since == null) {
      // First clean reading. Start the clock and stay quiet.
      state.clearingSince = nowMs;
    } else if ((nowMs - since) >= cfg.clearDwellMs) {
      // The recovery held. Close the episode.
      state.band = 'normal';
      state.clearingSince = null;
      record('all_clear', prev.episodeId, 'normal');
      state.episodeId = null;
      state.enteredAt = null;
    }
    // else: still inside the dwell — keep clearingSince, decide nothing.
  } else {
    // ---- inside an episode, still (or again) in an alert band ----
    // Any elevated reading cancels an in-progress dwell: the recovery did not
    // hold, so the episode simply continues. No new 'first' is emitted,
    // because from the user's point of view the alert never ended.
    state.clearingSince = null;
    state.band = observedBand;

    if (prevBand === 'high' && observedBand === 'severe') {
      // Escalation inside the SAME episode: episodeId and enteredAt are kept
      // so the episode remains one continuous event rather than two.
      record('escalation', prev.episodeId, 'severe');
    } else if (prevBand === 'severe' && observedBand === 'high') {
      // De-escalation within the alert band. Phase 2.3: state update, no
      // alert. Telling someone the flood risk is now merely "High" is not
      // news worth a push, and it would reset attention for the eventual
      // all-clear.
    } else {
      // Same band as before. The sustained-reminder cooldown is unchanged and
      // still measured from the last decision, so a dip and recovery cannot
      // be used to trigger an early reminder.
      const last = prev.lastDecisionAt;
      if (last == null || (nowMs - last) >= cfg.sustainedReminderMs) {
        record('sustained', prev.episodeId, observedBand);
      }
    }
  }

  return { state, decision };
}

/**
 * Deterministic id for a decision record. Re-deciding the same transition
 * yields the same id, so a double write is an overwrite rather than a
 * duplicate alert — belt and braces alongside the transaction in run.js.
 */
export function decisionId(locationId, decision) {
  const parts = [locationId, decision.episodeId ?? 'none', decision.kind, decision.level];
  if (decision.kind === 'sustained') parts.push(String(decision.at));
  return parts.join('__');
}
