import { auth, db } from './firebase-init.js';
import { signInWithGoogle, describeGoogleError, signOutNativeGoogle } from './google-auth.js';
import {
  onAuthStateChanged, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, signOut, updateProfile
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-auth.js";
import {
  doc, getDoc, setDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-firestore.js";

const authGate = document.getElementById('authGate');
const profileGate = document.getElementById('profileGate');
const appShell = document.getElementById('appShell');

const tabSignIn = document.getElementById('tabSignIn');
const tabSignUp = document.getElementById('tabSignUp');
const authNameField = document.getElementById('authNameField');
const authNameInput = document.getElementById('authName');
const authEmailInput = document.getElementById('authEmail');
const authPasswordInput = document.getElementById('authPassword');
const authSubmitBtn = document.getElementById('authSubmit');
const authError = document.getElementById('authError');
const googleBtn = document.getElementById('googleSignIn');

const profileForm = document.getElementById('profileForm');
const profileNameInput = document.getElementById('profileName');
const profilePhoneInput = document.getElementById('profilePhone');
const profileHomeInput = document.getElementById('profileHome');
const profileEmergName = document.getElementById('profileEmergName');
const profileEmergPhone = document.getElementById('profileEmergPhone');
const profileError = document.getElementById('profileError');
const profileSubmitBtn = document.getElementById('profileSubmit');
const profileSkipBtn = document.getElementById('profileSkip');

const accountChip = document.getElementById('accountChip');
const accountAvatar = document.getElementById('accountAvatar');
const accountName = document.getElementById('accountName');
const accountMenu = document.getElementById('accountMenu');
const signOutBtn = document.getElementById('signOutBtn');
const editProfileBtn = document.getElementById('editProfileBtn');

let mode = 'signin'; // 'signin' | 'signup'
export let currentUser = null;
export let currentProfile = null;

function showOnly(el){
  [authGate, profileGate, appShell].forEach(node => {
    node.style.display = (node === el) ? '' : 'none';
  });
}

function setMode(next){
  mode = next;
  tabSignIn.classList.toggle('active', mode === 'signin');
  tabSignUp.classList.toggle('active', mode === 'signup');
  authNameField.style.display = mode === 'signup' ? '' : 'none';
  authSubmitBtn.textContent = mode === 'signup' ? 'Create account' : 'Sign in';
  authError.textContent = '';
}
tabSignIn.addEventListener('click', () => setMode('signin'));
tabSignUp.addEventListener('click', () => setMode('signup'));
setMode('signin');

async function handleAuthSubmit(e){
  e.preventDefault();
  authError.textContent = '';
  const email = authEmailInput.value.trim();
  const password = authPasswordInput.value;
  if(!email || !password){ authError.textContent = 'Enter an email and password.'; return; }
  authSubmitBtn.disabled = true;
  try{
    if(mode === 'signup'){
      const name = authNameInput.value.trim();
      if(!name){ authError.textContent = 'Enter your name.'; authSubmitBtn.disabled = false; return; }
      const cred = await createUserWithEmailAndPassword(auth, email, password);
      await updateProfile(cred.user, { displayName: name });
    } else {
      await signInWithEmailAndPassword(auth, email, password);
    }
  }catch(err){
    authError.textContent = friendlyAuthError(err);
  }finally{
    authSubmitBtn.disabled = false;
  }
}
document.getElementById('authForm').addEventListener('submit', handleAuthSubmit);

googleBtn.addEventListener('click', async () => {
  authError.textContent = '';
  googleBtn.disabled = true;
  try{
    // Native Credential Manager on Android, popup in a browser — chosen inside
    // google-auth.js. Either way this ends in a normal Firebase session, so
    // onAuthStateChanged below handles the profile exactly as it does for an
    // email sign-in.
    await signInWithGoogle();
  }catch(err){
    // A dismissed account sheet is not a failure: describeGoogleError returns
    // '' for it, which clears the row rather than accusing the user.
    authError.textContent = describeGoogleError(err, { context: 'signin' }).message;
  }finally{
    googleBtn.disabled = false;
  }
});

function friendlyAuthError(err){
  const code = err && err.code || '';
  if(code.includes('auth/invalid-credential') || code.includes('auth/wrong-password')) return 'Incorrect email or password.';
  if(code.includes('auth/user-not-found')) return 'No account with that email — try Create account.';
  if(code.includes('auth/email-already-in-use')) return 'An account already exists with that email — try Sign in.';
  if(code.includes('auth/weak-password')) return 'Password should be at least 6 characters.';
  if(code.includes('auth/unauthorized-domain')) return 'This domain isn’t authorized for sign-in yet in the Firebase console.';
  // Google failures no longer arrive here — the button routes them through
  // describeGoogleError, which knows about Credential Manager as well as the
  // popup flow. This function is the email/password path only.
  return 'Something went wrong. Please try again.';
}

// ---- Profile setup (first login) ----
profileForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  profileError.textContent = '';
  const name = profileNameInput.value.trim();
  if(!name){ profileError.textContent = 'Enter your name.'; return; }
  profileSubmitBtn.disabled = true;
  try{
    const profile = {
      name,
      photoURL: currentUser.photoURL || null,
      phone: profilePhoneInput.value.trim() || null,
      emergencyContact: (profileEmergName.value.trim() || profileEmergPhone.value.trim()) ? {
        name: profileEmergName.value.trim() || null,
        phone: profileEmergPhone.value.trim() || null
      } : null,
      homeLocation: null,
      createdAt: serverTimestamp()
    };
    const homeQuery = profileHomeInput.value.trim();
    if(homeQuery && window.theeramGeocode){
      try{
        const geo = await window.theeramGeocode(homeQuery);
        profile.homeLocation = { name: geo.name, lat: geo.lat, lon: geo.lon };
      }catch(geoErr){
        // Non-fatal — profile can be completed without a resolved home location.
      }
    }
    await setDoc(doc(db, 'users', currentUser.uid), profile);
    currentProfile = profile;
    document.dispatchEvent(new CustomEvent('theeram:profilesaved', { detail: { profile } }));
    enterApp();
  }catch(err){
    profileError.textContent = 'Could not save your profile. Please try again.';
  }finally{
    profileSubmitBtn.disabled = false;
  }
});
profileSkipBtn.addEventListener('click', async () => {
  const profile = { name: currentUser.displayName || currentUser.email.split('@')[0], photoURL: currentUser.photoURL || null, phone: null, emergencyContact: null, homeLocation: null, createdAt: serverTimestamp() };
  await setDoc(doc(db, 'users', currentUser.uid), profile);
  currentProfile = profile;
  document.dispatchEvent(new CustomEvent('theeram:profilesaved', { detail: { profile } }));
  enterApp();
});

function enterApp(){
  accountName.textContent = currentProfile.name;
  if(currentProfile.photoURL){
    // Built with DOM APIs rather than interpolated into innerHTML: photoURL
    // is a stored profile value, and setting .src as a property never parses
    // it as markup, so there is no attribute to break out of.
    const img = document.createElement('img');
    img.src = currentProfile.photoURL;
    img.alt = '';
    accountAvatar.replaceChildren(img);
  } else {
    accountAvatar.textContent = (currentProfile.name || '?').trim().charAt(0).toUpperCase();
  }
  showOnly(appShell);
  document.dispatchEvent(new CustomEvent('theeram:authready', { detail: { user: currentUser, profile: currentProfile } }));
}

accountChip.addEventListener('click', () => accountMenu.classList.toggle('open'));
document.addEventListener('click', (e) => {
  if(!accountChip.contains(e.target)) accountMenu.classList.remove('open');
});
signOutBtn.addEventListener('click', async () => {
  accountMenu.classList.remove('open');
  // Detach this device's push registration BEFORE the session ends: the
  // Firestore rule is isOwner(uid), so after signOut() the delete is denied
  // and the token would stay filed under the departing account. Signing out
  // must never be blocked by it, hence the catch.
  try {
    if (window.theeramPush) await window.theeramPush.unregisterDevice();
  } catch (e) { /* non-fatal — proceed with sign-out regardless */ }
  // Drop the native Google session too, so the next sign-in offers the account
  // chooser instead of silently reusing the last account. Already swallows its
  // own errors; signing out must never be blocked by it.
  await signOutNativeGoogle();
  signOut(auth);
});
editProfileBtn.addEventListener('click', () => {
  accountMenu.classList.remove('open');
  profileNameInput.value = currentProfile.name || '';
  profilePhoneInput.value = currentProfile.phone || '';
  profileEmergName.value = (currentProfile.emergencyContact && currentProfile.emergencyContact.name) || '';
  profileEmergPhone.value = (currentProfile.emergencyContact && currentProfile.emergencyContact.phone) || '';
  profileHomeInput.value = (currentProfile.homeLocation && currentProfile.homeLocation.name) || '';
  profileSkipBtn.style.display = 'none';
  showOnly(profileGate);
});

onAuthStateChanged(auth, async (user) => {
  currentUser = user;
  if(!user){
    currentProfile = null;
    showOnly(authGate);
    document.dispatchEvent(new CustomEvent('theeram:signedout'));
    return;
  }
  // updateProfile() (e.g. right after sign-up) can resolve after this listener
  // has already fired, leaving `user.displayName` stale — reload picks up
  // whatever's actually on the account before we use it to prefill anything.
  await user.reload();
  const snap = await getDoc(doc(db, 'users', user.uid));
  if(snap.exists()){
    currentProfile = snap.data();
    enterApp();
  } else {
    profileNameInput.value = user.displayName || '';
    profileSkipBtn.style.display = '';
    showOnly(profileGate);
  }
});
