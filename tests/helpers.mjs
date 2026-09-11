// Shared fixture + harness for the Theeram Firestore rules tests.
//
// Every test file builds the SAME world so results are comparable between the
// pre-fix rules (tests/vuln-demo.test.mjs) and the patched rules
// (tests/rules.test.mjs):
//
//   families/F1   createdBy: alice
//     members/alice   role: admin
//     members/bob     role: member
//     members/carol   role: member
//     locations/locAlice  ownerUid: alice
//     locations/locBob    ownerUid: bob
//
//   families/F2   createdBy: dave      (a family nobody in F1 belongs to)
//     members/dave    role: admin
//     locations/locDave   ownerUid: dave
//
//   inviteCodes/CODE01   familyId: F1, unused   (for redemption tests)
//   users/alice, users/bob
//
// The emulator is addressed explicitly rather than via FIRESTORE_EMULATOR_HOST
// so these files can never accidentally be pointed at a real project.

import { readFileSync } from 'node:fs';
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, setDoc } from 'firebase/firestore';

export const F1 = 'F1';
export const F2 = 'F2';

// Each suite gets its OWN demo project id so the patched rules and the frozen
// pre-fix rules can be loaded into the same emulator without overwriting one
// another (rules are per-project).
export async function makeTestEnv(rulesPath, projectId = 'demo-theeram') {
  return initializeTestEnvironment({
    projectId,
    firestore: {
      host: '127.0.0.1',
      port: 8080,
      rules: readFileSync(rulesPath, 'utf8')
    }
  });
}

export async function seed(testEnv) {
  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();

    await setDoc(doc(db, 'families', F1), {
      name: 'Theeram Family', createdBy: 'alice', activeInviteCode: 'CODE01'
    });
    await setDoc(doc(db, 'families', F1, 'members', 'alice'), {
      uid: 'alice', role: 'admin', status: 'safe', name: 'Alice', photoURL: null, homeLocation: null
    });
    await setDoc(doc(db, 'families', F1, 'members', 'bob'), {
      uid: 'bob', role: 'member', status: 'safe', name: 'Bob', photoURL: null, homeLocation: null
    });
    await setDoc(doc(db, 'families', F1, 'members', 'carol'), {
      uid: 'carol', role: 'member', status: 'safe', name: 'Carol', photoURL: null, homeLocation: null
    });

    await setDoc(doc(db, 'families', F1, 'locations', 'locAlice'), {
      ownerUid: 'alice', name: 'Kochi', lat: 9.93, lon: 76.26
    });
    await setDoc(doc(db, 'families', F1, 'locations', 'locBob'), {
      ownerUid: 'bob', name: 'Alappuzha', lat: 9.49, lon: 76.33
    });

    await setDoc(doc(db, 'families', F2), {
      name: 'Other Family', createdBy: 'dave', activeInviteCode: null
    });
    await setDoc(doc(db, 'families', F2, 'members', 'dave'), {
      uid: 'dave', role: 'admin', status: 'safe', name: 'Dave'
    });
    await setDoc(doc(db, 'families', F2, 'locations', 'locDave'), {
      ownerUid: 'dave', name: 'Kollam', lat: 8.89, lon: 76.61
    });

    await setDoc(doc(db, 'inviteCodes', 'CODE01'), {
      familyId: F1, familyName: 'Theeram Family', createdBy: 'alice',
      code: 'CODE01', used: false, usedBy: null
    });

    await setDoc(doc(db, 'users', 'alice'), {
      name: 'Alice', phone: '+91-555-0100', emergencyContact: 'Bob +91-555-0101'
    });
    await setDoc(doc(db, 'users', 'bob'), {
      name: 'Bob', phone: '+91-555-0101', emergencyContact: 'Alice +91-555-0100'
    });
  });
}

// Authenticated / unauthenticated Firestore handles for each persona.
export const as = (env, uid) => env.authenticatedContext(uid).firestore();
export const anon = (env) => env.unauthenticatedContext().firestore();
