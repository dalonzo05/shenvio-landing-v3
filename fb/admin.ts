import { cert, getApps, initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'

const adminApp =
  getApps().find((a) => a.name === 'admin') ??
  initializeApp(
    { credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON!)) },
    'admin'
  )

export const adminAuth = getAuth(adminApp)
