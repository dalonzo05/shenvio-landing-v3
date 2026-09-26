// MOTORIZADO EMAIL VERIFIED V1 + MOTO-ALTA-AUTH-ROL-1 — cadena de evidencia del
// acceso de un motorizado y decisión de la invitación de activación.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  operadorAutorizado,
  evaluarConfirmacionMotorizado,
  evaluarInvitacionMotorizado,
  type MotorizadoTargetInput,
} from './motorizado-acceso'

const SANO: MotorizadoTargetInput = {
  motorizadoExiste: true,
  authUidMotorizado: 'uid_l',
  usuarioExiste: true,
  usuarioActivo: true,
  usuarioRol: 'motorizado',
  usuarioEmail: 'luigi@example.com',
  authUserExiste: true,
  authUserEmail: 'luigi@example.com',
  authUserEmailVerified: false,
}

test('MAC1 · solo un admin o gestor activo y existente es operador autorizado', () => {
  assert.equal(operadorAutorizado({ existe: true, activo: true, rol: 'admin' }), true)
  assert.equal(operadorAutorizado({ existe: true, activo: true, rol: 'gestor' }), true)
  for (const rol of ['motorizado', 'digitador', 'Comercio', 'cliente', undefined]) {
    assert.equal(operadorAutorizado({ existe: true, activo: true, rol }), false, String(rol))
  }
  assert.equal(operadorAutorizado({ existe: true, activo: false, rol: 'admin' }), false)
  assert.equal(operadorAutorizado({ existe: false, activo: true, rol: 'admin' }), false)
})

test('MAC2 · la cadena completa confirma; cualquier eslabón roto rechaza con su motivo', () => {
  assert.deepEqual(evaluarConfirmacionMotorizado(SANO), { tipo: 'confirmar', yaVerificado: false })
  const casos: [Partial<MotorizadoTargetInput>, string][] = [
    [{ motorizadoExiste: false }, 'motorizado_no_encontrado'],
    [{ authUidMotorizado: '' }, 'authUid_invalido'],
    [{ authUidMotorizado: null }, 'authUid_invalido'],
    [{ usuarioExiste: false }, 'usuario_no_encontrado'],
    // El caso Luigi: el perfil existe pero sin rol ni activo.
    [{ usuarioRol: undefined, usuarioActivo: undefined }, 'usuario_no_valido'],
    [{ usuarioRol: 'gestor' }, 'usuario_no_valido'],
    [{ usuarioActivo: false }, 'usuario_no_valido'],
    [{ authUserExiste: false }, 'auth_user_no_encontrado'],
    [{ authUserEmail: 'otra@example.com' }, 'email_incoherente'],
  ]
  for (const [cambio, motivo] of casos) {
    assert.deepEqual(evaluarConfirmacionMotorizado({ ...SANO, ...cambio }), { tipo: 'rechazar', motivo }, motivo)
  }
})

test('MAC3 · la invitación se envía solo con la cadena completa y la cuenta sin verificar', () => {
  assert.deepEqual(evaluarInvitacionMotorizado(SANO), { tipo: 'enviar' })
})

test('MAC4 · una cuenta ya verificada no necesita invitación', () => {
  assert.deepEqual(evaluarInvitacionMotorizado({ ...SANO, authUserEmailVerified: true }), { tipo: 'ya_activo' })
})

test('MAC5 · la invitación NUNCA se envía sobre una cadena rota (perfil sin rol, otro rol, sin Auth)', () => {
  for (const cambio of [
    { usuarioRol: undefined, usuarioActivo: undefined },
    { usuarioRol: 'admin' },
    { usuarioExiste: false },
    { authUserExiste: false },
    { authUidMotorizado: undefined },
    { authUserEmail: 'otra@example.com' },
  ] as Partial<MotorizadoTargetInput>[]) {
    const d = evaluarInvitacionMotorizado({ ...SANO, ...cambio })
    assert.equal(d.tipo, 'rechazar', JSON.stringify(cambio))
  }
})

test('MAC6 · la coherencia de correo no distingue mayúsculas ni espacios', () => {
  assert.equal(evaluarInvitacionMotorizado({ ...SANO, usuarioEmail: '  LUIGI@Example.com ' }).tipo, 'enviar')
})
