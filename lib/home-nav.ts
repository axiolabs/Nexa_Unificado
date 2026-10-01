/**
 * Los botones de la pantalla de sesion iniciada.
 *
 * La lista vive aca y no en el componente por la misma razon que el resto de las
 * decisiones de este proyecto: lo que se puede decidir sin DOM se decide en
 * `lib/` y se testea. Ademas asi la pantalla de inicio no puede ofrecer un
 * boton que el middleware va a rebotar.
 *
 * El filtro de rol NO tiene una lista propia. Reusa `ROUTE_ROLES` de
 * `lib/authz.ts`, que es la unica fuente de verdad sobre quien entra a cada
 * prefijo. Escribir una segunda lista de "estas rutas son para hosts" aca
 * duplicaria la tabla y las dos se desincronizan en silencio: el boton sigue
 * apareciendo y el middleware sigue rebotando, que es la peor forma de fallar
 * porque parece un problema de permisos en vez de de un boton mal puesto.
 */

import { hasAnyRole, matchRouteRule, type Role } from './authz'

export type EnlaceSesion = {
  href: string
  label: string
  /** Una linea, en voz baja. Que es y para que sirve ese boton. */
  hint: string
}

/**
 * Orden a proposito, y no alfabetico.
 *
 * El mapa primero porque es la pantalla principal del producto. Depois el test,
 * porque es lo que hace que el mapa le muestre cosas parecidas a las tuyas. Despues
 * lo tuyo, que es donde se mira lo que ya te paso. Y las herramientas de rol al
 * final, separadas, porque son para gente del equipo y no para quien entra a ver
 * un plan.
 */
const ENLACES: readonly EnlaceSesion[] = [
  {
    href: '/explore',
    label: 'Ver el mapa',
    hint: 'Planes abiertos cerca de vos.',
  },
  {
    href: '/personalidad',
    label: 'Test de personalidad',
    hint: 'Ocho preguntas, y podes saltearlas.',
  },
  {
    href: '/perfil',
    label: 'Mi perfil',
    hint: 'Tu resultado y los lugares que te quedan bien.',
  },
  {
    href: '/planes',
    label: 'Mis planes',
    hint: 'Los que creaste y los que tequearon.',
  },
]

/**
 * Los enlaces que la persona puede usar con su sesion y sus roles.
 *
 * Un enlace se muestra si la ruta no pide un rol que la persona no tenga. No se
 * esconde nada por ser una pantalla "de la app": si sos curador, `/curacion` te
 * sirve y tiene que ser alcanzable. Lo que no puede pasar es lo contrario: que
 * aparezca un boton que lleva a una pantalla que te va a expulsar.
 */
export function enlacesSesion(roles: readonly string[] | undefined): EnlaceSesion[] {
  const r: readonly string[] = roles ?? []
  const visibles = ENLACES.filter((e) => {
    const rule = matchRouteRule(e.href)
    return !rule || hasAnyRole(r, rule.roles as readonly Role[])
  })

  return visibles
}

/**
 * Las herramientas internas, si la persona las tiene.
 *
 * Van aparte porque no son parte de "usar Nexa": son la tarea de un rol. Se
 * derivan de `ROUTE_ROLES` en vez de tenerlas escritas aca, asi que el dia que
 * `/admin` y `/curacion` se unan en una sola pantalla, esta funcion deja de
 * ofrecer dos botones y ofrece uno sin que nadie toque este archivo.
 */
export function herramientasSesion(roles: readonly string[] | undefined): EnlaceSesion[] {
  const r: readonly string[] = roles ?? []
  const HERRAMIENTAS: Record<string, EnlaceSesion> = {
    '/host': { href: '/host', label: 'Organizar un plan', hint: 'Crear planes y ver quien se sumo.' },
    '/curacion': { href: '/curacion', label: 'Curaduria', hint: 'Revisar lugares.' },
    '/admin': { href: '/admin', label: 'Administracion', hint: 'Moderacion y cuentas.' },
  }

  return Object.values(HERRAMIENTAS).filter((e) => {
    const rule = matchRouteRule(e.href)
    return rule ? hasAnyRole(r, rule.roles as readonly Role[]) : false
  })
}
