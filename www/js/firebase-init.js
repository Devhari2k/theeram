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
  GoogleAuthProvider
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
export const auth = initializeAuth(app, {
  persistence: [indexedDBLocalPersistence, browserLocalPersistence, inMemoryPersistence]
});
export const db = getFirestore(app);
export const googleProvider = new GoogleAuthProvider();
