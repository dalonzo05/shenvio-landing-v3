// app/fb/fs.ts
// Re-exportamos todas las utilidades de Firestore
// para que en el resto de la app importes desde aquí.

export {
  getFirestore,
  collection,
  getDocs,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  serverTimestamp,
  Timestamp,
  writeBatch,
  query,
  where,
} from "firebase/firestore";
