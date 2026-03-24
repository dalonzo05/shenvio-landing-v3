'use client'

import React, { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useUser } from '@/app/Components/UserProvider'
import {
  readUserProfileByUid,
  readCompanyByUid,
  upsertUserProfileByUid,
  upsertCompanyByUid,
  type CompanyPayload,
  type BankAccount,
} from '@/fb/data'
import {
  EmailAuthProvider,
  reauthenticateWithCredential,
  updatePassword,
} from 'firebase/auth'

const BANKS_NI = ['BAC', 'LAFISE', 'Bampro']

export default function AjustesPage() {
  const router = useRouter()
  const { authUser, profile, loading, resendVerification, refreshProfile } = useUser()

  // Redirección si no hay sesión
  useEffect(() => {
    if (!loading && !authUser) router.replace('/login')
  }, [loading, authUser, router])

  // Perfil
  const [name, setName] = useState(profile?.name ?? '')
  const [emailVerified, setEmailVerified] = useState<boolean | null>(null)

  // Empresa
  const [companyName, setCompanyName] = useState('')
  const [phone, setPhone] = useState('')
  const [address, setAddress] = useState('')
  const [accounts, setAccounts] = useState<BankAccount[]>([
    { bank: '', number: '', holder: '', currency: 'NIO' },
  ])

  // Seguridad (cambio de contraseña)
  const [pwdCurrent, setPwdCurrent] = useState('')
  const [pwdNew, setPwdNew] = useState('')

  // Carga de datos por UID
  useEffect(() => {
    if (!authUser) return
    ;(async () => {
      const uid = authUser.uid
      setEmailVerified(authUser.emailVerified)

      const p = await readUserProfileByUid(uid)
      setName(p?.name ?? profile?.name ?? '')

      const c = await readCompanyByUid(uid)
      if (c) {
        setCompanyName(c.name ?? '')
        setPhone(c.phone ?? '')
        setAddress(c.address ?? '')
        setAccounts(
          Array.isArray(c.accounts) && c.accounts.length
            ? (c.accounts as BankAccount[])
            : [{ bank: '', number: '', holder: '', currency: 'NIO' }],
        )
      } else {
        setCompanyName('')
        setPhone('')
        setAddress('')
        setAccounts([{ bank: '', number: '', holder: '', currency: 'NIO' }])
      }
    })()
  }, [authUser, profile?.name])

  if (loading || !authUser) return null

  // Guardar perfil
  const saveProfile = async () => {
    try {
      await upsertUserProfileByUid(authUser.uid, {
        name: name.trim(),
        email: authUser.email ?? '',
      })
      await refreshProfile() // refresca el contexto → actualiza el topbar
      alert('Perfil guardado ✅')
    } catch (e) {
      console.error(e)
      alert('No se pudo guardar el perfil.')
    }
  }

  // Guardar empresa
  const saveCompany = async () => {
    const accountsClean = accounts
      .filter((a) => a.bank || a.number || a.holder)
      .map((a) => ({
        bank: (a.bank || '').trim(),
        number: (a.number || '').trim(),
        holder: (a.holder || '').trim(),
        currency: a.currency || 'NIO',
      }))

    const payload: CompanyPayload = {
      name: (companyName || '').trim(),
      phone: (phone || '').trim(),
      address: (address || '').trim(),
      accounts: accountsClean,
    }

    try {
      await upsertCompanyByUid(authUser.uid, payload)
      alert('Empresa guardada ✅')
    } catch (e: any) {
      console.error('Guardar empresa error:', e)
      alert(`No se pudo guardar la empresa.\n${e?.message || ''}`)
    }
  }

  // Cambiar contraseña
  const changePassword = async () => {
    if (!authUser?.email) return alert('No hay sesión')
    if (!pwdCurrent || !pwdNew) return alert('Completá ambas contraseñas.')
    try {
      const cred = EmailAuthProvider.credential(authUser.email, pwdCurrent)
      await reauthenticateWithCredential(authUser, cred)
      await updatePassword(authUser, pwdNew)
      setPwdCurrent('')
      setPwdNew('')
      alert('Contraseña actualizada ✅')
    } catch (e: any) {
      console.error(e)
      alert(e?.message || 'No se pudo actualizar la contraseña.')
    }
  }

  const addAccount = () =>
    setAccounts((prev) => [
      ...prev,
      { bank: '', number: '', holder: '', currency: 'NIO' },
    ])
  const updateAccount = (idx: number, patch: Partial<BankAccount>) =>
    setAccounts((prev) => prev.map((a, i) => (i === idx ? { ...a, ...patch } : a)))
  const removeAccount = (idx: number) =>
    setAccounts((prev) => prev.filter((_, i) => i !== idx))

  const handleResend = async () => {
    try {
      await resendVerification()
      alert('Si tu correo no estaba verificado, enviamos un email de verificación.')
    } catch (e: any) {
      alert(e?.message || 'No se pudo reenviar el correo.')
    }
  }

  return (
    <div className="max-w-4xl mx-auto py-6 space-y-8">
      <h1 className="text-2xl font-bold mb-2">Ajustes</h1>

      {!emailVerified && (
        <div className="rounded-lg border border-yellow-300 bg-yellow-50 p-4">
          <p className="font-medium">Tu correo no está verificado.</p>
          <p className="text-sm text-gray-700">Revisá tu bandeja o solicitá un nuevo correo.</p>
          <button onClick={handleResend} className="mt-2 rounded-full border px-4 py-1.5 hover:bg-yellow-100">
            Reenviar verificación
          </button>
        </div>
      )}

      {/* PERFIL */}
      <section className="rounded-2xl border bg-white p-5 shadow-sm">
        <h2 className="text-lg font-semibold mb-4">Perfil</h2>
        <div className="grid gap-3">
          <label className="text-sm">
            <span className="block mb-1 text-gray-700">Nombre</span>
            <input
              className="w-full rounded-lg border px-3 py-2"
              placeholder="Tu nombre"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>

          <label className="text-sm">
            <span className="block mb-1 text-gray-700">Correo (de tu sesión)</span>
            <input
              className="w-full rounded-lg border px-3 py-2 bg-gray-50 text-gray-500"
              value={authUser.email ?? ''}
              readOnly
            />
          </label>

          <button
            onClick={saveProfile}
            className="mt-2 inline-flex items-center justify-center rounded-full bg-[#004aad] px-5 py-2.5 text-white font-semibold hover:brightness-110"
          >
            Guardar cambios
          </button>
        </div>
      </section>

      {/* SEGURIDAD */}
      <section className="rounded-2xl border bg-white p-5 shadow-sm">
        <h2 className="text-lg font-semibold mb-4">Seguridad</h2>
        <div className="grid md:grid-cols-2 gap-3">
          <input
            className="rounded-lg border px-3 py-2"
            type="password"
            placeholder="Contraseña actual"
            value={pwdCurrent}
            onChange={(e) => setPwdCurrent(e.target.value)}
          />
          <input
            className="rounded-lg border px-3 py-2"
            type="password"
            placeholder="Nueva contraseña"
            value={pwdNew}
            onChange={(e) => setPwdNew(e.target.value)}
          />
        </div>
        <button onClick={changePassword} className="mt-3 rounded-full border px-4 py-2 hover:bg-gray-50">
          Cambiar contraseña
        </button>
      </section>

      {/* EMPRESA */}
      <section className="rounded-2xl border bg-white p-5 shadow-sm">
        <h2 className="text-lg font-semibold mb-4">Datos de la empresa</h2>

        <div className="grid md:grid-cols-2 gap-3">
          <label className="text-sm">
            <span className="block mb-1 text-gray-700">Nombre comercial</span>
            <input
              className="w-full rounded-lg border px-3 py-2"
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
            />
          </label>

        <label className="text-sm">
            <span className="block mb-1 text-gray-700">Teléfono</span>
            <input
              className="w-full rounded-lg border px-3 py-2"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+505 8888-8888"
            />
          </label>

          <label className="text-sm md:col-span-2">
            <span className="block mb-1 text-gray-700">Dirección</span>
            <input
              className="w-full rounded-lg border px-3 py-2"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
            />
          </label>
        </div>

        <div className="mt-5">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="font-medium">Métodos de pago (transferencia)</h3>
            <button className="rounded-full border px-3 py-1.5 text-sm hover:bg-gray-50" onClick={addAccount}>
              + Agregar cuenta
            </button>
          </div>

          <div className="space-y-3">
            {accounts.map((a, i) => (
              <div key={i} className="grid md:grid-cols-5 gap-2 items-center">
                <select
                  className="rounded-lg border px-3 py-2"
                  value={a.bank}
                  onChange={(e) => updateAccount(i, { bank: e.target.value })}
                >
                  <option value="">Banco</option>
                  {BANKS_NI.map((b) => (
                    <option key={b} value={b}>{b}</option>
                  ))}
                </select>

                <input
                  className="rounded-lg border px-3 py-2 md:col-span-2"
                  placeholder="Número de cuenta"
                  value={a.number}
                  onChange={(e) => updateAccount(i, { number: e.target.value })}
                />

                <input
                  className="rounded-lg border px-3 py-2"
                  placeholder="Titular"
                  value={a.holder}
                  onChange={(e) => updateAccount(i, { holder: e.target.value })}
                />

                <select
                  className="rounded-lg border px-3 py-2"
                  value={a.currency}
                  onChange={(e) => updateAccount(i, { currency: e.target.value })}
                >
                  <option value="NIO">NIO — Córdoba</option>
                  <option value="USD">USD — Dólar</option>
                </select>

                <div className="md:col-span-5 flex justify-end">
                  <button className="text-sm text-red-600 hover:bg-red-50 rounded-full px-3 py-1" onClick={() => removeAccount(i)}>
                    Eliminar
                  </button>
                </div>
              </div>
            ))}
          </div>

          <button
            onClick={saveCompany}
            className="mt-4 inline-flex items-center justify-center rounded-full bg-[#004aad] px-5 py-2.5 text-white font-semibold hover:brightness-110"
          >
            Guardar empresa
          </button>
        </div>
      </section>
    </div>
  )
}
