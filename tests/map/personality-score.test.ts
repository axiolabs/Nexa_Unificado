import { describe, expect, it } from 'vitest'
import { sumarScores, verificarRespuestas } from '../../lib/personality'
import { TEST_V1 } from '../../prisma/personality-v1.mjs'

/**
 * El algoritmo del score, sin base de datos.
 *
 * Esta separacion es la que hace que `PersonalityScore` sea regenerable: el
 * algoritmo se prueba aca, con arrays, y el endpoint solo tiene que pasarle
 * filas. Si el calculo estuviera en el POST, cambiarlo obligaria a que todos
 * vuelvan a hacer el test.
 */

/** El rango real de cada trait, derivado del contenido y no escrito a mano. */
const rangoPorTrait = (() => {
  const r = new Map<string, { min: number; max: number; preguntas: number }>()
  for (const q of TEST_V1.questions) {
    const previo = r.get(q.trait) ?? { min: 0, max: 0, preguntas: 0 }
    const deltas = q.options.map((_, j) => TEST_V1.escala[j] * q.weight)
    r.set(q.trait, {
      min: previo.min + Math.min(...deltas),
      max: previo.max + Math.max(...deltas),
      preguntas: previo.preguntas + 1,
    })
  }
  return r
})()

describe('el contenido de la v1 se puede puntuar', () => {
  it('el rango teorico es el que dice el contenido, para ningun trait undefined', () => {
    // Si una pregunta declara un trait que no esta en `TRAITS_V1`, el seed lo
    // rechaza, pero el rango se calcula aca desde el mismo contenido: si las dos
    // cosas se desincronizan, este test deja de poder leer el rango y falla en
    // vez de devolver un `undefined` silencioso.
    for (const q of TEST_V1.questions) {
      expect(rangoPorTrait.get(q.trait), `trait ${q.trait}`).toBeDefined()
    }
  })

  it('la suma no puede salirse del rango teorico, en ninguna combinacion', () => {
    // El caso caro de verdad: los 5^8 = 390625 combos posibles. Muestrea los
    // extremos y el medio, que es donde un algoritmo se rompe: promedia donde
    // deberia sumar, o incluye el delta equivocado.
    const preguntas = TEST_V1.questions
    const opcionesDe = (p: (typeof preguntas)[number]) =>
      p.options.map((_, j) => TEST_V1.escala[j] * p.weight)

    for (const modo of ['min', 'max', 'medio'] as const) {
      const elegidas = preguntas.map((p) => {
        const deltas = opcionesDe(p)
        const i = modo === 'min' ? 0 : modo === 'max' ? deltas.length - 1 : 2
        return { questionId: p.prompt, traitId: p.trait, scoreDelta: deltas[i] }
      })
      const scores = sumarScores(elegidas)
      for (const s of scores) {
        const rango = rangoPorTrait.get(s.traitId)
        expect(rango, s.traitId).toBeDefined()
        if (!rango) continue
        expect(s.value, `${s.traitId} en ${modo}`).toBeGreaterThanOrEqual(rango.min)
        expect(s.value, `${s.traitId} en ${modo}`).toBeLessThanOrEqual(rango.max)
      }
    }
  })

  it('el maximo de una pregunta pesa mas que el de su hermana mas liviana', () => {
    // El motivo por el que se SUMA y no se promedia. Si esto dejara de ser cierto,
    // el `weight` no estaria pesando y la suma seria un promedio disfrazado.
    const nuevaGente = TEST_V1.questions.filter((q) => q.trait === 'nueva_gente')
    expect(nuevaGente).toHaveLength(2)
    const pesos = nuevaGente.map((q) => Math.max(...TEST_V1.escala) * q.weight)
    expect(pesos[0]).toBeGreaterThan(pesos[1])
  })
})

describe('sumarScores', () => {
  it('agrupa por trait', () => {
    const s = sumarScores([
      { questionId: 'q1', traitId: 't1', scoreDelta: 1.5 },
      { questionId: 'q2', traitId: 't1', scoreDelta: 0.75 },
      { questionId: 'q3', traitId: 't2', scoreDelta: -1 },
    ])
    expect(s).toEqual([
      { traitId: 't1', value: 2.25 },
      { traitId: 't2', value: -1 },
    ])
  })

  it('un delta de cero produce un score de cero, y aparece en la lista', () => {
    // "No tengo opinion" no es lo mismo que "no contesto". Si el cero no
    // apareciera, un filtro future no podria distinguir las dos cosas, y trataria
    // a alguien que contesto con opinion nula como si no tuviera dato.
    const s = sumarScores([{ questionId: 'q1', traitId: 't1', scoreDelta: 0 }])
    expect(s).toEqual([{ traitId: 't1', value: 0 }])
  })

  it('un trait sin respuestas no aparece', () => {
    const s = sumarScores([{ questionId: 'q1', traitId: 't1', scoreDelta: 1 }])
    expect(s.map((x) => x.traitId)).toEqual(['t1'])
  })

  it('sin respuestas devuelve lista vacia, no error', () => {
    expect(sumarScores([])).toEqual([])
  })

  it('el orden no depende del orden de llegada', () => {
    // El endpoint puede leer las opciones en cualquier orden de la base. Si el
    // array de salida dependiera de ese orden, dos resultados identicos darian
    // JSON distinto y un test de snapshot fallaria sin que cambiara nada.
    const a = [
      { questionId: 'q1', traitId: 'zzz', scoreDelta: 1 },
      { questionId: 'q2', traitId: 'aaa', scoreDelta: 2 },
    ]
    const b = [...a].reverse()
    expect(sumarScores(a)).toEqual(sumarScores(b))
  })
})

describe('verificarRespuestas: una por pregunta, exactamente', () => {
  const test = ['q1', 'q2', 'q3']

  it('un set completo y correcto no tiene problemas', () => {
    const problemas = verificarRespuestas(test, [
      { questionId: 'q1', optionId: 'a' },
      { questionId: 'q2', optionId: 'b' },
      { questionId: 'q3', optionId: 'c' },
    ])
    expect(problemas).toEqual([])
  })

  it('detecta la pregunta sin contestar', () => {
    const problemas = verificarRespuestas(test, [
      { questionId: 'q1', optionId: 'a' },
      { questionId: 'q2', optionId: 'b' },
    ])
    expect(problemas).toEqual([
      { tipo: 'sin_contestar', questionId: 'q3', detalle: expect.any(String) },
    ])
  })

  it('detecta la pregunta contestada dos veces', () => {
    // ESTE es el caso que la base no puede ver. `@@unique([resultId, optionId])`
    // solo impide repetir la MISMA opcion; dos opciones distintas de la misma
    // pregunta pasan el unico y producen un score que no representa a nadie.
    const problemas = verificarRespuestas(test, [
      { questionId: 'q1', optionId: 'a' },
      { questionId: 'q1', optionId: 'z' },
      { questionId: 'q2', optionId: 'b' },
      { questionId: 'q3', optionId: 'c' },
    ])
    expect(problemas).toHaveLength(1)
    expect(problemas[0].tipo).toBe('repetida')
    expect(problemas[0].questionId).toBe('q1')
  })

  it('detecta una opcion de otro test', () => {
    // Una opcion de la v2 no es un valor raro del v1: es un id valido que el
    // cliente no deberia mandar. Sin esto, un POST manipulado puntuaria traits de
    // un test que la persona nunca vio.
    const problemas = verificarRespuestas(test, [
      { questionId: 'q1', optionId: 'a' },
      { questionId: 'q2', optionId: 'b' },
      { questionId: 'q3', optionId: 'c' },
      { questionId: 'q-de-otro-test', optionId: 'w' },
    ])
    expect(problemas.map((p) => p.tipo)).toContain('fuera_del_test')
  })

  it('detecta las dos cosas a la vez', () => {
    // Una pregunta contestada de mas Y otra sin contestar. La version anterior de
    // este test decia "las dos cosas" y mandaba dos respuestas para tres
    // preguntas: eso es un solo `sin_contestar`, y la asercion pedia dos. El test
    // estaba mal, no la funcion.
    const problemas = verificarRespuestas(test, [
      { questionId: 'q1', optionId: 'a' },
      { questionId: 'q1', optionId: 'z' },
      { questionId: 'q2', optionId: 'b' },
    ])
    expect(problemas.map((p) => p.tipo).sort()).toEqual(['repetida', 'sin_contestar'])
    expect(problemas.find((p) => p.tipo === 'sin_contestar')?.questionId).toBe('q3')
    expect(problemas.find((p) => p.tipo === 'repetida')?.questionId).toBe('q1')
  })

  it('cuestionario vacio y sin respuestas no es un problema', () => {
    expect(verificarRespuestas([], [])).toEqual([])
  })
})
