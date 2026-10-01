import { RoleShell } from '@/components/RoleShell'
import { ROLE } from '@/lib/authz'
import { PlanForm } from './plan-form'

/**
 * Crear plan.
 *
 * Vive bajo `/host`, asi que la hereda la proteccion por prefijo de
 * `middleware.ts`: no se renderiza sin rol HOST o ADMIN, ni escribiendo la URL a
 * mano. El `POST /api/plans` vuelve a verificar el rol de todos modos, porque el
 * middleware protege paginas y no puede ser la unica barrera de una API.
 *
 * El listado de "mis planes" todavia no existe, asi que el unico lugar desde
 * donde se llega aca es el placeholder de `/host`. Se enlaza desde ahi cuando
 * exista la lista; por ahora la ruta es alcanzable y esta, que es lo que pedia
 * el trabajo.
 */
export default function NewPlanPage() {
  return (
    <RoleShell
      title="Crear plan"
      description="Elegi el lugar, contame que es y cuando. Vos quedas confirmado desde el arranque."
      required={[ROLE.HOST, ROLE.ADMIN]}
    >
      <PlanForm />
    </RoleShell>
  )
}
