import { hasAnyRole, type Role } from '@/lib/authz'
import { getSession, requireUser, type SessionUser } from '@/lib/auth/session'
import { getPrisma } from '@/lib/db'

/**
 * Quién está mirando, para un endpoint que es público pero cuyo contenido
 * depende de quién seas.
 *
 * El caso concreto: `/api/places` es público, pero un curador además ve los
 * lugares `PENDING`. Sin sesion devuelve `null` y el endpoint sigue
 * funcionando: nunca devuelve 401.
 *
 * Un token invalido tambien da `null`, y no 401. La diferencia es deliberada:
 * en un endpoint público, que la cookie este vencida no es motivo para
 * responder "no autenticado" al visitante, es motivo para tratarlo como
 * visitante.
 *
 * A diferencia de `requireUser`, NO relee el estado de la cuenta
 * (`isActive`, `suspendedAt`, `deletedAt`). No hace falta: acá no hay nada
 * autorizado que hacer, solo se amplían los datos que se muestran. Quien solo
 * puede ver más lugares pero no tocar nada, no necesita estar activo.
 */
export async function getViewer(): Promise<{ userId: string; roles: string[] } | null> {
  const session = await getSession()
  if (!session) return null
  const user = await getPrisma().user.findUnique({
    where: { id: session.uid },
    select: { roles: { select: { role: true } } },
  })
  if (!user) return null
  return { userId: session.uid, roles: user.roles.map((r) => r.role) }
}

/** Atajo: ¿este visor puede ver lugares sin revisar? */
export function isCurator(roles: readonly string[] | undefined): boolean {
  return hasAnyRole(roles ?? [], ['CURATOR', 'ADMIN'])
}

/**
 * Autorizacion para route handlers de API.
 *
 * Deliberadamente separada de `middleware.ts`. El matcher de middleware excluye
 * `/api` a proposito: que la autorizacion de una API dependa de que el matcher
 * siga cubriendo la ruta es fragile (un path mal escrito se cuela, y no hay
 * test que lo detecte). En cambio cada handler declara que rol necesita, que es
 * explicito y local a la ruta que protege.
 *
 * Ambos caminos leen la MISMA tabla de `lib/authz.ts`, asi que no pueden
 * divergir en que rol habilita que.
 */
export type RequireRoleResult =
  | { ok: true; user: SessionUser }
  | { ok: false; status: 401 | 403; error: string }

export async function requireRole(required: readonly Role[]): Promise<RequireRoleResult> {
  const base = await requireUser()
  if (!base.ok) return base

  if (!hasAnyRole(base.user.roles, required)) {
    return {
      ok: false,
      status: 403,
      error: `Se requiere rol: ${required.join(' o ')}`,
    }
  }
  return base
}
