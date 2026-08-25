// B2-BASE-PAGO-DETALLE — Suite focal de lib/campos-base-datos.ts
//
// Fixtures calcados de shenvios-staging (lectura del 2026-08-25):
//   ownerSnapshot solo trae companyName, nombre y uid — phone nunca existió
//   macroZona{Retiro,Entrega}Nombre están en 6/6; la zona fina en 3/6 y 5/6

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  telefonoComercio,
  zonaRetiro,
  zonaEntrega,
  telefonoRetiro,
  telefonoEntrega,
  type EntradaCamposBaseDatos,
} from './campos-base-datos'

// ── T1-T3 · teléfono ────────────────────────────────────────────────────────
test('T1 · teléfono del comercio cuando el snapshot lo trae', () => {
  assert.equal(telefonoComercio({ ownerSnapshot: { phone: '89480222' } }), '89480222')
})

test('T2 · nombres legacy del mismo concepto', () => {
  assert.equal(telefonoComercio({ ownerSnapshot: { telefono: '83637003' } }), '83637003')
  assert.equal(telefonoComercio({ ownerSnapshot: { celular: '58392176' } }), '58392176')
  // `phone` gana si están varios.
  assert.equal(telefonoComercio({ ownerSnapshot: { phone: 'A', telefono: 'B', celular: 'C' } }), 'A')
})

test('T3 · sin teléfono del comercio devuelve null, no el de otro punto', () => {
  // Caso real de staging: ownerSnapshot sin phone pero con teléfonos de
  // retiro y entrega. Rellenar con esos haría llamar al número equivocado.
  const s: EntradaCamposBaseDatos = {
    ownerSnapshot: {},
    recoleccion: { celular: '89480222' },
    entrega: { celular: '88302535' },
  }
  assert.equal(telefonoComercio(s), null)
  assert.equal(telefonoComercio({}), null)
  assert.equal(telefonoComercio({ ownerSnapshot: null }), null)
  assert.equal(telefonoComercio({ ownerSnapshot: { phone: '   ' } }), null)
})

// ── T4-T7 · zonas ───────────────────────────────────────────────────────────
test('T4 · zona de retiro fina cuando existe', () => {
  assert.equal(zonaRetiro({ zonaRetiroNombre: 'Bo Acahualinca', macroZonaRetiroNombre: 'Zona Nor - Oeste' }), 'Bo Acahualinca')
})

test('T5 · sin zona fina cae a la macrozona', () => {
  // 8MWJtz4G y fq6w3pXc: solo macrozona.
  assert.equal(zonaRetiro({ macroZonaRetiroNombre: 'Zona Aeropuerto' }), 'Zona Aeropuerto')
  assert.equal(zonaRetiro({ zonaRetiroNombre: '', macroZonaRetiroNombre: 'Zona C. Masaya' }), 'Zona C. Masaya')
})

test('T6 · zona de entrega fina cuando existe', () => {
  assert.equal(zonaEntrega({ zonaEntregaNombre: 'Zona Universitaria UCA - UNI', macroZonaEntregaNombre: 'Zona Centro' }), 'Zona Universitaria UCA - UNI')
})

test('T7 · entrega sin zona fina cae a macrozona', () => {
  assert.equal(zonaEntrega({ macroZonaEntregaNombre: 'Zona Aeropuerto' }), 'Zona Aeropuerto')
})

test('T7b · sin ninguna zona devuelve null', () => {
  assert.equal(zonaRetiro({}), null)
  assert.equal(zonaEntrega({}), null)
  assert.equal(zonaRetiro({ zonaRetiroNombre: null, macroZonaRetiroNombre: null }), null)
})

test('T7c · retiro y entrega no se cruzan', () => {
  const s: EntradaCamposBaseDatos = {
    zonaRetiroNombre: 'RETIRO',
    zonaEntregaNombre: 'ENTREGA',
  }
  assert.equal(zonaRetiro(s), 'RETIRO')
  assert.equal(zonaEntrega(s), 'ENTREGA')
})

// ── T8 ──────────────────────────────────────────────────────────────────────
test('T8 · el literal "zona" del placeholder no es un dato', () => {
  // registro.zona está vacío en las 6 órdenes; lo que se veía era el
  // placeholder del input. Estos helpers no lo consultan siquiera.
  const s = { registro: { zona: '' } } as unknown as EntradaCamposBaseDatos
  assert.equal(zonaRetiro(s), null)
  assert.equal(zonaEntrega(s), null)
})

// ── Teléfonos de los puntos ─────────────────────────────────────────────────
test('PUNTOS · cada teléfono con su punto', () => {
  const s: EntradaCamposBaseDatos = {
    recoleccion: { celular: '89480222' },
    entrega: { celular: '88302535' },
  }
  assert.equal(telefonoRetiro(s), '89480222')
  assert.equal(telefonoEntrega(s), '88302535')
})

test('PUNTOS · entrega sin celular (XbMyvCxL) devuelve null', () => {
  assert.equal(telefonoEntrega({ entrega: { celular: '' } }), null)
  assert.equal(telefonoEntrega({}), null)
  assert.equal(telefonoRetiro({}), null)
})
