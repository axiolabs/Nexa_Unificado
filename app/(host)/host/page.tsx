import Link from 'next/link'
import { RoleShell } from '@/components/RoleShell'
import { ROLE } from '@/lib/authz'

export default function HostPage() {
  return (
    <RoleShell
      title="Gestion de planes"
      description="Crear planes, revisar solicitudes, resolver reportes."
      required={[ROLE.HOST, ROLE.ADMIN]}
    >
      <p className="msg ok">
        Llegaste aca, asi que el middleware confirmo que tu cuenta tiene rol HOST
        o ADMIN en UserRoleAssignment.
      </p>
      <ul className="host-index">
        <li>
          <Link href="/host/requests">Revisar solicitudes de participacion</Link>
          <p className="note">
            Acepta o rechaza quien pide unirse a los planes que organizas, con la
            alineacion de personalidad de cada persona como contexto.
          </p>
        </li>
        <li>
          <Link href="/host/planes/nuevo">Crear un plan</Link>
        </li>
      </ul>
      {/*
       * Lo que sigue faltando aca es lo que el placeholder siempre denies: el
       * listado de planes que organizas y la cola de reportes. Se enumeran
       * porque una pantalla terminada en serio no omite lo que le falta.
       */}
      <p className="note">
        Todavia no existe: el listado de planes que organizas y la cola de
        reportes.
      </p>
    </RoleShell>
  )
}
