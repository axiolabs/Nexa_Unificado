import { RoleShell } from '@/components/RoleShell'
import { ROLE } from '@/lib/authz'

export default function CurationPage() {
  return (
    <RoleShell
      title="Curaduria"
      description="Placeholder. Verificar lugares y mantener la taxonomia de traits."
      required={[ROLE.CURATOR, ROLE.ADMIN]}
    >
      <p className="msg ok">
        Llegaste aca, asi que el middleware confirmo que tu cuenta tiene rol
        CURATOR o ADMIN en UserRoleAssignment.
      </p>
    </RoleShell>
  )
}
