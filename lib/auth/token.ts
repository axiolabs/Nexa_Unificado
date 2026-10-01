import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Primitivas de la sesion, sin NINGUN import de Next.
 *
 * Existe separado de `session.ts` a proposito: `middleware.ts` corre en su
 * propio runtime y no debe arrastrar `next/headers` ni `next/server`. Este
 * modulo solo usa `node:crypto`, que es lo unico que necesitan los dos lados.
 *
 * Formato: <base64url(payload JSON)>.<base64url(HMAC-SHA256)>
 * Payload: { uid, ver, iat, exp }
 *
 * Es esencialmente un JWT escrito a mano en ~40 lineas en lugar de una
 * libreria. Motivo: el algoritmo queda fijo y auditable. No hay campo `alg`
 * que un atacante pueda mutar a "none" ni confusion de algoritmos, que es el
 * historial real de vulnerabilidades en implementaciones de JWT. Cuando exista
 * un segundo servicio que deba validar estos tokens, ahi si conviene migrar a
 * una libreria con soporte de `kid` y rotacion de claves.
 *
 * LIMITACION CONOCIDA: al no existir tabla `Session`, no se puede revocar una
 * sesion individual. Se mitiga con dos palancas globales:
 *   1. `ver` contra SESSION_VERSION -> subir el entero invalida todas.
 *   2. Rotar SESSION_SECRET -> invalida todas.
 * Ninguna de las dos es "cerrar sesion solo en este dispositivo". Cuando se
 * necesite, ahi va la tabla Session. Ver docs/decisiones-auth.md.
 */

export const SESSION_COOKIE = 'nexa_session'

export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30

export type SessionPayload = {
  uid: string
  ver: number
  iat: number
  exp: number
}

function getSecret(): Buffer {
  const s = process.env.SESSION_SECRET
  if (!s) throw new Error('SESSION_SECRET no esta definido')
  if (s.length < 32) throw new Error('SESSION_SECRET es demasiado corto (minimo 32 caracteres)')
  return Buffer.from(s, 'utf8')
}

function currentVersion(): number {
  const v = Number(process.env.SESSION_VERSION ?? '1')
  if (!Number.isInteger(v) || v < 1) throw new Error('SESSION_VERSION debe ser un entero >= 1')
  return v
}

function sign(payloadB64: string): string {
  return createHmac('sha256', getSecret()).update(payloadB64).digest('base64url')
}

export function createSessionToken(userId: string, now: number = Date.now()): string {
  const iat = Math.floor(now / 1000)
  const payload: SessionPayload = {
    uid: userId,
    ver: currentVersion(),
    iat,
    exp: iat + SESSION_MAX_AGE_SECONDS,
  }
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  return `${body}.${sign(body)}`
}

export function verifySessionToken(token: string, now: number = Date.now()): SessionPayload | null {
  const dot = token.lastIndexOf('.')
  if (dot <= 0) return null

  const body = token.slice(0, dot)
  const mac = token.slice(dot + 1)

  // timingSafeEqual exige buffers del mismo largo, y comparar el largo con ==
  // filtraria justamente eso. Se chequea largo antes, y el contenido con la
  // funcion de tiempo constante.
  const given = Buffer.from(mac, 'utf8')
  const expected = Buffer.from(sign(body), 'utf8')
  if (given.length !== expected.length) return null
  if (!timingSafeEqual(given, expected)) return null

  let payload: SessionPayload
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SessionPayload
  } catch {
    return null
  }

  if (typeof payload.uid !== 'string' || payload.uid.length === 0) return null
  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) return null
  if (payload.exp * 1000 <= now) return null
  if (payload.ver !== currentVersion()) return null

  return payload
}
