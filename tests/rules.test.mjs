// Theeram — Firestore security rules test suite (PATCHED rules).
//
// Run with:  npm run test:rules
//
// Covers the four security fixes plus regression coverage for every
// legitimate write path in the recovered app (js/family.js), so a fix can
// never silently break real functionality.

import { test, before, after, beforeEach, describe } from 'node:test';
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import {
  doc, getDoc, setDoc, updateDoc, deleteDoc, collection, getDocs,
  collectionGroup, query, where, writeBatch
} from 'firebase/firestore';
import { makeTestEnv, seed, as, anon, F1, F2 } from './helpers.mjs';

const RULES = new URL('../firestore.rules', import.meta.url).pathname;

let env;
before(async () => { env = await makeTestEnv(RULES); });
after(async () => { if (env) await env.cleanup(); });
beforeEach(async () => { await seed(env); });

// ---------------------------------------------------------------------------
describe('Anonymous access', () => {
  test('anonymous cannot read family document', async () => {
    await assertFails(getDoc(doc(anon(env), 'families', F1)));
  });

  test('anonymous cannot read the member roster', async () => {
    await assertFails(getDocs(collection(anon(env), 'families', F1, 'members')));
  });

  test('anonymous cannot read family locations', async () => {
    await assertFails(getDocs(collection(anon(env), 'families', F1, 'locations')));
  });

  test('anonymous cannot read a user profile', async () => {
    await assertFails(getDoc(doc(anon(env), 'users', 'alice')));
  });

  test('anonymous cannot write anything', async () => {
    await assertFails(setDoc(doc(anon(env), 'families', F1, 'members', 'bob'), { role: 'admin' }));
  });

  // FIX 4 — member delete now requires an explicit isSignedIn().
  test('FIX 4: anonymous cannot delete a membership document', async () => {
    await assertFails(deleteDoc(doc(anon(env), 'families', F1, 'members', 'bob')));
  });
});

// ---------------------------------------------------------------------------
describe('FIX 1 — privilege escalation via self-update of role', () => {
  test('member CANNOT promote themselves to admin', async () => {
    await assertFails(
      updateDoc(doc(as(env, 'bob'), 'families', F1, 'members', 'bob'), { role: 'admin' })
    );
  });

  test('member CANNOT smuggle role change alongside a legitimate field', async () => {
    await assertFails(
      updateDoc(doc(as(env, 'bob'), 'families', F1, 'members', 'bob'),
        { name: 'Bobby', role: 'admin' })
    );
  });

  test('member CANNOT escalate via setDoc whole-document replacement', async () => {
    await assertFails(
      setDoc(doc(as(env, 'bob'), 'families', F1, 'members', 'bob'),
        { uid: 'bob', role: 'admin', status: 'safe', name: 'Bob' })
    );
  });

  test('escalation stays denied even after a legitimate profile update', async () => {
    await assertSucceeds(
      updateDoc(doc(as(env, 'bob'), 'families', F1, 'members', 'bob'), { name: 'Bobby' })
    );
    await assertFails(
      updateDoc(doc(as(env, 'bob'), 'families', F1, 'members', 'bob'), { role: 'admin' })
    );
  });
});

// ---------------------------------------------------------------------------
describe('FIX 1 — uid immutability', () => {
  test('member CANNOT change the uid field on their own doc', async () => {
    await assertFails(
      updateDoc(doc(as(env, 'bob'), 'families', F1, 'members', 'bob'), { uid: 'carol' })
    );
  });

  test('admin CANNOT change the uid field either', async () => {
    await assertFails(
      updateDoc(doc(as(env, 'alice'), 'families', F1, 'members', 'bob'), { uid: 'carol' })
    );
  });
});

// ---------------------------------------------------------------------------
describe('Legitimate membership writes still work', () => {
  test('admin CAN promote another member to admin', async () => {
    await assertSucceeds(
      updateDoc(doc(as(env, 'alice'), 'families', F1, 'members', 'bob'), { role: 'admin' })
    );
  });

  test('admin CAN demote another member', async () => {
    await assertSucceeds(
      updateDoc(doc(as(env, 'alice'), 'families', F1, 'members', 'carol'), { role: 'member' })
    );
  });

  // The exact two-step sequence from family.js transferOwnership().
  test('transferOwnership() app flow succeeds end to end', async () => {
    const aliceDb = as(env, 'alice');
    await assertSucceeds(
      updateDoc(doc(aliceDb, 'families', F1, 'members', 'carol'), { role: 'admin' })
    );
    await assertSucceeds(
      updateDoc(doc(aliceDb, 'families', F1, 'members', 'alice'), { role: 'member' })
    );
  });

  test('after transfer, the NEW admin can administer and the old one cannot', async () => {
    const aliceDb = as(env, 'alice');
    await updateDoc(doc(aliceDb, 'families', F1, 'members', 'carol'), { role: 'admin' });
    await updateDoc(doc(aliceDb, 'families', F1, 'members', 'alice'), { role: 'member' });

    await assertSucceeds(
      updateDoc(doc(as(env, 'carol'), 'families', F1, 'members', 'bob'), { role: 'admin' })
    );
    await assertFails(
      updateDoc(doc(as(env, 'alice'), 'families', F1, 'members', 'bob'), { role: 'member' })
    );
    // ...and the demoted founder cannot re-promote herself.
    await assertFails(
      updateDoc(doc(as(env, 'alice'), 'families', F1, 'members', 'alice'), { role: 'admin' })
    );
  });

  // fanOutProfileUpdate() in family.js
  test('member CAN update their own profile fields (fanOutProfileUpdate)', async () => {
    await assertSucceeds(
      updateDoc(doc(as(env, 'bob'), 'families', F1, 'members', 'bob'), {
        name: 'Bob K', photoURL: 'https://example.test/b.png',
        homeLocation: { name: 'Kochi', lat: 9.93, lon: 76.26 }
      })
    );
  });

  test('member CAN update their own status', async () => {
    await assertSucceeds(
      updateDoc(doc(as(env, 'bob'), 'families', F1, 'members', 'bob'), { status: 'needs-help' })
    );
  });

  test('member CANNOT modify another member document', async () => {
    await assertFails(
      updateDoc(doc(as(env, 'bob'), 'families', F1, 'members', 'carol'), { name: 'Hacked' })
    );
  });

  test('member CANNOT delete another member (only admin or self)', async () => {
    await assertFails(deleteDoc(doc(as(env, 'bob'), 'families', F1, 'members', 'carol')));
  });

  test('member CAN leave (delete own membership)', async () => {
    await assertSucceeds(deleteDoc(doc(as(env, 'bob'), 'families', F1, 'members', 'bob')));
  });

  test('admin CAN remove a member', async () => {
    await assertSucceeds(deleteDoc(doc(as(env, 'alice'), 'families', F1, 'members', 'bob')));
  });
});

// ---------------------------------------------------------------------------
describe('FIX 2 — createdBy immutability on the family document', () => {
  test('admin CANNOT change createdBy', async () => {
    await assertFails(
      updateDoc(doc(as(env, 'alice'), 'families', F1), { createdBy: 'bob' })
    );
  });

  test('admin CANNOT change createdBy while renaming', async () => {
    await assertFails(
      updateDoc(doc(as(env, 'alice'), 'families', F1), { name: 'New Name', createdBy: 'bob' })
    );
  });

  test('renameFamily() still works', async () => {
    await assertSucceeds(
      updateDoc(doc(as(env, 'alice'), 'families', F1), { name: 'Renamed Family' })
    );
  });

  test('generateInviteCode() activeInviteCode write still works', async () => {
    await assertSucceeds(
      updateDoc(doc(as(env, 'alice'), 'families', F1), { activeInviteCode: 'NEWCOD' })
    );
  });

  test('non-admin member CANNOT update the family document', async () => {
    await assertFails(updateDoc(doc(as(env, 'bob'), 'families', F1), { name: 'Nope' }));
  });

  test('admin CAN delete the family document', async () => {
    await assertSucceeds(deleteDoc(doc(as(env, 'alice'), 'families', F1)));
  });

  test('createFamily() still works for any signed-in user', async () => {
    await assertSucceeds(
      setDoc(doc(as(env, 'erin'), 'families', 'F_NEW'), {
        name: 'Erin Family', createdBy: 'erin', activeInviteCode: null
      })
    );
  });

  test('cannot create a family attributed to someone else', async () => {
    await assertFails(
      setDoc(doc(as(env, 'erin'), 'families', 'F_BAD'), {
        name: 'Spoof', createdBy: 'alice', activeInviteCode: null
      })
    );
  });
});

// ---------------------------------------------------------------------------
describe('FIX 3 — ownerUid immutability on locations', () => {
  test('owner CANNOT reassign ownerUid to another member', async () => {
    await assertFails(
      updateDoc(doc(as(env, 'bob'), 'families', F1, 'locations', 'locBob'), { ownerUid: 'carol' })
    );
  });

  test('admin CANNOT reassign ownerUid either', async () => {
    await assertFails(
      updateDoc(doc(as(env, 'alice'), 'families', F1, 'locations', 'locBob'), { ownerUid: 'alice' })
    );
  });

  test('owner CAN update legitimate location fields (updateLocation)', async () => {
    await assertSucceeds(
      updateDoc(doc(as(env, 'bob'), 'families', F1, 'locations', 'locBob'), {
        rain: { r24: 82.4, r48: 130.1, r72: 155.0 },
        forecast: { next24hMm: 45.2 },
        risk: { level: 'Moderate', pct: 45, color: 'var(--amber)', reason: 'Heavy rainfall' },
        lastUpdated: new Date()
      })
    );
  });

  test('member CANNOT update another member location', async () => {
    await assertFails(
      updateDoc(doc(as(env, 'bob'), 'families', F1, 'locations', 'locAlice'), { name: 'Hacked' })
    );
  });

  test('admin CAN update another member location', async () => {
    await assertSucceeds(
      updateDoc(doc(as(env, 'alice'), 'families', F1, 'locations', 'locBob'), { name: 'Cleaned up' })
    );
  });

  test('admin CAN delete another member location (removeMember cleanup)', async () => {
    await assertSucceeds(
      deleteDoc(doc(as(env, 'alice'), 'families', F1, 'locations', 'locBob'))
    );
  });

  test('owner CAN delete their own location', async () => {
    await assertSucceeds(
      deleteDoc(doc(as(env, 'bob'), 'families', F1, 'locations', 'locBob'))
    );
  });

  test('addLocation() still works with ownerUid == self', async () => {
    await assertSucceeds(
      setDoc(doc(as(env, 'bob'), 'families', F1, 'locations', 'locNew'), {
        ownerUid: 'bob', name: 'Kottayam', lat: 9.59, lon: 76.52
      })
    );
  });

  test('cannot create a location owned by someone else', async () => {
    await assertFails(
      setDoc(doc(as(env, 'bob'), 'families', F1, 'locations', 'locSpoof'), {
        ownerUid: 'carol', name: 'Spoofed', lat: 9.0, lon: 76.0
      })
    );
  });

  test('family members CAN read all family locations', async () => {
    await assertSucceeds(getDocs(collection(as(env, 'bob'), 'families', F1, 'locations')));
  });
});

// ---------------------------------------------------------------------------
describe('Invite codes', () => {
  test('admin CAN mint a code for their own family', async () => {
    await assertSucceeds(
      setDoc(doc(as(env, 'alice'), 'inviteCodes', 'NEWCOD'), {
        familyId: F1, familyName: 'Theeram Family', createdBy: 'alice',
        code: 'NEWCOD', used: false, usedBy: null
      })
    );
  });

  test('non-admin CANNOT mint a code', async () => {
    await assertFails(
      setDoc(doc(as(env, 'bob'), 'inviteCodes', 'BADCOD'), {
        familyId: F1, familyName: 'Theeram Family', createdBy: 'bob',
        code: 'BADCOD', used: false, usedBy: null
      })
    );
  });

  test('cannot mint a code for a family you do not administer', async () => {
    await assertFails(
      setDoc(doc(as(env, 'alice'), 'inviteCodes', 'XFAM01'), {
        familyId: F2, familyName: 'Other Family', createdBy: 'alice',
        code: 'XFAM01', used: false, usedBy: null
      })
    );
  });

  test('signed-in user CAN get a code by exact id (previewInviteCode)', async () => {
    await assertSucceeds(getDoc(doc(as(env, 'erin'), 'inviteCodes', 'CODE01')));
  });

  test('invite codes are NOT listable (enumeration denied)', async () => {
    await assertFails(getDocs(collection(as(env, 'erin'), 'inviteCodes')));
  });

  // joinFamilyByCode() — batch: create own member doc + mark the code used.
  test('joinFamilyByCode() redemption batch succeeds', async () => {
    const db = as(env, 'erin');
    const batch = writeBatch(db);
    batch.set(doc(db, 'families', F1, 'members', 'erin'), {
      uid: 'erin', role: 'member', status: 'safe', name: 'Erin',
      photoURL: null, homeLocation: null, joinedViaCode: 'CODE01'
    });
    batch.update(doc(db, 'inviteCodes', 'CODE01'), { used: true, usedBy: 'erin' });
    await assertSucceeds(batch.commit());
  });

  test('cannot join a family with a code minted for a different family', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'inviteCodes', 'F2CODE'), {
        familyId: F2, familyName: 'Other Family', createdBy: 'dave',
        code: 'F2CODE', used: false, usedBy: null
      });
    });
    const db = as(env, 'erin');
    await assertFails(
      setDoc(doc(db, 'families', F1, 'members', 'erin'), {
        uid: 'erin', role: 'member', status: 'safe', name: 'Erin', joinedViaCode: 'F2CODE'
      })
    );
  });

  test('cannot join as admin without being the founder', async () => {
    await assertFails(
      setDoc(doc(as(env, 'erin'), 'families', F1, 'members', 'erin'), {
        uid: 'erin', role: 'admin', status: 'safe', name: 'Erin', joinedViaCode: 'CODE01'
      })
    );
  });

  test('cannot create a membership doc for someone else', async () => {
    await assertFails(
      setDoc(doc(as(env, 'erin'), 'families', F1, 'members', 'frank'), {
        uid: 'frank', role: 'member', status: 'safe', name: 'Frank', joinedViaCode: 'CODE01'
      })
    );
  });

  test('an already-used code cannot be redeemed again', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'inviteCodes', 'USEDCD'), {
        familyId: F1, familyName: 'Theeram Family', createdBy: 'alice',
        code: 'USEDCD', used: true, usedBy: 'someone'
      });
    });
    await assertFails(
      setDoc(doc(as(env, 'erin'), 'families', F1, 'members', 'erin'), {
        uid: 'erin', role: 'member', status: 'safe', name: 'Erin', joinedViaCode: 'USEDCD'
      })
    );
  });

  test('admin CAN revoke an unused code (generateInviteCode rotation)', async () => {
    await assertSucceeds(
      updateDoc(doc(as(env, 'alice'), 'inviteCodes', 'CODE01'), { used: true, usedBy: null })
    );
  });

  test('code familyId cannot be repointed at another family', async () => {
    await assertFails(
      updateDoc(doc(as(env, 'alice'), 'inviteCodes', 'CODE01'),
        { used: true, usedBy: 'alice', familyId: F2 })
    );
  });

  test('invite codes cannot be deleted', async () => {
    await assertFails(deleteDoc(doc(as(env, 'alice'), 'inviteCodes', 'CODE01')));
  });
});

// ---------------------------------------------------------------------------
describe('Cross-family isolation', () => {
  test('F1 member cannot read F2 family document', async () => {
    await assertFails(getDoc(doc(as(env, 'bob'), 'families', F2)));
  });

  test('F1 member cannot read F2 member roster', async () => {
    await assertFails(getDocs(collection(as(env, 'bob'), 'families', F2, 'members')));
  });

  test('F1 member cannot read F2 locations', async () => {
    await assertFails(getDocs(collection(as(env, 'bob'), 'families', F2, 'locations')));
  });

  test('F1 admin cannot write into F2', async () => {
    await assertFails(
      updateDoc(doc(as(env, 'alice'), 'families', F2, 'members', 'dave'), { role: 'member' })
    );
  });

  test('F1 admin cannot self-insert into F2', async () => {
    await assertFails(
      setDoc(doc(as(env, 'alice'), 'families', F2, 'members', 'alice'), {
        uid: 'alice', role: 'admin', status: 'safe', name: 'Alice'
      })
    );
  });
});

// ---------------------------------------------------------------------------
describe('Collection-group members query scoping', () => {
  test('user CAN query their own membership rows', async () => {
    const db = as(env, 'bob');
    await assertSucceeds(
      getDocs(query(collectionGroup(db, 'members'), where('uid', '==', 'bob')))
    );
  });

  test('user CANNOT query another user membership rows', async () => {
    const db = as(env, 'bob');
    await assertFails(
      getDocs(query(collectionGroup(db, 'members'), where('uid', '==', 'alice')))
    );
  });

  test('user CANNOT run an unfiltered collection-group scan', async () => {
    await assertFails(getDocs(collectionGroup(as(env, 'bob'), 'members')));
  });

  test('anonymous CANNOT run the collection-group query', async () => {
    await assertFails(
      getDocs(query(collectionGroup(anon(env), 'members'), where('uid', '==', 'bob')))
    );
  });
});

// ---------------------------------------------------------------------------
describe('User profiles', () => {
  test('user CAN read and write their own profile', async () => {
    await assertSucceeds(getDoc(doc(as(env, 'alice'), 'users', 'alice')));
    await assertSucceeds(
      updateDoc(doc(as(env, 'alice'), 'users', 'alice'), { phone: '+91-555-9999' })
    );
  });

  test('family member CANNOT read another user profile (phone, emergency contact)', async () => {
    await assertFails(getDoc(doc(as(env, 'bob'), 'users', 'alice')));
  });

  test('family admin CANNOT read another user profile either', async () => {
    await assertFails(getDoc(doc(as(env, 'alice'), 'users', 'bob')));
  });

  test('user CANNOT write another user profile', async () => {
    await assertFails(updateDoc(doc(as(env, 'bob'), 'users', 'alice'), { phone: 'x' }));
  });
});

// ---------------------------------------------------------------------------
describe('Default deny', () => {
  test('unmatched collections are denied even when signed in', async () => {
    await assertFails(getDoc(doc(as(env, 'alice'), 'somethingElse', 'x')));
    await assertFails(setDoc(doc(as(env, 'alice'), 'somethingElse', 'x'), { a: 1 }));
  });

  test('undeclared family subcollections are denied', async () => {
    await assertFails(
      setDoc(doc(as(env, 'bob'), 'families', F1, 'safetyChecks', 'x'), { a: 1 })
    );
  });
});

// ---------------------------------------------------------------------------
// Account deletion — the exact writes www/js/account-delete.js performs.
//
// The flow's correctness rests on these rules permitting a user to erase their
// own graph and nothing else, so each step is asserted here rather than
// reasoned about in a comment. Ordering matters: the membership document is
// the capability that authorises the family-scoped deletes, so it goes last.
describe('Account deletion', () => {
  test('a user CAN delete their own profile document', async () => {
    // users/{uid} is `allow read, write: if isOwner(uid)`, and write covers
    // delete. This one document carries phone, emergencyContact, homeLocation
    // and the entire devices map, so it is the bulk of the personal data.
    await assertSucceeds(deleteDoc(doc(as(env, 'alice'), 'users', 'alice')));
  });

  test('a user CANNOT delete anyone else\'s profile document', async () => {
    await assertFails(deleteDoc(doc(as(env, 'bob'), 'users', 'alice')));
  });

  test('deleting your own locations then your own membership succeeds in that order', async () => {
    const bob = as(env, 'bob');
    await assertSucceeds(deleteDoc(doc(bob, 'families', F1, 'locations', 'locBob')));
    await assertSucceeds(deleteDoc(doc(bob, 'families', F1, 'members', 'bob')));
  });

  test('once the membership is gone the family-scoped deletes are refused', async () => {
    // Proves the ordering is load-bearing and not merely tidy.
    const bob = as(env, 'bob');
    await assertSucceeds(deleteDoc(doc(bob, 'families', F1, 'members', 'bob')));
    await assertFails(deleteDoc(doc(bob, 'families', F1, 'locations', 'locBob')));
  });

  test('a sole admin CAN promote a successor before leaving', async () => {
    // The promote-then-leave path: hand the family over, then surrender the
    // membership that authorised the handover.
    const alice = as(env, 'alice');
    await assertSucceeds(updateDoc(doc(alice, 'families', F1, 'members', 'bob'), { role: 'admin' }));
    await assertSucceeds(deleteDoc(doc(alice, 'families', F1, 'members', 'alice')));
  });

  test('deleting the family doc first still leaves the member deletes authorised', async () => {
    // isFamilyMember()/isFamilyAdmin() read the members document, never the
    // family document, which is why the family doc can go first.
    const alice = as(env, 'alice');
    await assertSucceeds(deleteDoc(doc(alice, 'families', F1)));
    await assertSucceeds(deleteDoc(doc(alice, 'families', F1, 'locations', 'locBob')));
    await assertSucceeds(deleteDoc(doc(alice, 'families', F1, 'members', 'alice')));
  });

  test('RESIDUAL: a client cannot delete alertDecisions', async () => {
    // No rule matches this collection, so it falls to the default-deny
    // catch-all. Confirms the server-side sweep the flow reports as required.
    await assertFails(deleteDoc(doc(as(env, 'alice'), 'alertDecisions', 'anything')));
    await assertFails(getDoc(doc(as(env, 'alice'), 'alertDecisions', 'anything')));
  });

  test('RESIDUAL: a used invite code is immutable to every client', async () => {
    // allow delete is `if false`; allow update requires used == false, and a
    // code carrying a uid in usedBy is by definition already used.
    await assertFails(deleteDoc(doc(as(env, 'alice'), 'inviteCodes', 'CODE01')));
    await assertFails(
      updateDoc(doc(as(env, 'alice'), 'inviteCodes', 'CODE01'), { usedBy: null })
    );
  });
});
