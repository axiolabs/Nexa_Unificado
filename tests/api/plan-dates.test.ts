import { describe, expect, it } from 'vitest'
import {
  formatPlanMoment,
  isLocalInputValue,
  nextQuarterHour,
  toApiDate,
  toLocalInputValue,
} from '../../lib/plan-dates'

/**
 * El modulo de fechas del formulario de creacion de plan.
 *
 * Estos tests son todos de zona INDEPENDIENTE a proposito: el proceso de test
 * corre en UTC, el navegador del host en la suya, y un test que pasara solo en
 * una de las dos zonas no verifica el comportamiento sino la maquina. Por eso
 * aca se comparan valores formateados contra la misma zona que usa el runtime,
 * y no contra horas de Buenos Aires escritas a mano.
 */
describe('toApiDate', () => {
  it('convierte un valor de datetime-local en un ISO con offset', () => {
    const iso = toApiDate('2026-10-08T20:00')
    expect(iso).toMatch(/Z$/)
    // La hora de pared se conserva: leer el ISO en la zona del runtime tiene que
    // devolver las 20:00 que el usuario escribio. Si esto no se cumple, el plan
    // se guarda a otra hora y el error es invisible.
    expect(new Date(iso!).getHours()).toBe(20)
    expect(new Date(iso!).getMinutes()).toBe(0)
  })

  it('devuelve null si el campo esta vacio, no un string roto', () => {
    expect(toApiDate('')).toBeNull()
    expect(toApiDate('   ')).toBeNull()
  })

  it('devuelve null ante una fecha imposible, en vez de tirar', () => {
    // Un RangeError de `toISOString` sobre un Date invalido tumba el render del
    // componente entero. Este es el test que lo evita.
    expect(() => toApiDate('no es una fecha')).not.toThrow()
    expect(toApiDate('no es una fecha')).toBeNull()
    expect(toApiDate('2026-13-45T99:99')).toBeNull()
  })

  it('tolera espacios alrededor del valor', () => {
    expect(toApiDate('  2026-10-08T20:00  ')).toBe(toApiDate('2026-10-08T20:00'))
  })
})

describe('formatPlanMoment', () => {
  it('muestra la hora de pared del instante, en la zona del runtime', () => {
    const iso = toApiDate('2026-10-08T20:00')!
    const texto = formatPlanMoment(iso)
    // El criterio no es la cadena exacta, que depende del ICU del runtime: es
    // que la hora que se muestra sea la que se escribio.
    expect(texto).toContain('20:00')
  })

  it('distingue de "Fecha invalida" en vez de mostrar "Invalid Date"', () => {
    expect(formatPlanMoment('no es una fecha')).toBe('Fecha invalida')
  })
})

describe('toLocalInputValue', () => {
  it('produce el formato que datetime-local acepta', () => {
    // Sin los ceros a la izquierda, el control no muestra nada y el usuario ve
    // un input vacio sin error.
    const d = new Date(2026, 0, 5, 7, 5)
    expect(toLocalInputValue(d)).toBe('2026-01-05T07:05')
    expect(isLocalInputValue(toLocalInputValue(d))).toBe(true)
  })

  it('usa la hora local, no la de UTC', () => {
    const d = new Date(2026, 0, 5, 7, 5)
    // Un instante a las 23:30 UTC puede ser otro dia entero en la zona local. Si
    // el modulo escribiera `toISOString`, el input mostraria el dia equivocado.
    expect(toLocalInputValue(d)).toBe(toLocalInputValue(new Date(d.getTime())))
    expect(toLocalInputValue(d).slice(0, 10)).toBe(
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
    )
  })
})

describe('el round-trip entre los dos formatters', () => {
  it('volver a formatear un ISO devuelve el valor original del input', () => {
    // Esta es la propiedad que hace que el formulario no pierda la hora. Los dos
    // formatters son independientes a proposito (uno con padStart, otro con
    // `new Date`), asi que este test no es tautologico.
    const original = '2026-10-08T20:30'
    const vuelta = toLocalInputValue(new Date(toApiDate(original)!))
    expect(vuelta).toBe(original)
  })
})

describe('nextQuarterHour', () => {
  it('siempre cae en un cuarto de hora exacto', () => {
    for (const min of [0, 1, 7, 14, 15, 16, 29, 44, 45, 59]) {
      const v = nextQuarterHour(new Date(2026, 9, 8, 19, min))
      const mm = Number(v.slice(14, 16))
      expect(mm % 15).toBe(0)
    }
  })

  it('nunca devuelve un instante ya pasado', () => {
    // El bug de usar redondeo al mas cercano: con 19:07 daria 19:00, que ya
    // paso, y el `min` del input invalidaria el valor que el modulo acabo de
    // calcular.
    for (const min of [1, 2, 7, 8, 14, 16, 23]) {
      const ahora = new Date(2026, 9, 8, 19, min)
      const valor = nextQuarterHour(ahora)
      expect(new Date(valor).getTime()).toBeGreaterThan(ahora.getTime())
    }
  })

  it('deja quieto un valor que ya esta en un cuarto de hora', () => {
    expect(nextQuarterHour(new Date(2026, 9, 8, 19, 15))).toBe('2026-10-08T19:15')
  })
})

describe('isLocalInputValue', () => {
  it('rechaza lo que no es la forma del control', () => {
    expect(isLocalInputValue('2026-10-08T20:00')).toBe(true)
    expect(isLocalInputValue('2026-10-08 20:00')).toBe(false)
    expect(isLocalInputValue('2026-10-08T20:00:00')).toBe(false)
    expect(isLocalInputValue('2026-10-08T20:00Z')).toBe(false)
    expect(isLocalInputValue('')).toBe(false)
  })
})
