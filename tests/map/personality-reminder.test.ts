import { describe, expect, it } from 'vitest'
import {
  mensajeRecordatorio,
  textoEnlaceRecordatorio,
  tocaRecordar,
  type TestStatus,
} from '../../lib/personality-reminder'

/**
 * La regla del recordatorio, que antes vivia dentro de `explore-client.tsx`.
 *
 * El test que hacia falta era este: la funcion estaba en el componente, y
 * `explore-page.test.ts` solo puede afirmar por HTTP que el mapa renderiza, nunca
 * que el banner aparece o no. Moviendola a `lib/` se pudo probar de verdad.
 */

const base: TestStatus = {
  hayTest: true,
  hayResultado: false,
  version: 1,
  resultadoVersion: null,
}

describe('tocaRecordar', () => {
  it('sin estado todavia no recuerda', () => {
    // El fetch del mapa todavia no volvio. Recordar con `null` haria aparecer y
    // desaparecer el banner en cada carga.
    expect(tocaRecordar(null, false)).toBe(false)
  })

  it('sin test activo no recuerda, aunque no haya resultado', () => {
    // La condicion que apaga todo lo demas. Sin test publicado, insistir en
    // ofrecer uno es peor que no recordar.
    expect(tocaRecordar({ ...base, hayTest: false }, false)).toBe(false)
  })

  it('hay test y no hay resultado: recuerda', () => {
    expect(tocaRecordar(base, false)).toBe(true)
  })

  it('el recordatorio ya esta completo: no recuerda', () => {
    const hecho: TestStatus = { ...base, hayResultado: true, resultadoVersion: 1 }
    expect(tocaRecordar(hecho, false)).toBe(false)
  })

  it('el resultado es de una version vieja: recuerda la nueva', () => {
    // El caso que con un condicional de `hayResultado` desaparece solo al
    // publicar una v2.
    const viejo: TestStatus = { hayTest: true, hayResultado: true, version: 2, resultadoVersion: 1 }
    expect(tocaRecordar(viejo, false)).toBe(true)
  })

  it('cerrado con la X, no vuelve a aparecer', () => {
    // El recordatorio tiene que ser silenciable. Uno que vuelve en cada visita se
    // vuelve ruido a la tercera, y el ruido enseña a ignorar el banner entero.
    expect(tocaRecordar(base, true)).toBe(false)
  })

  it('sin version de resultado no inventa un recordatorio de "nueva version"', () => {
    // `hayResultado: true` sin `resultadoVersion` no se puede comparar. Tratarlo
    // como version distinta mostraria "hay una version nueva" a alguien que no
    // tiene de que enterarse.
    const raro: TestStatus = { hayTest: true, hayResultado: true, version: 1 }
    expect(tocaRecordar(raro, false)).toBe(false)
  })
})

describe('los textos del recordatorio', () => {
  it('son distintos segun el caso, y ninguno de los dos se usa para el otro', () => {
    const sinHacer = base
    const conNueva: TestStatus = {
      hayTest: true,
      hayResultado: true,
      version: 2,
      resultadoVersion: 1,
    }
    expect(mensajeRecordatorio(sinHacer)).toBe(
      'Hace el test de personalidad: son ocho preguntas y podes saltearlas.',
    )
    expect(mensajeRecordatorio(conNueva)).toBe('Hay una version nueva del test de personalidad.')
    expect(textoEnlaceRecordatorio(sinHacer)).toBe('Hacer el test')
    expect(textoEnlaceRecordatorio(conNueva)).toBe('Ver la nueva')
  })

  it('el mensaje de invitar dice que se puede saltear', () => {
    // El test es saltable y el recordatorio no puede prometer lo contrario. Un
    // "tenes que hacer el test" contradice la decision de producto y hace que la
    // pantalla se sienta como una trampa.
    expect(mensajeRecordatorio(base)).toContain('podes saltearlas')
  })
})
