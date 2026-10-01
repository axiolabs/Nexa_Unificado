import { NextResponse, type NextRequest } from 'next/server'
import { getPrisma } from '@/lib/db'
import { hasAnyRole, matchRouteRule, requiresAuth } from '@/lib/authz'
import { SESSION_COOKIE, verifySessionToken } from '@/lib/auth/token'

/**
 * Prisma 7 exige `runtime = 'nodejs'` para poder usar Prisma Client aqui.
 * Sin esta linea el middleware corre en el runtime Edge, que no tiene
 * `node:crypto` completo ni conexiones TCP, y falla al importar el cliente.
 * Esta es la razon por la que el control de rol NO puede ser una simple
 * verificacion de firma: leer `UserRoleAssignment` requiere un driver real.
 */
export const runtime = 'nodejs'

/**
 * La autorizacion de rol se resuelve SIEMPRE en el servidor, contra la base.
 *
 * Ocultar un boton en el cliente no es control de acceso: cualquiera puede
 * hacer `fetch('/admin')` desde la consola, o abrir la URL directamente. Este
 * middleware corre antes de que se resuelva cualquier pagina o route handler,
 * asi que un usuario sin el rol recibe 403 aunque el enlace no exista en la UI.
 *
 * Lo que si hace el cliente es no mostrar lo que no corresponde, por UX. Es
 * cortesia, no seguridad.
 */
export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl

  const rule = matchRouteRule(pathname)
  if (!rule && !requiresAuth(pathname)) {
    return NextResponse.next()
  }

  // 1. Firma de la cookie. Es barato y descarta ataques de sesion forjada
  //    antes de gastar una consulta.
  const token = req.cookies.get(SESSION_COOKIE)?.value
  const session = token ? verifySessionToken(token) : null
  if (!session) {
    return deny(req, 401, 'Necesitas iniciar sesion para entrar a ' + (rule?.label ?? 'esta pagina'))
  }

  // 2. Estado de la cuenta, desde la base. Una cookie valida no alcanza:
  //    el usuario pudo ser suspendido, desactivado o borrado.
  const user = await getPrisma().user.findUnique({
    where: { id: session.uid },
    select: {
      isActive: true,
      suspendedAt: true,
      deletedAt: true,
      roles: { select: { role: true } },
    },
  })

  if (!user || user.deletedAt) {
    return deny(req, 401, 'La cuenta ya no existe')
  }
  if (!user.isActive) {
    return deny(req, 403, 'La cuenta esta desactivada')
  }
  if (user.suspendedAt) {
    return deny(req, 403, 'La cuenta esta suspendida')
  }

  // 3. El rol, desde UserRoleAssignment. Esta es la unica fuente de verdad.
  const roles = user.roles.map((r) => r.role)
  if (rule && !hasAnyRole(roles, rule.roles)) {
    return deny(req, 403, `Necesitas rol ${rule.roles.join(' o ')} para entrar a ${rule.label}`)
  }

  // Se bajan los roles resueltos por header para que los server components no
  // vuelvan a consultarlos. Es una optimizacion, no la fuente de verdad: si
  // alguien forja el header desde el cliente no tiene efecto, porque el
  // middleware corre antes y lo sobreescribe.
  const headers = new Headers(req.headers)
  headers.set('x-nexa-user-id', session.uid)
  headers.set('x-nexa-roles', roles.join(','))

  return NextResponse.next({ request: { headers } })
}

function deny(req: NextRequest, status: 401 | 403, message: string) {
  // Las mutaciones de API reciben JSON; la navegacion recibe una pagina.
  if (req.nextUrl.pathname.startsWith('/api/')) {
    return NextResponse.json({ error: message }, { status })
  }
  return new NextResponse(message, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  })
}

export const config = {
  matcher: [
    /*
     * Solo paginas. Las rutas de API NO pasan por aca a proposito: cada route
     * handler se autoriza a si mismo con `requireUser` / `requireRole`, que es
     * mas dificil de olvidar que depender de que el matcher de middleware
     * siga cubriendo la ruta. Middleware es la primera barrera, no la unica.
     *
     * Se excluyen los assets estaticos y las rutas internas de Next.
     */
    '/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|map)$).*)',
  ],
}
