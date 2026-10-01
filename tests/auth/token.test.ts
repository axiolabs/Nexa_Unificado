import { describe, expect, it } from 'vitest'
import { createSessionToken, verifySessionToken } from '../../lib/auth/token'

/**
 * Tests de la primitiva de sesion. No levantan server: son funciones puras.
 *
 * El escenario que importa es el del versionado. `SESSION_VERSION` es la
 * palanca para "desloguear a todo el mundo" sin rotar el secreto, y es
 * justamente el tipo de mecanismo que se rompe en silencio: si el chequeo
 * disappears, sigue todo andando y un logout de emergencia no hace nada.
 */

const SECRET_MIN = 32

describe('createSessionToken / verifySessionToken', () => {
  it('firma y verifica un token recien creado', () => {
    const token = createSessionToken('user-123')
    const payload = verifySessionToken(token)
    expect(payload).not.toBeNull()
    expect(payload!.uid).toBe('user-123')
  })

  it('rechaza un token sin firma', () => {
    const payload = Buffer.from(JSON.stringify({ uid: 'u', ver: 1, iat: 0, exp: 9e9 })).toString(
      'base64url',
    )
    expect(verifySessionToken(payload)).toBeNull()
    expect(verifySessionToken(payload + '.')).toBeNull()
  })

  it('rechaza una firma de largo distinto', () => {
    const token = createSessionToken('user-123')
    const [body, sig] = token.split('.')
    expect(verifySessionToken(`${body}.${sig}x`)).toBeNull()
    expect(verifySessionToken(`${body}.`)).toBeNull()
  })

  it('rechaza un payload manipulado conservando la firma original', () => {
    const token = createSessionToken('user-original')
    const [, sig] = token.split('.')
    const forged = Buffer.from(
      JSON.stringify({ uid: 'user-victima', ver: 1, iat: 0, exp: 9e9 }),
    ).toString('base64url')
    expect(verifySessionToken(`${forged}.${sig}`)).toBeNull()
  })

  it('rechaza un token expirado', () => {
    const haceMucho = Date.now() - 60 * 24 * 60 * 60 * 1000
    const token = createSessionToken('user-123', haceMucho)
    // Se crea con el timestamp viejo pero se valida "ahora".
    expect(verifySessionToken(token, Date.now() - 31 * 24 * 60 * 60 * 1000)).not.toBeNull()
    expect(verifySessionToken(token, Date.now())).toBeNull()
  })

  it('SESSION_VERSION invalida todos los tokens al subirlo', () => {
    const original = process.env.SESSION_VERSION
    try {
      process.env.SESSION_VERSION = '1'
      const viejo = createSessionToken('user-123')
      expect(verifySessionToken(viejo)).not.toBeNull()

      process.env.SESSION_VERSION = '2'
      expect(verifySessionToken(viejo), 'el token de v1 no deberia valer en v2').toBeNull()
      // Y uno nuevo con v2 si vale.
      expect(verifySessionToken(createSessionToken('user-123'))).not.toBeNull()
    } finally {
      process.env.SESSION_VERSION = original
    }
  })

  it('rotar SESSION_SECRET invalida todos los tokens', () => {
    const original = process.env.SESSION_SECRET
    try {
      process.env.SESSION_SECRET = 'a'.repeat(SECRET_MIN)
      const token = createSessionToken('user-123')
      expect(verifySessionToken(token)).not.toBeNull()

      process.env.SESSION_SECRET = 'b'.repeat(SECRET_MIN)
      expect(verifySessionToken(token)).toBeNull()
    } finally {
      process.env.SESSION_SECRET = original
    }
  })

  it('se niega a arrancar con un SESSION_SECRET debil', () => {
    const original = process.env.SESSION_SECRET
    try {
      process.env.SESSION_SECRET = 'corto'
      expect(() => createSessionToken('user-123')).toThrow(/SESSION_SECRET/)
    } finally {
      process.env.SESSION_SECRET = original
    }
  })
})
