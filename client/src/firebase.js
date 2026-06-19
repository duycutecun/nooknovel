import { initializeApp } from 'firebase/app';
import { getFirestore, enableIndexedDbPersistence } from 'firebase/firestore';
import { getAuth } from 'firebase/auth';

// Sau khi deploy, thay thông tin dưới bằng config dự án Firebase của bạn
const firebaseConfig = window.__FIREBASE_CONFIG__ || {
  apiKey: "AIzaSyCy0LAsBTvNVBDBDaZUNSnnCD4RJ-6H51w",
  authDomain: "nooknovel-7b5a1.firebaseapp.com",
  projectId: "nooknovel-7b5a1"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

// Enable offline persistence (IndexedDB). Firestore will queue writes while offline and sync when online.
enableIndexedDbPersistence(db).catch(err => {
  console.warn('IndexedDB persistence not enabled:', err && err.message ? err.message : err);
});

export { db, auth };
