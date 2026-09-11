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

  test('high -> normal decides "all_clear" and closes the episode', () => {
    const a = step(null, 'High', T0);
    const b = step(a.state, 'Low', T0 + HOUR);
    assert.equal(b.decision.kind, 'all_clear');
    assert.equal(b.decision.episodeId, T0);
    assert.equal(b.state.band, 'normal');
    assert.equal(b.state.episodeId, null);
    assert.equal(b.state.enteredAt, null);
  });

  test('severe -> normal decides "all_clear"', () => {
    const a = step(null, 'Severe', T0);
    const b = step(a.state, 'Minimal', T0 + HOUR);
    assert.equal(b.decision.kind, 'all_clear');
    assert.equal(b.state.band, 'normal');
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

  test('a new episode after an all-clear gets a fresh episodeId', () => {
    const a = step(null, 'High', T0);
    const b = step(a.state, 'Low', T0 + HOUR);
    const c = step(b.state, 'High', T0 + 2 * HOUR);
    assert.equal(c.decision.kind, 'first');
    assert.equal(c.state.episodeId, T0 + 2 * HOUR);
    assert.notEqual(c.state.episodeId, a.state.episodeId);
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
