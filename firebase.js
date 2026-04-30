// ══════════════════════════════════════════════════════
// firebase.js
// Initialises Firebase and exposes all Firestore helpers
// that script.js calls.
// ══════════════════════════════════════════════════════

const firebaseConfig = {
  apiKey:            "AIzaSyD8gR1uoROVjeZzvtxPn1DC9a-CVCgNZVM",
  authDomain:        "notes-e720f.firebaseapp.com",
  projectId:         "notes-e720f",
  storageBucket:     "notes-e720f.firebasestorage.app",
  messagingSenderId: "993466393868",
  appId:             "1:993466393868:web:c88061391cbde064d41529"
};

// ── Initialise ──────────────────────────────────────────
firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();

// Firestore collection name
const COLLECTION = "notes";

// Convenience reference
function notesCollection() {
  return db.collection(COLLECTION);
}

// ── Real-time listener ──────────────────────────────────
// Calls onSuccess(notesArray) on every snapshot,
// calls onError(err) on failure.
// Returns the unsubscribe function.
function subscribeToNotes(onSuccess, onError) {
  return notesCollection()
    .orderBy("updatedAt", "desc")
    .onSnapshot(
      (snapshot) => {
        const notes = snapshot.docs.map((doc) => ({
          id: doc.id,
          ...doc.data(),
        }));
        onSuccess(notes);
      },
      (err) => {
        console.error("Firestore listener error:", err);
        onError(err);
      }
    );
}

// ── Save / upsert a single note ─────────────────────────
// Accepts a note object that already has an `id` field.
async function saveNote(note) {
  const { id, ...data } = note;
  await notesCollection().doc(id).set(data);
}

// ── Delete a single note ────────────────────────────────
async function deleteNote(id) {
  await notesCollection().doc(id).delete();
}

// ── Delete ALL notes (batched) ──────────────────────────
async function deleteAllNotes() {
  const snapshot = await notesCollection().get();
  const batch = db.batch();
  snapshot.docs.forEach((doc) => batch.delete(doc.ref));
  await batch.commit();
}

// ── Timestamp helper (used when creating / updating) ────
function nowTimestamp() {
  return firebase.firestore.Timestamp.now();
}
