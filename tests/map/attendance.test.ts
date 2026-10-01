import { describe, expect, it } from 'vitest'
import { MARCABLES, puedeMarcar, resumenAsistencia } from '../../lib/attendance'
import type { ParticipationStatus } from '@prisma/client'

/**
 * Puro, como el resto de `tests/map`.
 *
 * La parte que mas importa aca no es `puedeMarcar` en si, sino que la misma
 * lista gobierne la pantalla y el POST. Esta es la unica fuente de la lista, y
 * los tests de API la usan de verdad (el fixture siembra solo `ACCEPTED` y
 * `ATTENDED`, que son los dos que esta funcion acepta desde antes de que existiera
 * la pantalla).
 */

describe('puedeMarcar', () => {
  it('acepta los tres estados con lugar', () => {
    expect(MARCABLES).toEqual(['ACCEPTED', 'ATTENDED', 'NO_SHOW'])
    expect(puedeMarcar('ACCEPTED')).toBe(true)
    expect(puedeMarcar('ATTENDED')).toBe(true)
    expect(puedeMarcar('NO_SHOW')).toBe(true)
  })

  it('rechaza los tres que nunca tuvieron lugar', () => {
    // Un REQUESTED puede ser el error de tipeo mas caro del sistema: si se
    // marcara, quedaria un ATTENDED de alguien que nunca estuvo, y la
    // reliability contaria un plan que no ocurrio como algo que si ocurrio.
    expect(puedeMarcar('REQUESTED')).toBe(false)
    expect(puedeMarcar('DECLINED')).toBe(false)
    expect(puedeMarcar('CANCELLED')).toBe(false)
  })

  it('no crashea con nada, porque la pantalla lo llama con lo que hay', () => {
    expect(puedeMarcar(null)).toBe(false)
    expect(puedeMarcar(undefined)).toBe(false)
  })

  it('no acepta un estado que no existe, aunque el tipo lo prohiba', () => {
    // El tipo dice que esto no compila, y no compila. El `as` de test queda
    // explicito de todos modos, para que si alguien amplia el enum del schema
    // el test se acuerde de que hay que decidir sobre el estado nuevo.
    expect(puedeMarcar('WALKED_IN' as ParticipationStatus)).toBe(false)
  })
})

describe('resumenAsistencia', () => {
  it('parte los tres y dice si falta algo', () => {
    const r = resumenAsistencia([
      { status: 'ATTENDED' },
      { status: 'ATTENDED' },
      { status: 'NO_SHOW' },
      { status: 'ACCEPTED' },
    ])
    expect(r).toEqual({ total: 4, asistio: 2, noShow: 1, sinMarcar: 1, completo: false })
  })

  it('esta completo cuando no queda ningun ACCEPTED', () => {
    // Los ATTENDED y NO_SHOW ya estan resueltos y aun asi conservan boton para
    // corregirse. Por eso "completo" no es "todos tienen boton prendido", que
    // nunca seria cierto: el boton queda prendido justamente para cambiarlo.
    const r = resumenAsistencia([{ status: 'ATTENDED' }, { status: 'NO_SHOW' }])
    expect(r.completo).toBe(true)
    expect(r.sinMarcar).toBe(0)
  })

  it('un plan vacio esta completo de la misma forma', () => {
    // Un plan donde se dio de baja todo el mundo igual tiene una lista para
    // completar, y mostrarla como "0 de 0" es ruido, no informacion.
    expect(resumenAsistencia([]).completo).toBe(true)
  })

  it('un estado raro cuenta como pendiente, no como attendance', () => {
    // El caso de seguridad: si un estado nuevo aparece en el schema y esta
    // pantalla se olvida de el, el default tiene que ser "falta marcar", nunca
    // "asistio". Un default optimista contaria a alguien que no vino.
    const r = resumenAsistencia([{ status: 'ATTENDED' }, { status: 'WALKED_IN' as ParticipationStatus }])
    expect(r.asistio).toBe(1)
    expect(r.sinMarcar).toBe(1)
  })
})
