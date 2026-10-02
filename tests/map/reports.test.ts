import { describe, expect, it } from 'vitest'
import {
  DETALLE_REQUERIDO,
  MOTIVOS_POR_OBJETIVO,
  MOTIVO_LABELS,
  AUTORREPORTE,
  MOTIVO_INVALIDO,
  SIN_SESION,
  puedeReportar,
  motivoValido,
  motivosPara,
} from '../../lib/reports'
import type { ReportReason, ReportTarget } from '@prisma/client'

/**
 * Que se puede denunciar y cuando no.
 *
 * La logica es chica, pero decide que llega a la cola de la curaduria y que no.
 * Un `true` de mas mete ruido que el equipo tiene que leer; un `true` de menos
 * deja pasar lo que la persona queria reportar, que es peor: la persona se va
 * pensando que la app esta rota.
 */

const base = {
  target: 'PLACE' as ReportTarget,
  reason: 'CLOSED',
  reporterId: 'ana',
  targetId: 'lugar-1',
}

describe('motivosPorObjetivo', () => {
  it('cada objetivo tiene al menos un motivo y todos existen como etiqueta', () => {
    for (const [target, motivos] of Object.entries(MOTIVOS_POR_OBJETIVO)) {
      expect(motivos.length, target).toBeGreaterThan(0)
      for (const m of motivos) {
        expect(MOTIVO_LABELS[m as ReportReason], `${target}/${m}`).toBeTruthy()
        expect(MOTIVO_LABELS[m as ReportReason].trim(), `${target}/${m}`).not.toBe('')
      }
    }
  })

  it('"no se presento" no es un motivo de lugar', () => {
    // "No se presentó" es un hecho de una persona en un plan, no de un cafe.
    // Ofrecerlo en un lugar hace que la gente lo elija sin querer.
    expect(motivosPara('PLACE')).not.toContain('NO_SHOW_RISK')
    expect(motivosPara('PLACE')).toContain('CLOSED')
  })

  it('"esta cerrado" no es un motivo de persona', () => {
    expect(motivosPara('USER')).not.toContain('CLOSED')
  })

  it('un motivo valido lo es solo para su objetivo', () => {
    // El subconjunto se deriva del enum plano, asi que esto puede romperse solo
    // si alguien agrega un motivo a un objetivo equivocado.
    expect(motivoValido('PLACE', 'CLOSED')).toBe(true)
    expect(motivoValido('PLACE', 'NO_SHOW_RISK')).toBe(false)
    expect(motivoValido('PLAN', 'NO_SHOW_RISK')).toBe(true)
    expect(motivoValido('MESSAGE', 'NO_SHOW_RISK')).toBe(false)
  })

  it('un motivo que existe en el enum pero no aplica se rechaza', () => {
    // El caso que importa: el enum es plano, asi que "existe" no es lo mismo que
    // "aplica". Si el endpoint validara contra el enum, dejaria pasar esto.
    expect(motivoValido('PLACE', 'HARASSMENT')).toBe(false)
    expect(motivoValido('MESSAGE', 'CLOSED')).toBe(false)
  })
})

describe('puedeReportar', () => {
  it('permite una denuncia normal', () => {
    expect(puedeReportar(base)).toBeNull()
  })

  it('sin sesion no se puede, y el motivo es el de la sesion', () => {
    expect(puedeReportar({ ...base, reporterId: null })).toBe(SIN_SESION)
  })

  it('no te podes denunciar a vos mismo', () => {
    expect(puedeReportar({ ...base, targetId: 'ana' })).toBe(AUTORREPORTE)
  })

  it('tampoco al organizador de tu plan ni al autor de tu mensaje', () => {
    // El caso real: el `targetId` del plan es el del PLAN, que no es el del
    // organizador. Sin `relacionados` este auto-reporte pasaria limpio.
    expect(
      puedeReportar({
        target: 'PLAN',
        reason: 'MISLEADING',
        reporterId: 'beto',
        targetId: 'plan-9',
        relacionados: ['beto'],
      }),
    ).toBe(AUTORREPORTE)

    expect(
      puedeReportar({
        target: 'MESSAGE',
        reason: 'HARASSMENT',
        reporterId: 'beto',
        targetId: 'msg-3',
        relacionados: ['beto'],
      }),
    ).toBe(AUTORREPORTE)
  })

  it('un motivo que no aplica para el objetivo se rechaza', () => {
    expect(puedeReportar({ ...base, reason: 'NO_SHOW_RISK' })).toBe(MOTIVO_INVALIDO)
  })

  it('"otra cosa" sin detalle no alcanza', () => {
    expect(puedeReportar({ ...base, reason: 'OTHER' })).toBe(DETALLE_REQUERIDO)
    expect(puedeReportar({ ...base, reason: 'OTHER', detail: '' })).toBe(DETALLE_REQUERIDO)
    expect(puedeReportar({ ...base, reason: 'OTHER', detail: '   ' })).toBe(DETALLE_REQUERIDO)
    expect(puedeReportar({ ...base, reason: 'OTHER', detail: null })).toBe(DETALLE_REQUERIDO)
    expect(puedeReportar({ ...base, reason: 'OTHER', detail: 'cerro hace meses' })).toBeNull()
  })

  it('un motivo concreto NO pide detalle', () => {
    // Si el detalle fuera obligatorio siempre, la gente no denunciaria: el
    // motivo ya es un set cerrado y escribir un texto es un esfuerzo extra que
    // mucha gente no quiere hacer.
    expect(puedeReportar({ ...base, reason: 'CLOSED' })).toBeNull()
    expect(puedeReportar({ ...base, reason: 'CLOSED', detail: null })).toBeNull()
  })

  it('el orden de las reglas no tapa el motivo real', () => {
    // Sin sesion Y denunciandose a si mismo: la respuesta es la de sesion, que es
    // la primera. Y con motivo invalido Y sin detalle: la del motivo, porque
    // `OTHER` es valido para un lugar y no estamos ahi todavia.
    expect(puedeReportar({ ...base, reporterId: null, targetId: 'ana' })).toBe(SIN_SESION)
    expect(puedeReportar({ ...base, reason: 'NO_SHOW_RISK' })).toBe(MOTIVO_INVALIDO)
  })

  it('sin `relacionados` no rompe', () => {
    expect(puedeReportar({ ...base, relacionados: undefined })).toBeNull()
    expect(puedeReportar({ ...base, relacionados: [] })).toBeNull()
  })
})
