// Theeram — account deletion.
//
// Google Play and the App Store both require an in-app path that deletes the
// account AND the personal data attached to it. Calling Firebase's deleteUser()
// alone would satisfy neither: it removes the Auth record and orphans every
// Firestore document keyed by that uid.
//
// ORDER MATTERS, and it is the whole design:
//
//   1. Re-authenticate FIRST. Firebase refuses deleteUser() on a stale session
//      with auth/requires-recent-login. Discovering that after the Firestore
//      purge would leave a signed-in account with no data — the worst possible
//      half-state. Nothing destructive happens until reauth succeeds.
//   2. Purge Firestore while still signed in. Every rule that permits this is
//      written in terms of request.auth.uid, so the writes are only possible
//      BEFORE the Auth account goes away.
//   3. Delete the Auth account last.
//
// Within a family the order is equally load-bearing. isFamilyMember() checks
// only that families/{fid}/members/{uid} exists, and isFamilyAdmin() reads
// role off that same document — neither consults the family doc. So the own
// membership document is always deleted LAST: it is the capability that
// authorises every other delete in that family.
//
// This module deliberately does NOT reuse family.js's leaveFamily(). That
// function decides "am I the sole admin" from the module-level `members`
// array, which only ever holds the roster of the ACTIVE family; calling it for
// any other family would consult the wrong roster. Deletion fetches each
// family's own roster instead. family.js is left untouched.

import { auth, db } from './firebase-init.js';
import {
  planDeletion, primaryProviderId, RESIDUAL
} from './account-delete-plan.js';
import { reauthenticateWithGoogle, describeGoogleError } from './google-auth.js';
import {
  EmailAuthProvider, reauthenticateWithCredential, deleteUser
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-auth.js";
import {
  doc, getDocs, deleteDoc, updateDoc, collection, collectionGroup,
  query, where, writeBatch
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-firestore.js";

// Firestore caps a batch at 500 writes.
const BATCH_LIMIT = 450;

// ---------------------------------------------------------------------------
// Re-authentication
// ---------------------------------------------------------------------------

/**
 * Firebase requires a recent sign-in before deleteUser(). Rather than guess
 * whether the session is fresh enough, always reauthenticate: it is one field
 * for a password account, and it is the industry-standard confirmation for an
 * irreversible action.
 */
export async function reauthenticate({ password } = {}) {
  const user = auth.currentUser;
  if (!user) throw new Error('You are not signed in.');

  const provider = primaryProviderId(user);
  if (provider === 'password') {
    if (!password) throw new Error('Enter your password to confirm.');
    const cred = EmailAuthProvider.credential(user.email, password);
    await reauthenticateWithCredential(user, cred);
    return { provider };
  }

  // Google and friends. This used to be reauthenticateWithPopup, which cannot
  // run in the packaged WebView, so a Google user was told to go and find a
  // browser — i.e. could not delete their account in the app at all. It now
  // goes through the same native Credential Manager flow as signing in, and
  // falls back to the popup only in a real browser.
  //
  // The requirement is NOT relaxed. A Google ID token minted seconds ago is
  // handed to reauthenticateWithCredential, which verifies it server-side and
  // rejects it with auth/user-mismatch unless it belongs to this very account.
  // The account chooser always appears because the native login uses
  // style: 'standard' (see nativeIdToken in google-auth.js), so confirming is
  // a deliberate act rather than silent reuse of a cached credential.
  try {
    await reauthenticateWithGoogle(user);
    return { provider };
  } catch (err) {
    const { kind, message } = describeGoogleError(err, { context: 'reauth' });
    if (kind === 'cancelled') {
      throw new Error('Confirmation cancelled. Your account has not been deleted.');
    }
    // Firebase codes the dialog already handles (requires-recent-login,
    // too-many-requests) are passed through untouched.
    if (kind === 'unknown' && err && err.code) throw err;
    throw new Error(message);
  }
}

// ---------------------------------------------------------------------------
// Firestore purge
// ---------------------------------------------------------------------------

const familyRef = (fid) => doc(db, 'families', fid);
const memberRef = (fid, uid) => doc(db, 'families', fid, 'members', uid);
const membersCol = (fid) => collection(db, 'families', fid, 'members');
const locationsCol = (fid) => collection(db, 'families', fid, 'locations');

async function commitInChunks(refs) {
  for (let i = 0; i < refs.length; i += BATCH_LIMIT) {
    const batch = writeBatch(db);
    refs.slice(i, i + BATCH_LIMIT).forEach(r => batch.delete(r));
    await batch.commit();
  }
}

/** Every family this uid belongs to, each with its own full roster. */
export async function loadMyFamilies(uid) {
  const snap = await getDocs(query(collectionGroup(db, 'members'), where('uid', '==', uid)));
  const ids = [...new Set(snap.docs.map(d => d.ref.parent.parent.id))];
  return Promise.all(ids.map(async (id) => {
    const roster = await getDocs(membersCol(id));
    return {
      id,
      members: roster.docs.map(d => ({ uid: d.id, ...d.data() }))
    };
  }));
}

/** Carry out one planned disposition. */
export async function applyDisposition(uid, plan) {
  if (plan.action === 'skip') return { ...plan, locationsDeleted: 0 };

  if (plan.action === 'promote-then-leave') {
    // Hand the family over before giving up the membership that authorises it.
    await updateDoc(memberRef(plan.familyId, plan.successorUid), { role: 'admin' });
  }

  if (plan.action === 'delete-family') {
    // The family doc goes first, while our own admin membership still exists
    // to authorise it. isFamilyMember/isFamilyAdmin read the members doc, not
    // the family doc, so the deletes below still pass afterwards.
    await deleteDoc(familyRef(plan.familyId));
    const [roster, locs] = await Promise.all([
      getDocs(membersCol(plan.familyId)), getDocs(locationsCol(plan.familyId))
    ]);
    await commitInChunks([
      ...roster.docs.filter(d => d.id !== uid).map(d => d.ref),
      ...locs.docs.map(d => d.ref)
    ]);
    await deleteDoc(memberRef(plan.familyId, uid));
    return { ...plan, locationsDeleted: locs.docs.length };
  }

  // 'leave' and the tail of 'promote-then-leave': only ever our own rows.
  const mine = await getDocs(query(locationsCol(plan.familyId), where('ownerUid', '==', uid)));
  await commitInChunks(mine.docs.map(d => d.ref));
  await deleteDoc(memberRef(plan.familyId, uid));   // last: revokes our own access
  return { ...plan, locationsDeleted: mine.docs.length };
}

/**
 * Remove every Firestore document this client is permitted to remove.
 * Throws if anything fails — the caller must not delete the Auth account
 * while data it authorises is still reachable.
 */
export async function purgeFirestoreData(uid) {
  const families = await loadMyFamilies(uid);
  const plans = planDeletion(uid, families);

  const applied = [];
  for (const plan of plans) applied.push(await applyDisposition(uid, plan));

  // The profile document carries name, photoURL, phone, emergencyContact,
  // homeLocation and the whole devices map, so this one delete takes every
  // registered FCM token with it.
  await deleteDoc(doc(db, 'users', uid));

  return { families: applied, profileDeleted: true, residual: RESIDUAL };
}

// ---------------------------------------------------------------------------
// The whole flow
// ---------------------------------------------------------------------------

/**
 * Reauthenticate, purge, then delete the Auth account.
 * Never deletes another user's account or a family that still has members.
 */
export async function deleteAccount({ password } = {}) {
  const user = auth.currentUser;
  if (!user) throw new Error('You are not signed in.');
  const uid = user.uid;

  await reauthenticate({ password });          // 1 — nothing destructive before this
  const report = await purgeFirestoreData(uid); // 2 — while the rules still know us
  await deleteUser(auth.currentUser);           // 3 — the account itself

  return { uid, ...report };
}

export { planDeletion, primaryProviderId, RESIDUAL } from './account-delete-plan.js';

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

function wireDeleteAccountUi() {
  const openBtn = document.getElementById('deleteAccountBtn');
  const modal = document.getElementById('deleteAccountModal');
  if (!openBtn || !modal) return;

  const pwRow = document.getElementById('deleteAccountPasswordRow');
  const pwInput = document.getElementById('deleteAccountPassword');
  const googleNote = document.getElementById('deleteAccountGoogleNote');
  const ack = document.getElementById('deleteAccountAck');
  const confirmBtn = document.getElementById('deleteAccountConfirmBtn');
  const cancelBtn = document.getElementById('deleteAccountCancelBtn');
  const errorEl = document.getElementById('deleteAccountError');
  const familyNote = document.getElementById('deleteAccountFamilyNote');
  const accountMenu = document.getElementById('accountMenu');

  const showError = (msg) => {
    errorEl.textContent = msg;
    errorEl.style.display = msg ? 'block' : 'none';
  };

  // The button unlocks only once the acknowledgement is ticked. One checkbox
  // and one button — enough to be deliberate, not enough to be an obstacle.
  const refreshEnabled = () => { confirmBtn.disabled = !ack.checked; };

  function close() {
    modal.style.display = 'none';
    pwInput.value = '';
    ack.checked = false;
    showError('');
    refreshEnabled();
  }

  async function open() {
    if (accountMenu) accountMenu.classList.remove('open');
    showError('');
    ack.checked = false;
    pwInput.value = '';
    refreshEnabled();

    // Only password accounts can be re-confirmed in place. Everyone else is
    // re-confirmed through their provider, so say which it will be rather than
    // springing an account chooser on them mid-delete.
    const usesPassword = primaryProviderId(auth.currentUser) === 'password';
    pwRow.style.display = usesPassword ? 'block' : 'none';
    if (googleNote) googleNote.style.display = usesPassword ? 'none' : 'block';

    // Tell the user up front what will happen to the families they run,
    // rather than surprising them — or their family — afterwards.
    familyNote.style.display = 'none';
    try {
      const uid = auth.currentUser && auth.currentUser.uid;
      if (uid) {
        const plans = planDeletion(uid, await loadMyFamilies(uid));
        const handovers = plans.filter(p => p.action === 'promote-then-leave').length;
        const removals = plans.filter(p => p.action === 'delete-family').length;
        const notes = [];
        if (handovers) {
          notes.push(handovers === 1
            ? 'You are the only admin of one family circle — it will be handed to its longest-serving member.'
            : `You are the only admin of ${handovers} family circles — each will be handed to its longest-serving member.`);
        }
        if (removals) {
          notes.push(removals === 1
            ? 'One family circle has no other members and will be deleted with your account.'
            : `${removals} family circles have no other members and will be deleted with your account.`);
        }
        if (notes.length) {
          familyNote.textContent = notes.join(' ');
          familyNote.style.display = 'block';
        }
      }
    } catch {
      // Advisory only — never block deletion because the preview failed.
    }

    modal.style.display = 'flex';
  }

  openBtn.addEventListener('click', open);
  cancelBtn.addEventListener('click', close);
  ack.addEventListener('change', refreshEnabled);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

  confirmBtn.addEventListener('click', async () => {
    showError('');
    confirmBtn.disabled = true;
    cancelBtn.disabled = true;
    const original = confirmBtn.textContent;
    confirmBtn.textContent = 'Deleting…';
    try {
      await deleteAccount({ password: pwInput.value });
      // The Auth account is gone; onAuthStateChanged returns the app to the
      // sign-in screen on its own. Just clear the dialog.
      close();
    } catch (err) {
      const code = (err && err.code) || '';
      if (code.includes('wrong-password') || code.includes('invalid-credential')) {
        showError('That password is not correct.');
      } else if (code.includes('too-many-requests')) {
        showError('Too many attempts. Wait a few minutes and try again.');
      } else {
        showError(String((err && err.message) || 'Could not delete your account. Please try again.'));
      }
      cancelBtn.disabled = false;
      confirmBtn.textContent = original;
      refreshEnabled();
    }
  });
}

if (typeof window !== 'undefined') {
  window.theeramAccount = { deleteAccount, planDeletion, RESIDUAL };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireDeleteAccountUi);
  } else {
    wireDeleteAccountUi();
  }
}
