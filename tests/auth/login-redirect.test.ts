import { describe, expect, it } from 'vitest'
import { destinoPostLogin } from '../../lib/login-redirect'
import type { TestStatus } from '../../lib/personality-reminder'

/**
 * Donde cae la persona despues de entrar.
 *
 * La funcion es minuscula, pero decide a que pantalla abre la app, asi que lo
 * que se testea es sobre todo la FRONTERA: que no opine cuando no sabe, y que
 * no mande a `/personalidad` cuando no hay test que hacer.
 */

const base: TestStatus = {
  hayTest: true,
  hayResultado: false,
  version: 1,
  resultadoVersion: null,
}

describe('destinoPostLogin', () => {
  it('sin test hecho va a /personalidad', () => {
    expect(destinoPostLogin(base)).toBe('/personalidad')
  })

  it('con test hecho va al mapa', () => {
    expect(destinoPostLogin({ ...base, hayResultado: true, resultadoVersion: 1 })).toBe('/explore')
  })

  it('no opina si no sabe: null, no un default disfrazado', () => {
    // `null` aca es "no se". El mapa es el default de todos modos, asi que el
    // peor caso es el mismo lado, pero el `null` le deja al llamador
    // distinguir "no se" de "si, mandalo a /personalidad" y no escribir una
    // regla de tres ramas donde dos dan lo mismo.
    expect(destinoPostLogin(null)).toBeNull()
  })

  it('sin test activo NO manda a /personalidad, aunque no haya resultado', () => {
    // Sin test activo `/personalidad` abre una pantalla que va a decir que no
    // hay test. Mandar ahi es peor que mandar al mapa: parece un error de la app.
    expect(destinoPostLogin({ ...base, hayTest: false })).toBe('/explore')
    expect(destinoPostLogin({ hayTest: false, hayResultado: false, version: null })).toBe('/explore')
  })

  it('un resultado de una version vieja NO cambia el destino', () => {
    // Este es el caso que `tocaRecordar` maneja y esta funcion NO. El
    // recordatorio tiene que avisar que hay una v2, asi que ahi `true` es lo
    // correcto. Una redireccion no: alguien que hizo el test hace seis meses y
    // entra al mapa todos los dias de golpe aterriza en `/personalidad` sin
    // contexto, una vez por cada publicacion de version.
    const viejo: TestStatus = { hayTest: true, hayResultado: true, version: 2, resultadoVersion: 1 }
    expect(destinoPostLogin(viejo)).toBe('/explore')

    // Y el recordatorio, en cambio, si avisa. Los dos pueden coexistir.
    expect(viejo.hayResultado && viejo.resultadoVersion !== viejo.version).toBe(true)
  })

  it('resultado sin version conocida no se interpreta como version nueva', () => {
    // `resultadoVersion` es opcional. Con `hayResultado: true` pero sin version,
    // la pregunta que importa para el destino es "lo hizo o no", y la respuesta
    // ya esta: lo hizo.
    expect(destinoPostLogin({ ...base, hayResultado: true })).toBe('/explore')
  })

  it('el destino siempre es una de las dos pantallas conocidas', () => {
    // Trampa para el futuro: agregar un tercer destino sin decidir como se
    // combina con `null`.
    const casos: (TestStatus | null)[] = [
      null,
      { ...base },
      { ...base, hayResultado: true },
      { ...base, hayTest: false },
      { hayTest: true, hayResultado: true, version: 1, resultadoVersion: 1 },
    ]
    for (const c of casos) {
      const d = destinoPostLogin(c)
      expect(d === null || d === '/explore' || d === '/personalidad').toBe(true)
    }
  })
})
