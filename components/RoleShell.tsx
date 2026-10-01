import { headers } from 'next/headers'
import Link from 'next/link'
import type { Role } from '@/lib/authz'

/**
 * Shell comun de los route groups por rol.
 *
 * Esto NO es el control de acceso. El control vive en `middleware.ts`, que
 * corre antes y ya rechazo a quien no tiene el rol. Este componente solo
 * muestra informacion y da el cromo comun.
 *
 * Los roles llegan por el header `x-nexa-roles` que escribe el middleware. Se
 * leen aca para no repetir la consulta a `UserRoleAssignment` en cada pagina.
 * Es una lectura de HIELO, con la misma guia de Confianza Cero que las cookies
 * firmadas: si el header llega forjado, el middleware ya lo sobreescribio o
 * ya rechazo el request. Aun asi, no se usa para autorizar nada.
 */
export async function RoleShell({
  title,
  description,
  required,
  children,
}: {
  title: string
  description: string
  required: readonly Role[]
  children: React.ReactNode
}) {
  const h = await headers()
  const roles = (h.get('x-nexa-roles') ?? '').split(',').filter(Boolean)

  return (
    <div>
      <div className="shellbar">
        <span className="shellbar-title">{title}</span>
        <span className="shellbar-roles">
          tus roles: {roles.length ? roles.join(', ') : 'ninguno'}
        </span>
        <Link href="/" className="shellbar-link">
          ir al inicio
        </Link>
      </div>
      <h1>{title}</h1>
      <p className="lede">{description}</p>
      <p className="note">
        Accede con rol: <code>{required.join(' | ')}</code>. La verificacion ocurre
        en el servidor, en <code>middleware.ts</code>, contra{' '}
        <code>UserRoleAssignment</code>. Esta pagina no se llega a renderizar sin el
        rol, tampoco si se escribe la URL a mano.
      </p>
      {children}
    </div>
  )
}
