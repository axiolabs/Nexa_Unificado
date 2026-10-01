import { RoleShell } from '@/components/RoleShell'
import { ROLE } from '@/lib/authz'

export default function AdminPage() {
  return (
    <RoleShell
      title="Administracion"
      description="Placeholder. Moderacion de reportes y gestion de cuentas."
      required={[ROLE.ADMIN, ROLE.MODERATOR]}
    >
      <p className="msg ok">
        Llegaste aca, asi que el middleware confirmo que tu cuenta tiene rol
        ADMIN o MODERATOR en UserRoleAssignment.
      </p>
    </RoleShell>
  )
}
