import { auth, db } from './firebase-init.js';
import {
  doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, collection, collectionGroup,
  query, where, onSnapshot, writeBatch, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-firestore.js";

const ACTIVE_FAMILY_KEY = 'theeram_active_family_v1';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I — easy to read aloud/type

let currentUser = null;
let currentProfile = null;
let myFamilies = [];        // [{id, name, role}]
let activeFamilyId = localStorage.getItem(ACTIVE_FAMILY_KEY) || null;
let activeFamily = null;    // { id, name, createdBy, activeInviteCode }
let members = [];           // live roster of the active family
let locations = [];         // live locations of the active family (all members)
let unsubFamilyDoc = null, unsubMembers = null, unsubLocations = null, unsubMyFamiliesPoll = null;

function generateCode(len = 6) {
  let s = '';
  for (let i = 0; i < len; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}

function familyRef(familyId) { return doc(db, 'families', familyId); }
function memberRef(familyId, uid) { return doc(db, 'families', familyId, 'members', uid); }
function membersCol(familyId) { return collection(db, 'families', familyId, 'members'); }
function locationsCol(familyId) { return collection(db, 'families', familyId, 'locations'); }
function inviteRef(code) { return doc(db, 'inviteCodes', code); }

// ---------------------------------------------------------------------
// "Which families am I in" — a collection-group query filtered to my own
// uid (see firestore.rules), not a duplicated list on the user profile.
// ---------------------------------------------------------------------
async function refreshMyFamilies() {
  const snap = await getDocs(query(collectionGroup(db, 'members'), where('uid', '==', currentUser.uid)));
  const entries = [];
  for (const d of snap.docs) {
    const familyId = d.ref.parent.parent.id;
    entries.push({ id: familyId, role: d.data().role });
  }
  // Fetch family names in parallel (each is a plain get — cheap, and only
  // runs for the families this user actually belongs to).
  const withNames = await Promise.all(entries.map(async (e) => {
    const fSnap = await getDoc(familyRef(e.id));
    return { id: e.id, role: e.role, name: fSnap.exists() ? fSnap.data().name : '(deleted family)' };
  }));
  myFamilies = withNames;
  if (!activeFamilyId || !myFamilies.find(f => f.id === activeFamilyId)) {
    activeFamilyId = myFamilies.length ? myFamilies[0].id : null;
  }
  persistActiveFamily();
  dispatchFamiliesChanged();
  attachActiveFamilyListeners();
}

function persistActiveFamily() {
  if (activeFamilyId) localStorage.setItem(ACTIVE_FAMILY_KEY, activeFamilyId);
  else localStorage.removeItem(ACTIVE_FAMILY_KEY);
}

export function setActiveFamily(familyId) {
  if (familyId === activeFamilyId) return;
  activeFamilyId = familyId;
  persistActiveFamily();
  dispatchFamiliesChanged();
  attachActiveFamilyListeners();
}

function attachActiveFamilyListeners() {
  if (unsubFamilyDoc) { unsubFamilyDoc(); unsubFamilyDoc = null; }
  if (unsubMembers) { unsubMembers(); unsubMembers = null; }
  if (unsubLocations) { unsubLocations(); unsubLocations = null; }
  activeFamily = null; members = []; locations = [];

  if (!activeFamilyId) { dispatchDashboardChanged(); dispatchLocationsChanged(); return; }

  // If a listener errors (most commonly: permission-denied because someone
  // removed us from this family, or the admin deleted it, while we still had
  // it open) there's no point retrying that same subscription — re-run the
  // membership query instead, which will discover the loss of access and
  // fall the UI back to onboarding instead of leaving a dead, erroring
  // listener with a console error and a dashboard that silently stops
  // updating.
  const onListenerError = () => { refreshMyFamilies(); };

  unsubFamilyDoc = onSnapshot(familyRef(activeFamilyId), (snap) => {
    activeFamily = snap.exists() ? { id: snap.id, ...snap.data() } : null;
    dispatchDashboardChanged();
  }, onListenerError);
  unsubMembers = onSnapshot(membersCol(activeFamilyId), (snap) => {
    members = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    dispatchDashboardChanged();
  }, onListenerError);
  unsubLocations = onSnapshot(locationsCol(activeFamilyId), (snap) => {
    locations = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    dispatchDashboardChanged();
    dispatchLocationsChanged();
  }, onListenerError);
}

function dispatchFamiliesChanged() {
  document.dispatchEvent(new CustomEvent('theeram:familieschanged', {
    detail: { myFamilies, activeFamilyId }
  }));
}
function dispatchDashboardChanged() {
  document.dispatchEvent(new CustomEvent('theeram:dashboardchanged', {
    detail: { family: activeFamily, members, locations, myUid: currentUser ? currentUser.uid : null }
  }));
}
function dispatchLocationsChanged() {
  const mine = currentUser ? locations.filter(l => l.ownerUid === currentUser.uid) : [];
  document.dispatchEvent(new CustomEvent('theeram:locationschanged', {
    detail: { locations: mine, hasFamily: !!activeFamilyId }
  }));
}

// ---------------------------------------------------------------------
// Create / join / leave / delete / rename / transfer / remove
// ---------------------------------------------------------------------
export async function createFamily(name) {
  const ref = familyRef(cryptoRandomId());
  // Two SEQUENTIAL awaited writes, not a batch: the founder-membership create
  // rule does get(families/{id}).data.createdBy, which — inside a single
  // batch — would read the pre-batch snapshot and not see this family doc
  // yet, and the whole batch would be denied. Proven by a rules test before
  // this was written; see firebase/test-rules.js "Creating a NEW family".
  await setDoc(ref, { name, createdBy: currentUser.uid, createdAt: serverTimestamp(), activeInviteCode: null });
  await setDoc(memberRef(ref.id, currentUser.uid), {
    uid: currentUser.uid, role: 'admin', status: 'safe',
    name: currentProfile.name, photoURL: currentProfile.photoURL || null,
    homeLocation: currentProfile.homeLocation || null,
    joinedAt: serverTimestamp(), lastActiveAt: serverTimestamp()
  });
  await refreshMyFamilies();
  setActiveFamily(ref.id);
  return ref.id;
}

function cryptoRandomId() {
  return doc(collection(db, 'families')).id; // Firestore's own auto-ID generator
}

export async function joinFamilyByCode(rawCode) {
  const code = (rawCode || '').trim().toUpperCase();
  if (!code) throw new Error('Enter an invite code.');
  const codeSnap = await getDoc(inviteRef(code));
  if (!codeSnap.exists()) throw new Error('That invite code doesn\'t exist.');
  const data = codeSnap.data();
  if (data.used) throw new Error('That invite code has already been used.');
  // Can't check this via getDoc(memberRef(...)) — the read rule for a
  // members doc requires already being a member (isFamilyMember checks
  // exists() on that exact doc), so a non-member's own pre-check get() is
  // itself permission-denied. Use the already-loaded local roster instead.
  if (myFamilies.some(f => f.id === data.familyId)) {
    throw new Error('You\'re already a member of that family.');
  }

  const batch = writeBatch(db);
  batch.set(memberRef(data.familyId, currentUser.uid), {
    uid: currentUser.uid, role: 'member', status: 'safe',
    name: currentProfile.name, photoURL: currentProfile.photoURL || null,
    homeLocation: currentProfile.homeLocation || null,
    joinedAt: serverTimestamp(), lastActiveAt: serverTimestamp(),
    joinedViaCode: code
  });
  batch.update(inviteRef(code), { used: true, usedBy: currentUser.uid });
  await batch.commit();

  await refreshMyFamilies();
  setActiveFamily(data.familyId);
  return { familyId: data.familyId, familyName: data.familyName || '' };
}

export async function previewInviteCode(rawCode) {
  const code = (rawCode || '').trim().toUpperCase();
  if (!code) return null;
  const snap = await getDoc(inviteRef(code));
  if (!snap.exists() || snap.data().used) return null;
  return { code, familyName: snap.data().familyName || 'a family circle' };
}

export async function leaveFamily(familyId) {
  const myEntry = members.find(m => m.id === currentUser.uid) ||
    (await getDoc(memberRef(familyId, currentUser.uid))).data();
  const isSoleAdmin = myEntry.role === 'admin' && members.filter(m => m.role === 'admin').length <= 1;
  if (isSoleAdmin && members.length > 1) {
    throw new Error('You\'re the only admin. Transfer ownership to someone else before leaving.');
  }
  if (isSoleAdmin && members.length <= 1) {
    return deleteFamily(familyId); // sole member+admin leaving == deleting the family
  }
  const myLocs = await getDocs(query(locationsCol(familyId), where('ownerUid', '==', currentUser.uid)));
  const batch = writeBatch(db);
  myLocs.docs.forEach(d => batch.delete(d.ref));
  batch.delete(memberRef(familyId, currentUser.uid));
  await batch.commit();
  if (activeFamilyId === familyId) activeFamilyId = null;
  await refreshMyFamilies();
}

export async function deleteFamily(familyId) {
  const [membersSnap, locsSnap, famSnap] = await Promise.all([
    getDocs(membersCol(familyId)), getDocs(locationsCol(familyId)), getDoc(familyRef(familyId))
  ]);
  const activeCode = famSnap.exists() ? famSnap.data().activeInviteCode : null;

  // Ordering matters here and it's not obvious: the family-doc delete rule
  // requires isFamilyAdmin(familyId), which reads OUR OWN members/{uid} doc.
  // An earlier version deleted every members doc (including our own) first,
  // then tried to delete the family doc — by then isFamilyAdmin() could no
  // longer prove admin status (our own doc was already gone), so that final
  // delete was silently permission-denied and the family document was left
  // orphaned forever (empty subcollections, but the parent doc survives).
  // Caught by an admin-token verification against the live project, not by
  // the emulator rules tests (those never exercised this exact call order).
  // Fix: delete the family doc FIRST while our own admin doc still exists,
  // then delete every OTHER member + all locations, and delete our own
  // membership doc dead last — self-delete never depends on admin status.
  await deleteDoc(familyRef(familyId));

  const otherDeletes = [
    ...membersSnap.docs.filter(d => d.id !== currentUser.uid).map(d => d.ref),
    ...locsSnap.docs.map(d => d.ref)
  ];
  // Firestore batches cap at 500 writes; chunk defensively (a family this
  // large is never expected, but it costs nothing to be correct here).
  for (let i = 0; i < otherDeletes.length; i += 450) {
    const batch = writeBatch(db);
    otherDeletes.slice(i, i + 450).forEach(ref => batch.delete(ref));
    await batch.commit();
  }

  if (activeCode) {
    try { await updateDoc(inviteRef(activeCode), { used: true, usedBy: null }); } catch (e) { /* already gone/used */ }
  }

  const ownMemberDoc = membersSnap.docs.find(d => d.id === currentUser.uid);
  if (ownMemberDoc) await deleteDoc(ownMemberDoc.ref);

  if (activeFamilyId === familyId) activeFamilyId = null;
  await refreshMyFamilies();
}

export async function removeMember(familyId, uid) {
  const locsSnap = await getDocs(query(locationsCol(familyId), where('ownerUid', '==', uid)));
  const batch = writeBatch(db);
  locsSnap.docs.forEach(d => batch.delete(d.ref));
  batch.delete(memberRef(familyId, uid));
  await batch.commit();
}

export async function renameFamily(familyId, newName) {
  await updateDoc(familyRef(familyId), { name: newName });
}

export async function transferOwnership(familyId, newAdminUid) {
  await updateDoc(memberRef(familyId, newAdminUid), { role: 'admin' });
  await updateDoc(memberRef(familyId, currentUser.uid), { role: 'member' });
}

export async function generateInviteCode(familyId) {
  const famSnap = await getDoc(familyRef(familyId));
  const familyName = famSnap.data().name;
  const oldCode = famSnap.data().activeInviteCode;
  if (oldCode) {
    try { await updateDoc(inviteRef(oldCode), { used: true, usedBy: null }); } catch (e) { /* already used/gone */ }
  }
  let code = null;
  for (let attempt = 0; attempt < 6 && !code; attempt++) {
    const candidate = generateCode();
    const exists = await getDoc(inviteRef(candidate));
    if (!exists.exists()) code = candidate;
  }
  if (!code) throw new Error('Could not generate a unique invite code — try again.');
  await setDoc(inviteRef(code), {
    familyId, familyName, createdBy: currentUser.uid,
    code, used: false, usedBy: null, createdAt: serverTimestamp()
  });
  await updateDoc(familyRef(familyId), { activeInviteCode: code });
  return code;
}

export function buildShareLink(code) {
  const url = new URL(window.location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('join', code);
  return url.toString();
}

// ---------------------------------------------------------------------
// Saved places (locations) — used by the existing "My Places" card UI.
// ---------------------------------------------------------------------
export async function addLocation(data) {
  if (!activeFamilyId) throw new Error('Join or create a family first.');
  const ref = doc(locationsCol(activeFamilyId));
  await setDoc(ref, {
    ownerUid: currentUser.uid,
    createdAt: serverTimestamp(),
    lastUpdated: serverTimestamp(),
    ...data
  });
  return ref.id;
}
export async function updateLocation(locationId, data) {
  if (!activeFamilyId) return;
  await updateDoc(doc(locationsCol(activeFamilyId), locationId), { ...data, lastUpdated: serverTimestamp() });
}
export async function removeLocation(locationId) {
  if (!activeFamilyId) return;
  await deleteDoc(doc(locationsCol(activeFamilyId), locationId));
}

// ---------------------------------------------------------------------
// Profile edits fan out to the denormalized copy on every membership doc
// (name/photo/home location only — phone & emergency contact stay private,
// they were never copied here). See firestore.rules comment on why this is
// duplicated at all: family members need to SEE this on the dashboard, but
// the /users/{uid} doc itself stays owner-only-readable.
// ---------------------------------------------------------------------
async function fanOutProfileUpdate(profile) {
  if (!myFamilies.length) return;
  await Promise.all(myFamilies.map(f =>
    updateDoc(memberRef(f.id, currentUser.uid), {
      name: profile.name, photoURL: profile.photoURL || null, homeLocation: profile.homeLocation || null
    }).catch(() => {})
  ));
}

document.addEventListener('theeram:authready', (e) => {
  currentUser = e.detail.user;
  currentProfile = e.detail.profile;
  refreshMyFamilies();
});
document.addEventListener('theeram:profilesaved', (e) => {
  currentProfile = e.detail.profile;
  fanOutProfileUpdate(currentProfile);
});
document.addEventListener('theeram:signedout', () => {
  if (unsubFamilyDoc) { unsubFamilyDoc(); unsubFamilyDoc = null; }
  if (unsubMembers) { unsubMembers(); unsubMembers = null; }
  if (unsubLocations) { unsubLocations(); unsubLocations = null; }
  currentUser = null; currentProfile = null;
  myFamilies = []; activeFamily = null; members = []; locations = [];
  // Deliberately do NOT clear activeFamilyId / localStorage here — if the
  // same person signs back in, re-selecting their last-viewed family is the
  // better default. refreshMyFamilies() will null it out itself if the next
  // signed-in user turns out not to belong to it.
  dispatchFamiliesChanged();
  dispatchDashboardChanged();
  dispatchLocationsChanged();
});

// Exposed for the inline UI script (family-ui.js / index.html) to call.
window.theeramFamily = {
  createFamily, joinFamilyByCode, previewInviteCode, leaveFamily, deleteFamily,
  removeMember, renameFamily, transferOwnership, generateInviteCode, buildShareLink,
  addLocation, updateLocation, removeLocation, setActiveFamily,
  getState: () => ({ myFamilies, activeFamilyId, activeFamily, members, locations, currentUser })
};
