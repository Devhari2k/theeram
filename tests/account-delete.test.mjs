// Theeram — account deletion planning.
// Run with: npm run test:account
//
// The decision half of deletion lives in www/js/account-delete-plan.js, which
// imports nothing, so it is imported here directly rather than transcribed.
// The I/O half (account-delete.js) pulls Firebase from a CDN and is exercised
// by the ordering assertions at the bottom, which read its source.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  joinedAtMs, pickSuccessor, planFamilyDisposition, planDeletion,
  primaryProviderId, RESIDUAL
} from '../www/js/account-delete-plan.js';

const ME = 'uid-me';
const fam = (id, members) => ({ id, members });
const m = (uid, role = 'member', joinedAt = 1000) => ({ uid, role, joinedAt });

// ---------------------------------------------------------------------------
describe('joinedAtMs — every shape Firestore and the tests produce', () => {
  test('a Firestore Timestamp', () => {
    assert.equal(joinedAtMs({ joinedAt: { toMillis: () => 1234 } }), 1234);
  });

  test('a raw {seconds} object, as a Timestamp serialises to', () => {
    assert.equal(joinedAtMs({ joinedAt: { seconds: 5 } }), 5000);
  });

  test('a Date, a number and an ISO string', () => {
    assert.equal(joinedAtMs({ joinedAt: new Date(7000) }), 7000);
    assert.equal(joinedAtMs({ joinedAt: 42 }), 42);
    assert.equal(joinedAtMs({ joinedAt: '2026-01-01T00:00:00Z' }), Date.parse('2026-01-01T00:00:00Z'));
  });

  test('anything unusable sorts LAST rather than first', () => {
    // A member mid-join has a null serverTimestamp. Treating that as 0 would
    // hand the family to whoever happened to be written most recently.
    for (const v of [null, undefined, 'not-a-date', {}, NaN]) {
      assert.equal(joinedAtMs({ joinedAt: v }), Number.POSITIVE_INFINITY, `${String(v)}`);
    }
    assert.equal(joinedAtMs(undefined), Number.POSITIVE_INFINITY);
  });
});

// ---------------------------------------------------------------------------
describe('pickSuccessor', () => {
  test('the longest-serving member inherits', () => {
    const s = pickSuccessor([m('b', 'member', 300), m('a', 'member', 100), m('c', 'member', 200)]);
    assert.equal(s.uid, 'a');
  });

  test('ties break on uid, so a retry picks the same person', () => {
    const a = pickSuccessor([m('z', 'member', 100), m('k', 'member', 100)]);
    const b = pickSuccessor([m('k', 'member', 100), m('z', 'member', 100)]);
    assert.equal(a.uid, 'k');
    assert.equal(b.uid, 'k');
  });

  test('a member with a known join date beats one without', () => {
    const s = pickSuccessor([{ uid: 'nodate', role: 'member', joinedAt: null }, m('dated', 'member', 999)]);
    assert.equal(s.uid, 'dated');
  });

  test('no candidates yields null rather than throwing', () => {
    assert.equal(pickSuccessor([]), null);
    assert.equal(pickSuccessor(undefined), null);
  });
});

// ---------------------------------------------------------------------------
describe('planFamilyDisposition', () => {
  test('sole member and admin — the family goes with the account', () => {
    const p = planFamilyDisposition(ME, fam('f1', [m(ME, 'admin')]));
    assert.equal(p.action, 'delete-family');
    assert.equal(p.familyId, 'f1');
  });

  test('ordinary member — leave, and touch nothing else', () => {
    const p = planFamilyDisposition(ME, fam('f1', [m('other', 'admin'), m(ME, 'member')]));
    assert.equal(p.action, 'leave');
  });

  test('one admin among several — leave; the family keeps an admin', () => {
    const p = planFamilyDisposition(ME, fam('f1', [m(ME, 'admin'), m('other', 'admin')]));
    assert.equal(p.action, 'leave');
  });

  test('SOLE ADMIN with other members — hand over, never destroy', () => {
    const p = planFamilyDisposition(ME, fam('f1', [
      m(ME, 'admin', 1), m('late', 'member', 300), m('early', 'member', 200)
    ]));
    assert.equal(p.action, 'promote-then-leave');
    assert.equal(p.successorUid, 'early', 'longest-serving of the REMAINING members');
  });

  test('a sole admin never results in delete-family while others remain', () => {
    // The guarantee that matters: deleting my account must not delete other
    // people's saved places.
    for (const n of [1, 2, 5, 20]) {
      const others = Array.from({ length: n }, (_, i) => m(`u${i}`, 'member', 100 + i));
      const p = planFamilyDisposition(ME, fam('f1', [m(ME, 'admin', 1), ...others]));
      assert.equal(p.action, 'promote-then-leave', `n=${n}`);
      assert.ok(p.successorUid !== ME);
    }
  });

  test('not a member — skipped, not guessed at', () => {
    const p = planFamilyDisposition(ME, fam('f1', [m('someone', 'admin')]));
    assert.equal(p.action, 'skip');
    assert.equal(p.reason, 'not-a-member');
  });

  test('an empty or malformed roster does not throw', () => {
    assert.equal(planFamilyDisposition(ME, fam('f1', [])).action, 'skip');
    assert.equal(planFamilyDisposition(ME, { id: 'f1' }).action, 'skip');
  });
});

// ---------------------------------------------------------------------------
describe('planDeletion — a user in several families at once', () => {
  const plans = planDeletion(ME, [
    fam('solo', [m(ME, 'admin')]),
    fam('coadmin', [m(ME, 'admin'), m('x', 'admin')]),
    fam('soleadmin', [m(ME, 'admin', 1), m('y', 'member', 50)]),
    fam('plain', [m('z', 'admin'), m(ME, 'member')])
  ]);

  test('each family is decided on its own roster', () => {
    assert.deepEqual(plans.map(p => p.action),
      ['delete-family', 'leave', 'promote-then-leave', 'leave']);
  });

  test('only the sole-admin family names a successor', () => {
    assert.deepEqual(plans.filter(p => p.successorUid).map(p => [p.familyId, p.successorUid]),
      [['soleadmin', 'y']]);
  });

  test('no family with other members is ever marked for deletion', () => {
    const destructive = plans.filter(p => p.action === 'delete-family');
    assert.equal(destructive.length, 1);
    assert.equal(destructive[0].familyId, 'solo');
  });

  test('an empty family list is handled', () => {
    assert.deepEqual(planDeletion(ME, []), []);
    assert.deepEqual(planDeletion(ME, undefined), []);
  });
});

// ---------------------------------------------------------------------------
describe('primaryProviderId', () => {
  test('password wins when the account has both', () => {
    assert.equal(primaryProviderId({ providerData: [{ providerId: 'google.com' }, { providerId: 'password' }] }), 'password');
  });

  test('a Google-only account reports google.com', () => {
    assert.equal(primaryProviderId({ providerData: [{ providerId: 'google.com' }] }), 'google.com');
  });

  test('missing provider data falls back to password, so a reauth is still demanded', () => {
    assert.equal(primaryProviderId({ providerData: [] }), 'password');
    assert.equal(primaryProviderId(null), 'password');
  });
});

// ---------------------------------------------------------------------------
describe('RESIDUAL — what the client cannot reach', () => {
  test('names both server-owned collections', () => {
    assert.deepEqual(RESIDUAL.map(r => r.collection).sort(), ['alertDecisions', 'inviteCodes']);
  });

  test('each entry explains why, not just that', () => {
    for (const r of RESIDUAL) {
      assert.ok(r.why && r.why.length > 40, `${r.collection} needs a real explanation`);
      assert.ok(r.field);
    }
  });
});

// ---------------------------------------------------------------------------
// Ordering is the correctness argument for the whole flow, so it is asserted
// against the source rather than left to a comment.
describe('account-delete.js — irreversible-order guarantees', () => {
  const SRC = readFileSync(new URL('../www/js/account-delete.js', import.meta.url), 'utf8');
  const at = (needle) => {
    const i = SRC.indexOf(needle);
    assert.ok(i > -1, `not found in source: ${needle}`);
    return i;
  };

  test('reauthentication happens before any Firestore purge', () => {
    const body = SRC.slice(at('export async function deleteAccount'));
    assert.ok(body.indexOf('await reauthenticate(') < body.indexOf('await purgeFirestoreData('),
      'a failed reauth after the purge would strand an account with no data');
  });

  test('the Auth account is deleted last', () => {
    const body = SRC.slice(at('export async function deleteAccount'));
    assert.ok(body.indexOf('await purgeFirestoreData(') < body.indexOf('await deleteUser('),
      'Firestore rules key off request.auth.uid, so the purge needs a live session');
  });

  test('own membership is deleted after own locations', () => {
    const body = SRC.slice(at('export async function applyDisposition'));
    const locs = body.indexOf('commitInChunks(mine.docs');
    const mem = body.indexOf('await deleteDoc(memberRef(plan.familyId, uid));   // last');
    assert.ok(locs > -1 && mem > -1 && locs < mem,
      'the membership doc is the capability that authorises the location deletes');
  });

  test('the family doc is deleted before the roster it authorises', () => {
    const body = SRC.slice(at("if (plan.action === 'delete-family')"));
    assert.ok(body.indexOf('deleteDoc(familyRef(') < body.indexOf('commitInChunks('),
      'deleting the family needs admin, which is read off the member doc');
  });

  test('the successor is promoted before the membership is surrendered', () => {
    const body = SRC.slice(at('export async function applyDisposition'));
    assert.ok(body.indexOf("role: 'admin'") < body.indexOf('await deleteDoc(memberRef'),
      'promotion requires admin rights we are about to give up');
  });

  test('deletion never calls deleteUser on anyone but the current user', () => {
    // Count call sites only — the header comment discusses deleteUser() too.
    const code = SRC.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
    const calls = code.match(/deleteUser\([^)]*\)/g) || [];
    assert.deepEqual(calls, ['deleteUser(auth.currentUser)'],
      'exactly one call site, and it targets the signed-in user');
  });

  test('the Firestore purge is not reused from family.js', () => {
    // leaveFamily() decides sole-admin status from the ACTIVE family's roster
    // only, so calling it for a different family would consult the wrong one.
    assert.ok(!SRC.includes("from './family.js'"));
  });
});
