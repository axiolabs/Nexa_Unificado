import { cookies } from 'next/headers'
import type { NextResponse } from 'next/server'
import { getPrisma } from '@/lib/db'
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  verifySessionToken,
  type SessionPayload,
} from '@/lib/auth/token'

export { SESSION_COOKIE, createSessionToken, verifySessionToken } from '@/lib/auth/token'
export type { SessionPayload } from '@/lib/auth/token'

const baseCookie = {
  httpOnly: true,
  // 'lax' es la defensa CSRF de las mutaciones: el navegador no manda la
  // cookie en un POST cross-origin. 'strict' romperia la navegacion desde un
  // link de email, que es justo el flujo de "te invitaron a un plan".
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  path: '/',
} as const

export function attachSessionCookie(res: NextResponse, token: string): void {
  res.cookies.set(SESSION_COOKIE, token, { ...baseCookie, maxAge: SESSION_MAX_AGE_SECONDS })
}

export function clearSessionCookie(res: NextResponse): void {
  res.cookies.set(SESSION_COOKIE, '', { ...baseCookie, maxAge: 0 })
}

export async function getSession(): Promise<SessionPayload | null> {
  const store = await cookies()
  const token = store.get(SESSION_COOKIE)?.value
  if (!token) return null
  return verifySessionToken(token)
}

export type SessionUser = {
  id: string
  email: string
  name: string
  isActive: boolean
  suspendedAt: Date | null
  deletedAt: Date | null
  roles: string[]
}

export type RequireUserResult =
  | { ok: true; user: SessionUser }
  | { ok: false; status: 401 | 403; error: string }

/**
 * Verifica la cookie Y relee el usuario de la base.
 *
 * El reread es lo que hace que `isActive` / `suspendedAt` / `deletedAt` sirvan
 * de algo: con una cookie puramente stateless, un usuario suspendido o
 * borrado seguiria operando hasta que le expire el token, que son 30 dias.
 * Como el reread cuesta una consulta indexada por primary key, se paga en
 * todas las peticiones en vez de solo en las que importan: es el precio de no
 * tener tabla Session, y es barato.
 *
 * Para el control de ROL esta funcion no alcanza: devuelve los roles pero no
 * decide. La decision vive en `middleware.ts` y en `requireRole`, que comparten
 * la tabla de `lib/authz.ts` para no poder divergir entre si.
 */
export async function requireUser(): Promise<RequireUserResult> {
  const session = await getSession()
  if (!session) {
    return { ok: false, status: 401, error: 'No autenticado' }
  }

  const user = await getPrisma().user.findUnique({
    where: { id: session.uid },
    select: {
      id: true,
      email: true,
      name: true,
      isActive: true,
      suspendedAt: true,
      deletedAt: true,
      roles: { select: { role: true } },
    },
  })

  if (!user) {
    // Cookie valida pero el usuario no existe. Puede haber sido borrado.
    return { ok: false, status: 401, error: 'La cuenta ya no existe' }
  }
  if (!user.isActive) {
    return { ok: false, status: 403, error: 'La cuenta esta desactivada' }
  }
  if (user.suspendedAt) {
    return { ok: false, status: 403, error: 'La cuenta esta suspendida' }
  }
  if (user.deletedAt) {
    return { ok: false, status: 401, error: 'La cuenta ya no existe' }
  }

  return {
    ok: true,
    user: { ...user, roles: user.roles.map((r) => r.role) },
  }
}
