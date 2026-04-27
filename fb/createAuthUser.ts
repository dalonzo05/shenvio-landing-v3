import { initializeApp, deleteApp } from 'firebase/app'
import { getAuth, createUserWithEmailAndPassword } from 'firebase/auth'
import { firebaseConfig } from './config'

export async function createAuthUser(email: string, password: string): Promise<string> {
  const secondaryApp = initializeApp(firebaseConfig, `secondary-${Date.now()}`)
  try {
    const secondaryAuth = getAuth(secondaryApp)
    const { user } = await createUserWithEmailAndPassword(secondaryAuth, email, password)
    return user.uid
  } finally {
    await deleteApp(secondaryApp)
  }
}
