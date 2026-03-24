export type ThemePref = 'system' | 'light' | 'dark'

export interface BankAccount {
  bank: string
  number: string
  holder: string
  currency: string // 'NIO' | 'USD'
}

export interface CompanyProfile {
  name?: string
  phone?: string
  address?: string
  accounts: BankAccount[]
}

export interface UserProfile {
  name?: string
  email?: string
  avatarUrl?: string
  theme?: ThemePref
  company?: CompanyProfile
}

const LS_KEY = 'storkhub:user'

export function loadUser(): UserProfile | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return null
    const u = JSON.parse(raw) as UserProfile
    if (u.company?.accounts) {
      u.company.accounts = u.company.accounts.map((a: any) => ({
        ...a,
        currency: a?.currency ?? 'NIO',
      }))
    }
    return u
  } catch {
    return null
  }
}

export function saveUser(user: UserProfile) {
  if (typeof window === 'undefined') return
  localStorage.setItem(LS_KEY, JSON.stringify(user))
}

export function clearUser() {
  if (typeof window === 'undefined') return
  localStorage.removeItem(LS_KEY)
}

export function applyTheme(pref: ThemePref | undefined) {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  const mode =
    pref === 'system'
      ? (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : pref || 'light'

  if (mode === 'dark') root.classList.add('dark')
  else root.classList.remove('dark')
  root.style.colorScheme = mode
}
