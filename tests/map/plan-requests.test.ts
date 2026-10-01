import { describe, expect, it } from 'vitest'
import { describirAlineacion, describirReliability } from '../../lib/plan-requests'

/**
 * El texto de la pantalla de solicitudes.
 *
 * Estas funciones existen para que la distincion entre "no hay dato" y "el dato
 * dio cero" no dependa de que el que programa el JSX se acuerde. La seccion
 * primera es la importante: si alguien cambia un `null` por `0` o al reves, esto
 * se pone rojo antes de que un postulante sin test de personalidad sea rechazado
 * en pantalla con un "no encaja" que nadie midio.
 */

describe('describirAlineacion', () => {
  it('un null NO se muestra como porcentaje', () => {
    const texto = describirAlineacion(null)
    expect(texto).toBe('Sin comparar: no hay datos de los dos lados')
    // El punto del test: nada de numeros, nada de "%". Un 0% de relleno
    // rechazaria a alguien por un dato que nunca se midio.
    expect(texto).not.toContain('%')
  })

  it('un cero de verdad SI se muestra como 0%', () => {
    // El hermano del test de arriba. Si estos dos se mezclaran, la pantalla
    // perderia la diferencia entre "no encaja" y "no se sabe".
    expect(describirAlineacion({ score: 0, normalizado: 0, traits: 2 })).toBe(
      '0% sobre 2 rasgos del lugar',
    )
  })

  it('redondea el porcentaje sin inventar decimales', () => {
    expect(describirAlineacion({ score: 0, normalizado: 0.666, traits: 3 })).toBe(
      '67% sobre 3 rasgos del lugar',
    )
  })

  it('un normalizado de 1 se muestra como 100%', () => {
    expect(describirAlineacion({ score: 1, normalizado: 1, traits: 5 })).toBe(
      '100% sobre 5 rasgos del lugar',
    )
  })

  it('el desalineamiento se muestra negativo, no como numero sin signo', () => {
    // Si el signo se perdiera, "el rasgo va en contra" se leeria igual que
    // "le da lo mismo", que son decisiones opuestas para el organizador.
    expect(describirAlineacion({ score: -0.2, normalizado: -0.2, traits: 2 })).toBe(
      '-20% sobre 2 rasgos del lugar',
    )
  })

  it('un solo rasgo comparado se dice en singular', () => {
    expect(describirAlineacion({ score: 2, normalizado: 2, traits: 1 })).toBe(
      '200% sobre 1 rasgo del lugar',
    )
  })
})

describe('describirReliability', () => {
  it('sin historial no muestra 0%', () => {
    expect(describirReliability(null)).toBe('Sin historial')
  })

  it('un objeto con el historial vacio tampoco muestra 0%', () => {
    // El endpoint devuelve el objeto con attended 0 y noShow 0 en vez de null
    // cuando el postulante existe. Sin esta rama, esa persona apareceria con
    // "0% (0 de 0 asistio)".
    expect(describirReliability({ attended: 0, noShow: 0, showUpRate: null })).toBe('Sin historial')
  })

  it('con historial muestra el porcentaje y el conteo crudo', () => {
    // El conteo va junto porque "1 de 1" y "8 de 8" dan el mismo 100% y no
    // son la misma evidencia.
    expect(describirReliability({ attended: 2, noShow: 1, showUpRate: 2 / 3 })).toBe(
      '67% (2 de 3 asistio)',
    )
    expect(describirReliability({ attended: 1, noShow: 0, showUpRate: 1 })).toBe(
      '100% (1 de 1 asistio)',
    )
  })

  it('el que nunca asistio se muestra como 0% de asistencia', () => {
    // Acá el 0% es verdad: hay un plan pasado y no fue. Distinto de "sin
    // historial", que no muestra porcentaje.
    expect(describirReliability({ attended: 0, noShow: 1, showUpRate: 0 })).toBe(
      '0% (0 de 1 asistio)',
    )
  })
})
