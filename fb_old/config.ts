// Import the functions you need from the SDKs you need
import { initializeApp, getApps, getApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyDamiCHolJ7VYX2mAYVINENEiOACBa-qT0",
  authDomain: "storkhub-9f719.firebaseapp.com",
  projectId: "storkhub-9f719",
  storageBucket: "storkhub-9f719.firebasestorage.app",
  messagingSenderId: "1092479828671",
  appId: "1:1092479828671:web:0d3cb4f653716a30ddfc0a",
  measurementId: "G-62YJLMLPSM"
};

// Initialize Firebase
export const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
export const db = getFirestore(app);