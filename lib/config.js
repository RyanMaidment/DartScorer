/* ==========================================================================
   SETUP — the only file you need to edit to connect the app to Firebase.
   See README.md, step 3. Until you paste real values below, every page runs
   in DEMO MODE (data is stored only in that browser, nothing is shared).
   ========================================================================== */
 
// Firebase console -> Project settings -> Your apps -> Web app -> "firebaseConfig"
export const FIREBASE_CONFIG = {
  apiKey: "AIzaSyCKSdnQJIADybKZkvo4iGQqG0_zh3p78aA",
  authDomain: "darts-scorer-6b320.firebaseapp.com",
  projectId: "darts-scorer-6b320",
  storageBucket: "darts-scorer-6b320.firebasestorage.app",
  messagingSenderId: "265935613884",
  appId: "1:265935613884:web:afa778c713e11c7287c5b9"
};
 
// Firebase JS SDK version loaded from Google's CDN. Bump if you ever want to update.
export const FIREBASE_SDK_VERSION = '10.12.2';
 
// The Admin page's password (see lib/auth-gate.js). Change this to whatever
// you want — just a plain string. Remember this is a public repo, so treat
// it as a deterrent against casual visitors, not a real secret.
export const ADMIN_PASSWORD = 'Puffin';
 
export function isFirebaseConfigured() {
  const k = FIREBASE_CONFIG.apiKey || '';
  return k.length > 0 && !/^PASTE/i.test(k);
}
 
