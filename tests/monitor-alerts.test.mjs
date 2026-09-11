// Alert state machine — pure unit tests, no emulator, no clock of its own.
// Run with: npm run test:monitor

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { decide, decisionId, bandForLevel, initialState, DEFAULTS } from '../monitor/alerts.js';

const T0 = 1_800_000_000_000;
const HOUR = 3600e3;
const step = (prev, level, at) => decide(prev, level, at);

describe('band mapping', () => {
  test('only High and Severe are elevated', () => {
    assert.equal(bandForLevel('Minimal'), 'normal');
    assert.equal(bandForLevel('Low'), 'normal');
    assert.equal(bandForLevel('Moderate'), 'normal');
    assert.equal(bandForLevel('High'), 'high');
    assert.equal(bandForLevel('Severe'), 'severe');
  });
  test('an unknown level can never manufacture an alert', () => {
    assert.equal(bandForLevel('Catastrophic'), 'normal');
    assert.equal(bandForLevel(undefined), 'normal');
    assert.equal(step(null, 'Catastrophic', T0).decision, null);
  });
});

describe('transitions', () => {
  test('normal -> high opens an episode and decides "first"', () => {
    const { state, decision } = step(null, 'High', T0);
    assert.equal(decision.kind, 'first');
    assert.equal(decision.level, 'High');
    assert.equal(state.band, 'high');
    assert.equal(state.episodeId, T0);
    assert.equal(state.enteredAt, T0);
    assert.equal(state.decisionCount, 1);
  });

  test('normal -> severe decides "first"', () => {
    const { state, decision } = step(null, 'Severe', T0);
    assert.equal(decision.kind, 'first');
    assert.equal(state.band, 'severe');
  });

  test('high -> severe decides "escalation" and KEEPS the episode', () => {
    const a = step(null, 'High', T0);
    const b = step(a.state, 'Severe', T0 + HOUR);
    assert.equal(b.decision.kind, 'escalation');
    assert.equal(b.state.band, 'severe');
    assert.equal(b.state.episodeId, T0, 'escalation must stay in the same episode');
    assert.equal(b.state.enteredAt, T0);
    assert.equal(b.state.decisionCount, 2);
  });

  test('severe -> high updates state and decides NOTHING', () => {
    const a = step(null, 'Severe', T0);
    const b = step(a.state, 'High', T0 + HOUR);
    assert.equal(b.decision, null);
    assert.equal(b.state.band, 'high');
    assert.equal(b.state.episodeId, T0);
    assert.equal(b.state.decisionCount, 1, 'no new decision was made');
  });

  // NOTE: leaving the band no longer clears immediately — it opens a dwell.
  // See the "exit hysteresis" block below for the full behaviour.
  test('high -> normal starts the dwell and stays quiet', () => {
    const a = step(null, 'High', T0);
    const b = step(a.state, 'Low', T0 + HOUR);
    assert.equal(b.decision, null, 'a single clean reading must not clear');
    assert.equal(b.state.band, 'high', 'the alert band is held during the dwell');
    assert.equal(b.state.clearingSince, T0 + HOUR);
    assert.equal(b.state.episodeId, T0, 'the episode is still open');
  });

  test('high -> normal held past the dwell decides "all_clear"', () => {
    const a = step(null, 'High', T0);
    const b = step(a.state, 'Low', T0 + HOUR);
    const c = step(b.state, 'Low', T0 + HOUR + DEFAULTS.clearDwellMs);
    assert.equal(c.decision.kind, 'all_clear');
    assert.equal(c.decision.episodeId, T0);
    assert.equal(c.state.band, 'normal');
    assert.equal(c.state.episodeId, null);
    assert.equal(c.state.enteredAt, null);
    assert.equal(c.state.clearingSince, null);
  });

  test('severe -> normal held past the dwell decides "all_clear"', () => {
    const a = step(null, 'Severe', T0);
    const b = step(a.state, 'Minimal', T0 + HOUR);
    assert.equal(b.decision, null);
    const c = step(b.state, 'Minimal', T0 + HOUR + DEFAULTS.clearDwellMs);
    assert.equal(c.decision.kind, 'all_clear');
    assert.equal(c.state.band, 'normal');
  });

  test('normal -> normal decides nothing', () => {
    for (const l of ['Minimal', 'Low', 'Moderate']) {
      assert.equal(step(null, l, T0).decision, null);
    }
  });

  test('unchanged high within the cooldown decides nothing', () => {
    const a = step(null, 'High', T0);
    const b = step(a.state, 'High', T0 + HOUR);
    assert.equal(b.decision, null);
    assert.equal(b.state.band, 'high');
  });

  test('unchanged severe within the cooldown decides nothing', () => {
    const a = step(null, 'Severe', T0);
    const b = step(a.state, 'Severe', T0 + 6 * HOUR);
    assert.equal(b.decision, null);
  });
});

describe('sustained reminder cooldown', () => {
  test('fires once the 12h threshold is reached, not before', () => {
    const a = step(null, 'High', T0);
    assert.equal(step(a.state, 'High', T0 + DEFAULTS.sustainedReminderMs - 1).decision, null);
    const c = step(a.state, 'High', T0 + DEFAULTS.sustainedReminderMs);
    assert.equal(c.decision.kind, 'sustained');
    assert.equal(c.state.lastDecisionAt, T0 + DEFAULTS.sustainedReminderMs);
  });

  test('the cooldown restarts after each reminder', () => {
    const a = step(null, 'Severe', T0);
    const b = step(a.state, 'Severe', T0 + DEFAULTS.sustainedReminderMs);
    assert.equal(b.decision.kind, 'sustained');
    assert.equal(step(b.state, 'Severe', T0 + DEFAULTS.sustainedReminderMs + HOUR).decision, null);
  });

  test('the interval is configurable', () => {
    const a = step(null, 'High', T0);
    const b = decide(a.state, 'High', T0 + 2 * HOUR, { sustainedReminderMs: HOUR });
    assert.equal(b.decision.kind, 'sustained');
  });

  test('escalation resets the cooldown, so no reminder immediately after', () => {
    const a = step(null, 'High', T0);
    const b = step(a.state, 'Severe', T0 + 11 * HOUR);
    assert.equal(b.decision.kind, 'escalation');
    assert.equal(step(b.state, 'Severe', T0 + 12 * HOUR).decision, null);
  });
});

describe('exit hysteresis — threshold flapping', () => {
  const DWELL = DEFAULTS.clearDwellMs;

  test('a single-run dip below the threshold produces NO decision at all', () => {
    const a = step(null, 'High', T0);                 // first
    const b = step(a.state, 'Moderate', T0 + HOUR);   // dip
    const c = step(b.state, 'High', T0 + 2 * HOUR);   // back
    assert.equal(b.decision, null, 'the dip must not clear');
    assert.equal(c.decision, null, 'the recovery must not re-alert');
  });

  test('recovery cancels the dwell and keeps the SAME episode', () => {
    const a = step(null, 'High', T0);
    const b = step(a.state, 'Moderate', T0 + HOUR);
    assert.equal(b.state.clearingSince, T0 + HOUR);
    const c = step(b.state, 'High', T0 + 2 * HOUR);
    assert.equal(c.state.clearingSince, null, 'dwell must be cancelled');
    assert.equal(c.state.episodeId, T0, 'the episode must not restart');
    assert.equal(c.state.band, 'high');
  });

  // The behaviour this whole feature exists for: rainfall parked on a
  // threshold. Before hysteresis this emitted 12 notifications; now it
  // emits the one that matters.
  test('12 hours of oscillating across the threshold yields exactly ONE decision', () => {
    let s = initialState();
    let decisions = [];
    for (let i = 0; i < 12; i++) {
      const level = i % 2 === 0 ? 'High' : 'Moderate';   // flap every hour
      const out = decide(s, level, T0 + i * HOUR);
      s = out.state;
      if (out.decision) decisions.push(out.decision.kind);
    }
    assert.deepEqual(decisions, ['first'], `got ${JSON.stringify(decisions)}`);
    assert.equal(s.episodeId, T0, 'still the original episode');
  });

  test('a dwell that is interrupted and later restarted clears only once', () => {
    let s = step(null, 'High', T0).state;
    s = step(s, 'Low', T0 + HOUR).state;               // dwell starts
    s = step(s, 'High', T0 + 2 * HOUR).state;          // cancelled
    const restart = step(s, 'Low', T0 + 3 * HOUR);     // dwell restarts
    assert.equal(restart.decision, null);
    assert.equal(restart.state.clearingSince, T0 + 3 * HOUR, 'clock restarts from the new dip');
    // The elapsed time is measured from the RESTART, not the first dip.
    const tooEarly = step(restart.state, 'Low', T0 + 3 * HOUR + DWELL - 1);
    assert.equal(tooEarly.decision, null);
    const cleared = step(tooEarly.state, 'Low', T0 + 3 * HOUR + DWELL);
    assert.equal(cleared.decision.kind, 'all_clear');
  });

  test('the dwell boundary is inclusive', () => {
    const a = step(null, 'Severe', T0);
    const b = step(a.state, 'Minimal', T0 + HOUR);
    assert.equal(step(b.state, 'Minimal', T0 + HOUR + DWELL - 1).decision, null);
    assert.equal(step(b.state, 'Minimal', T0 + HOUR + DWELL).decision.kind, 'all_clear');
  });

  test('the dwell is configurable', () => {
    const a = decide(null, 'High', T0, { clearDwellMs: HOUR });
    const b = decide(a.state, 'Low', T0 + HOUR, { clearDwellMs: HOUR });
    assert.equal(b.decision, null);
    const c = decide(b.state, 'Low', T0 + 2 * HOUR, { clearDwellMs: HOUR });
    assert.equal(c.decision.kind, 'all_clear');
  });

  test('escalation still fires if severity returns DURING a dwell', () => {
    const a = step(null, 'High', T0);
    const b = step(a.state, 'Moderate', T0 + HOUR);    // dip
    const c = step(b.state, 'Severe', T0 + 2 * HOUR);  // straight to Severe
    assert.equal(c.decision.kind, 'escalation', 'a dip must not mask an escalation');
    assert.equal(c.state.episodeId, T0);
    assert.equal(c.state.clearingSince, null);
  });

  test('a severe episode dipping and returning at High stays silent', () => {
    const a = step(null, 'Severe', T0);
    const b = step(a.state, 'Low', T0 + HOUR);
    const c = step(b.state, 'High', T0 + 2 * HOUR);
    assert.equal(c.decision, null);
    assert.equal(c.state.band, 'high');
    assert.equal(c.state.episodeId, T0);
  });

  test('a dip cannot be used to trigger an early sustained reminder', () => {
    // The cooldown is measured from the last DECISION, so flapping does not
    // reset it — otherwise an oscillating value would still spam reminders.
    let s = step(null, 'High', T0).state;
    s = step(s, 'Moderate', T0 + HOUR).state;
    const back = step(s, 'High', T0 + 2 * HOUR);
    assert.equal(back.decision, null);
    const stillEarly = step(back.state, 'High', T0 + 11 * HOUR);
    assert.equal(stillEarly.decision, null);
    const due = step(stillEarly.state, 'High', T0 + 12 * HOUR);
    assert.equal(due.decision.kind, 'sustained', 'cooldown still measured from T0');
  });

  test('a genuine recovery eventually clears even if it plateaus at Moderate', () => {
    // Moderate is inside the normal band, so a plateau there still clears.
    // This is why the dwell is time-based rather than requiring the level to
    // fall all the way to Minimal — otherwise an episode could never end.
    let s = step(null, 'Severe', T0).state;
    let cleared = null;
    for (let i = 1; i <= 6 && !cleared; i++) {
      const out = step(s, 'Moderate', T0 + i * HOUR);
      s = out.state;
      if (out.decision) cleared = out.decision;
    }
    assert.ok(cleared, 'must clear within a few hours of sustained recovery');
    assert.equal(cleared.kind, 'all_clear');
    assert.equal(s.band, 'normal');
  });

  test('state predating this change (no clearingSince) starts a fresh dwell', () => {
    const legacy = { band: 'high', episodeId: T0, enteredAt: T0, lastDecisionAt: T0, decisionCount: 1 };
    const b = step(legacy, 'Low', T0 + HOUR);
    assert.equal(b.decision, null, 'must not clear on the first clean reading');
    assert.equal(b.state.clearingSince, T0 + HOUR);
  });

  test('re-running the same clean reading does not advance the dwell clock', () => {
    const a = step(null, 'High', T0);
    const b = step(a.state, 'Low', T0 + HOUR);
    const again = step(b.state, 'Low', T0 + HOUR + 60e3);
    assert.equal(again.state.clearingSince, T0 + HOUR, 'clock is anchored to the first dip');
    assert.equal(again.decision, null);
  });
});

describe('idempotency and overlap', () => {
  test('re-running the SAME transition decides nothing the second time', () => {
    const a = step(null, 'High', T0);
    assert.equal(a.decision.kind, 'first');
    const b = step(a.state, 'High', T0 + 60e3);
    assert.equal(b.decision, null, 'a duplicate run must not re-alert');
  });

  test('two passes reading the SAME stale state both decide — which is why the write is transactional', () => {
    // Documents the hazard the transaction in run.js exists to prevent: given
    // identical input state, decide() is deterministic and will conclude the
    // same transition twice. Serialising the read-modify-write is what stops
    // the second pass ever seeing the stale state.
    const stale = initialState();
    const p1 = step(stale, 'High', T0);
    const p2 = step(stale, 'High', T0 + 1000);
    assert.equal(p1.decision.kind, 'first');
    assert.equal(p2.decision.kind, 'first');
    // ...and once the first pass's state is visible, the second is silent.
    assert.equal(step(p1.state, 'High', T0 + 1000).decision, null);
  });

  test('decision ids are deterministic for the same transition', () => {
    const a = step(null, 'High', T0);
    const b = step(null, 'High', T0);
    assert.equal(decisionId('loc1', a.decision), decisionId('loc1', b.decision));
    assert.equal(decisionId('loc1', a.decision), 'loc1__' + T0 + '__first__High');
  });

  test('sustained reminder ids differ per reminder', () => {
    const a = step(null, 'High', T0);
    const b = step(a.state, 'High', T0 + DEFAULTS.sustainedReminderMs);
    const c = step(b.state, 'High', T0 + 2 * DEFAULTS.sustainedReminderMs);
    assert.notEqual(decisionId('loc1', b.decision), decisionId('loc1', c.decision));
  });

  test('a new episode after a COMPLETED all-clear gets a fresh episodeId', () => {
    const a = step(null, 'High', T0);
    const b = step(a.state, 'Low', T0 + HOUR);
    const cleared = step(b.state, 'Low', T0 + HOUR + DEFAULTS.clearDwellMs);
    assert.equal(cleared.decision.kind, 'all_clear');
    const d = step(cleared.state, 'High', T0 + 24 * HOUR);
    assert.equal(d.decision.kind, 'first');
    assert.equal(d.state.episodeId, T0 + 24 * HOUR);
    assert.notEqual(d.state.episodeId, a.state.episodeId);
  });
});

describe('state shape', () => {
  test('delivery fields stay null in this phase — nothing has been sent', () => {
    const { state } = step(null, 'Severe', T0);
    assert.equal(state.lastNotifiedLevel, null);
    assert.equal(state.lastNotifiedAt, null);
    assert.equal(state.notifyCount, 0);
  });

  test('missing or malformed prior state is treated as normal', () => {
    for (const bad of [null, undefined, {}, { band: 'nonsense' }, 'x', 7]) {
      const { state, decision } = step(bad, 'High', T0);
      assert.equal(decision.kind, 'first', `bad state ${JSON.stringify(bad)}`);
      assert.equal(state.band, 'high');
    }
  });

  test('repeated normal runs produce stable state (no spurious writes)', () => {
    const a = step(null, 'Minimal', T0);
    const b = step(a.state, 'Minimal', T0 + HOUR);
    assert.deepEqual(a.state, b.state);
  });
});
