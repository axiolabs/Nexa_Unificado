import { describe, expect, it } from 'vitest'
import { alineacionDe } from '../../lib/alignment'

/**
 * La alineacion persona <-> lugar, sin base de datos.
 *
 * Misma separacion que `personality-score.test.ts`: el calculo se prueba con
 * mapas vacios, y el endpoint solo tiene que traer filas. El numero se muestra
 * en la pantalla de aprobaciones del organizador, asi que un error aca no se
 * manifiesta como una excepcion sino como "este postulante no encaja", que es
 * exactamente el tipo de mentira silenciosa que el resto del proyecto busca.
 */

const mapa = (entrada: Record<string, number>): Map<string, number> => new Map(Object.entries(entrada))

describe('alineacionDe', () => {
  it('con un solo rasgo compartido, el normalizado es el valor de la persona', () => {
    const r = alineacionDe(mapa({ a: 2 }), mapa({ a: 0.5 }))
    expect(r).toEqual({ score: 1, normalizado: 2, traits: 1 })
  })

  it('pondera cada rasgo por el peso del lugar', () => {
    const r = alineacionDe(mapa({ a: 1, b: -0.5, c: 2 }), mapa({ a: 0.5, b: 0.25, c: 0.75 }))
    // 1*0.5 + (-0.5)*0.25 + 2*0.75 = 0.5 - 0.125 + 1.5 = 1.875
    expect(r!.score).toBeCloseTo(1.875, 10)
    // masa = 0.5 + 0.25 + 0.75 = 1.5 -> 1.875 / 1.5 = 1.25
    expect(r!.normalizado).toBeCloseTo(1.25, 10)
    expect(r!.traits).toBe(3)
  })

  it('no depende del orden en que llegan los mapas', () => {
    const a = alineacionDe(mapa({ a: 1, b: 2, c: 0.5 }), mapa({ a: 0.3, b: 0.6, c: 0.1 }))
    const b = alineacionDe(mapa({ c: 0.5, b: 2, a: 1 }), mapa({ c: 0.1, a: 0.3, b: 0.6 }))
    expect(a).toEqual(b)
  })

  describe('devuelve null, y no 0, cuando no hay nada que comparar', () => {
    it('la persona no hizo el test', () => {
      expect(alineacionDe(mapa({}), mapa({ a: 1, b: 1 }))).toBeNull()
    })

    it('el lugar no tiene rasgos cargados', () => {
      expect(alineacionDe(mapa({ a: 1, b: 2 }), mapa({}))).toBeNull()
    })

    it('la persona y el lugar no comparten ningun rasgo', () => {
      // El caso que mas importa: serian dos numeros y un 0 silencioso que
      // el organizador leeria como "no encaja", cuando en realidad no hay
      // nada medido en comun.
      expect(alineacionDe(mapa({ a: 1 }), mapa({ z: 1 }))).toBeNull()
    })

    it('todos los pesos del lugar son cero', () => {
      expect(alineacionDe(mapa({ a: 1, b: 2 }), mapa({ a: 0, b: 0 }))).toBeNull()
    })
  })

  it('un cero de verdad se distingue de un null', () => {
    // Se peso 1 y -0.5 sobre valores 1 y 1: 1 - 0.5 = 0.5 de score, y la masa
    // son 1.5. Da 0.333, que es un numero real calculado.
    const r = alineacionDe(mapa({ a: 1, b: 1 }), mapa({ a: 1, b: -0.5 }))
    expect(r).not.toBeNull()
    expect(r!.normalizado).toBeCloseTo(1 / 3, 10)
  })

  it('la masa usa el valor absoluto del peso, no la suma con signo', () => {
    // Con la suma con signo el denominador seria 0.5 en vez de 1.5, y el
    // normalizado daria 1.0 en vez de 0.333. Es el unico test que distingue
    // las dos formulas: con suma de signos opuestos el denominador puede
    // acercarse a cero y la alineacion se dispara sin que nada falle.
    const r = alineacionDe(mapa({ a: 1, b: 1 }), mapa({ a: 1, b: -0.5 }))
    expect(r!.normalizado).toBeCloseTo(0.5 / 1.5, 10)
    expect(r!.normalizado).not.toBeCloseTo(0.5 / 0.5, 10)
  })

  it('un peso de cero no cuenta como rasgo comparado', () => {
    // "Este rasgo pesa 0 aca" no es un rasgo medido: contarlo inflaria la
    // cobertura y la pantalla diria que se compararon 2 rasgos.
    const r = alineacionDe(mapa({ a: 1, b: 3 }), mapa({ a: 1, b: 0 }))
    expect(r!.traits).toBe(1)
    expect(r!.normalizado).toBe(1)
  })

  describe('datos no finitos', () => {
    it('un NaN en el puntaje no envenena la suma', () => {
      const r = alineacionDe(mapa({ a: Number.NaN, b: 1 }), mapa({ a: 1, b: 1 }))
      // Si el NaN entrara en la suma, `score` seria NaN y `normalizado` tambien,
      // y en pantalla se veria literalmente "NaN" sin ningun error.
      expect(r!.score).toBe(1)
      expect(Number.isNaN(r!.normalizado)).toBe(false)
      expect(r!.traits).toBe(1)
    })

    it('un Infinity en el peso se ignora', () => {
      const r = alineacionDe(mapa({ a: 1, b: 5 }), mapa({ a: 1, b: Number.POSITIVE_INFINITY }))
      expect(r!.score).toBe(1)
      expect(r!.traits).toBe(1)
    })

    it('un Infinity en el puntaje se ignora', () => {
      const r = alineacionDe(mapa({ a: 1, b: Number.POSITIVE_INFINITY }), mapa({ a: 1, b: 1 }))
      expect(r!.traits).toBe(1)
      expect(Number.isFinite(r!.score)).toBe(true)
    })
  })
})
