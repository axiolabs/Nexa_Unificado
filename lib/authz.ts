/**
 * Autorizacion por rol. Sin imports de Next ni de Prisma a proposito: este
 * modulo lo importan tanto `middleware.ts` (que corre en un runtime propio)
 * como los route handlers, y cualquier dependencia de Next lo haria
 * importable solo desde uno de los dos.
 *
 * La idea: el frontend refleja la misma filosofia que el modelo de datos. No
 * hay tablas separadas por rol, hay una `User` con `UserRoleAssignment`. Del
 * mismo modo no hay servicios separados por rol, hay un Next con route groups.
 * Agregar un rol es agregar una carpeta y una fila en ROUTE_ROLES.
 */

export const ROLE = {
  USER: 'USER',
  HOST: 'HOST',
  MODERATOR: 'MODERATOR',
  CURATOR: 'CURATOR',
  ADMIN: 'ADMIN',
} as const

export type Role = (typeof ROLE)[keyof typeof ROLE]

/**
 * Prefijo de URL -> roles que habilitan el acceso.
 *
 * El orden importa: se evalua de arriba abajo y gana la primera coincidencia.
 * Un prefijo mas especifico tiene que ir antes que uno general.
 *
 * ADMIN aparece como comodin en todos los grupos porque es un superusuario:
 * tiene que poder ver el panel de administracion para poder administrarlo.
 */
export const ROUTE_ROLES: readonly {
  prefix: string
  roles: readonly Role[]
  label: string
}[] = [
  // Orden: mas especifico primero. /admin antes que /admin-tools, etc.
  { prefix: '/admin', roles: ['ADMIN', 'MODERATOR'], label: 'administracion' },
  { prefix: '/curacion', roles: ['CURATOR', 'ADMIN'], label: 'curaduria' },
  { prefix: '/host', roles: ['HOST', 'ADMIN'], label: 'gestion de planes' },
]

/**
 * Prefijos que exigen sesion pero ningun rol en particular.
 *
 * `/planes` entra aca y no en `ROUTE_ROLES` a proposito. El detalle de un plan
 * lo puede ver **cualquier** usuario con sesion: mirar un plan, ver quien mas va
 * y pedir unirse no necesita ser `HOST`. Si estuviera en `ROUTE_ROLES` con
 * `['USER']`, el gate seria redundante (el registro asigna `USER` a todos) y
 * peor: cualquier rol nuevo habria que sumar a mano para no quedar afuera.
 *
 * El motivo de que exija sesion esta en el route handler, escrito alla: publicar
 * la hora, el lugar y la lista de participantes de un plan sin sesion arma una
 * agenda de la vida social de gente que no publico nada.
 */
export const AUTHENTICATED_PREFIXES: readonly string[] = [
  '/planes',
  // La pantalla del test de personalidad y el perfil con los rasgos. Sin sesion
  // no hay a quien mostrarle el test ni a quien pertenece el resultado, y por la
  // misma razon que `/planes`: publicar el puntaje de alguien es publicar dato
  // sobre como se maneja en un grupo. No es un dato que la persona publico.
  '/personalidad',
  '/perfil',
]

export type RouteRule = (typeof ROUTE_ROLES)[number]

/** Devuelve la regla que aplica a una ruta, o null si es publica. */
export function matchRouteRule(pathname: string): RouteRule | null {
  for (const rule of ROUTE_ROLES) {
    if (pathname === rule.prefix || pathname.startsWith(rule.prefix + '/')) {
      return rule
    }
  }
  return null
}

export function requiresAuth(pathname: string): boolean {
  if (matchRouteRule(pathname)) return true
  return AUTHENTICATED_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(p + '/'),
  )
}

export function hasAnyRole(userRoles: readonly string[], required: readonly Role[]): boolean {
  return required.some((r) => userRoles.includes(r))
}
