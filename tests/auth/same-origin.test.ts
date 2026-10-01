import { afterEach, describe, expect, it } from 'vitest'
import { assertSameOrigin } from '../../lib/http'

/**
 * `assertSameOrigin` decide si una mutacion es del mismo origen que la app.
 *
 * El caso que importa y que no se puede probar por HTTP es el de los Preview
 * deployments: cada uno tiene su propio dominio, y el `Origin` que llega es
 * distinto del que tendria `APP_ORIGIN` en Production. Sin un fallback, "cada
 * push te da un preview para probar" no es cierto: el preview carga pero toda
 * mutacion devuelve 403, que es la forma mas confusa de fallar (la pagina anda,
 * el boton no).
 *
 * Por eso se prueba la funcion directa y no a traves de `next start`: el
 * servidor de los tests corre con `APP_ORIGIN` fijo desde `vitest.config.mts`, y
 * no hay forma de que ese proceso vea un `VERCEL_ENV`/`VERCEL_URL` distintos
 * por caso.
 */

const PRODUCCION = 'https://nexa-unificado.vercel.app'
const PREVIEW_HOST = 'nexa-unificado-abc123def-stivliives-projects.vercel.app'

const CLAVES = ['APP_ORIGIN', 'VERCEL_ENV', 'VERCEL_URL', 'NODE_ENV'] as const
const guardado = new Map<string, string | undefined>(
  CLAVES.map((k) => [k, process.env[k]]),
)

function setEnv(...pares: Array<[string, string | undefined]>) {
  for (const [clave, valor] of pares) {
    if (valor === undefined) delete process.env[clave]
    else process.env[clave] = valor
  }
}

function mutacion(origin?: string) {
  return new Request(`${PRODUCCION}/api/auth/login`, {
    method: 'POST',
    headers: origin ? { origin } : {},
  })
}

afterEach(() => {
  for (const [clave, valor] of guardado) {
    if (valor === undefined) delete process.env[clave]
    else process.env[clave] = valor
  }
})

describe('assertSameOrigin', () => {
  it('acepta el Origin que coincide con APP_ORIGIN', () => {
    setEnv(['APP_ORIGIN', PRODUCCION], ['VERCEL_ENV', undefined], ['VERCEL_URL', undefined])
    expect(assertSameOrigin(mutacion(PRODUCCION))).toBeNull()
  })

  it('rechaza con 403 un Origin distinto del declarado', async () => {
    setEnv(['APP_ORIGIN', PRODUCCION], ['VERCEL_ENV', undefined], ['VERCEL_URL', undefined])
    const res = assertSameOrigin(mutacion('https://otro.example'))
    expect(res?.status).toBe(403)
    await expect(res?.json()).resolves.toEqual({ error: 'Origen no permitido' })
  })

  it('rechaza con 403 si falta el header Origin', async () => {
    setEnv(['APP_ORIGIN', PRODUCCION], ['VERCEL_ENV', undefined], ['VERCEL_URL', undefined])
    const res = assertSameOrigin(mutacion())
    expect(res?.status).toBe(403)
    await expect(res?.json()).resolves.toEqual({ error: 'Falta el header Origin' })
  })

  it('en Preview acepta el dominio del deployment cuando no hay APP_ORIGIN', () => {
    setEnv(
      ['APP_ORIGIN', undefined],
      ['VERCEL_ENV', 'preview'],
      ['VERCEL_URL', PREVIEW_HOST],
    )
    expect(assertSameOrigin(mutacion(`https://${PREVIEW_HOST}`))).toBeNull()
  })

  it('en Preview no acepta un Origin que no sea el del deployment', async () => {
    setEnv(
      ['APP_ORIGIN', undefined],
      ['VERCEL_ENV', 'preview'],
      ['VERCEL_URL', PREVIEW_HOST],
    )
    const res = assertSameOrigin(mutacion(PRODUCCION))
    expect(res?.status).toBe(403)
    await expect(res?.json()).resolves.toEqual({ error: 'Origen no permitido' })
  })

  it('en Preview sigue exigiendo el header Origin', async () => {
    setEnv(
      ['APP_ORIGIN', undefined],
      ['VERCEL_ENV', 'preview'],
      ['VERCEL_URL', PREVIEW_HOST],
    )
    const res = assertSameOrigin(mutacion())
    expect(res?.status).toBe(403)
    await expect(res?.json()).resolves.toEqual({ error: 'Falta el header Origin' })
  })

  it('en Production sin APP_ORIGIN falla cerrado con 500, aunque exista VERCEL_URL', async () => {
    // Este es el test que evita el agujero: `VERCEL_ENV` vale `production` en
    // los deploys reales, asi que sin el filtro un `APP_ORIGIN` olvidado
    // pasaria a compararse contra el dominio del deployment en vez de romper.
    setEnv(
      ['APP_ORIGIN', undefined],
      ['VERCEL_ENV', 'production'],
      ['VERCEL_URL', PREVIEW_HOST],
      ['NODE_ENV', 'production'],
    )
    const res = assertSameOrigin(mutacion(`https://${PREVIEW_HOST}`))
    expect(res?.status).toBe(500)
    await expect(res?.json()).resolves.toEqual({ error: 'APP_ORIGIN no esta definido' })
  })

  it('sin APP_ORIGIN ni VERCEL_URL, en dev no rompe', () => {
    setEnv(
      ['APP_ORIGIN', undefined],
      ['VERCEL_ENV', undefined],
      ['VERCEL_URL', undefined],
      ['NODE_ENV', 'development'],
    )
    expect(assertSameOrigin(mutacion('http://localhost:3000'))).toBeNull()
  })
})