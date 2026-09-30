// Firebase SDK loaded as ES modules straight from Firebase's own gstatic CDN —
// no bundler, consistent with how the rest of this app pulls in Leaflet etc.
// via CDN. NOTE: this must be gstatic, not jsDelivr's generic "+esm" resolver —
// jsDelivr bundles each subpath (app/auth/firestore) as an independent module
// graph with its own copy of @firebase/app, so getAuth(app) fails with
// "Component auth has not been registered yet". gstatic's firebasejs build is
// Google's own CDN artifact, compiled specifically to share one app registry
// across multiple <script type="module"> imports.
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-app.js";
import {
  initializeAuth, indexedDBLocalPersistence, browserLocalPersistence, inMemoryPersistence,
  browserPopupRedirectResolver, GoogleAuthProvider
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyB2pvdwiBIL74D6hikbRCy6YHujB6Tyhjk",
  authDomain: "theeram-18e35.firebaseapp.com",
  projectId: "theeram-18e35",
  storageBucket: "theeram-18e35.firebasestorage.app",
  messagingSenderId: "636532341453",
  appId: "1:636532341453:web:dd6d1a85668abf5ad6c784"
};

export const app = initializeApp(firebaseConfig);
// getAuth(app) lets the SDK auto-detect a persistence strategy, and inside
// the Capacitor Android WebView that auto-detection was picking something
// that doesn't survive the app actually closing — every cold start looked
// like a fresh signed-out session, forcing a re-login every single time.
// initializeAuth() with an explicit persistence chain (try IndexedDB, then
// localStorage, then finally in-memory only as a last resort) is the
// documented fix for hybrid/WebView environments.
//
// popupRedirectResolver must be passed EXPLICITLY here. getAuth() supplies
// browserPopupRedirectResolver for you; initializeAuth() does not, and leaves
// auth._popupRedirectResolver null. signInWithPopup/reauthenticateWithPopup
// then fail with auth/argument-error before any network call — on every
// platform, browser included. Android does not use the popup flow at all
// (see google-auth.js), but the browser and PWA builds do.
export const auth = initializeAuth(app, {
  persistence: [indexedDBLocalPersistence, browserLocalPersistence, inMemoryPersistence],
  popupRedirectResolver: browserPopupRedirectResolver
});
export const db = getFirestore(app);
export const googleProvider = new GoogleAuthProvider();

// The OAuth *web* client (client_type 3 in android/app/google-services.json).
// Credential Manager uses it as the ID token's audience on Android; the app is
// matched separately by package name + signing SHA-1 against the Android
// client (client_type 1). Public by design — it identifies the project, it
// does not authorise anything on its own.
export const GOOGLE_WEB_CLIENT_ID =
  '636532341453-dgt0k3g7tg9ce6pujcsojlfjvhgoslet.apps.googleusercontent.com';
