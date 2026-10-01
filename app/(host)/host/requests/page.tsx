import { RoleShell } from '@/components/RoleShell'
import { ROLE } from '@/lib/authz'
import { RequestsClient } from './requests-client'

/**
 * `/host/requests`: la pantalla de aprobacion.
 *
 * Es la primera pantalla de `/host` que se arma de verdad. Antes de ella, la
 * unica forma de mover una peticion de `REQUESTED` a `ACCEPTED` era llamar al
 * endpoint a mano, o sea que el flujo de unirse a un plan no tinha final: el
 * postulante esperaba 24h y se auto-resolvia solo.
 *
 * El plan se elige por `?plan=`, no con estado del cliente. Razon: la pantalla
 * es de triaje, uno mira cinco planes seguidos, y con estado la recarga del
 * navegador perdia el plan que estabas revisando. Con la URL, el plan elegido
 * sobrevive al F5 y se puede mandar por chat. Es tambien lo que el doc de Next
 * recomienda para leer parametros que decides cargar en la pagina: el prop
 * `searchParams`, no `useSearchParams` del cliente.
 */
export default async function HostRequestsPage({
  searchParams,
}: {
  searchParams: Promise<{ plan?: string | string[] }>
}) {
  const sp = await searchParams
  const planPedido = typeof sp.plan === 'string' ? sp.plan : undefined

  return (
    <RoleShell
      title="Solicitudes de participacion"
      description="Acepta o rechaza a quien pidio unirse a tus planes."
      required={[ROLE.HOST, ROLE.ADMIN]}
    >
      {/*
       * El `key` no es cosmetico. Sin el, `RequestsClient` se inicializa con
       * `useState(planPedido)` y al navegar de un plan a otro con los `<Link>`
       * del selector React conserva el mismo componente montado: el prop
       * cambia pero el estado inicial no se vuelve a leer, y la pantalla
       * seguiria mostrando el plan anterior con el nuevo de la URL. Montar de
       * nuevo por plan es lo que hace que la URL sea la verdad, que es la
       * razon por la que el plan vive en `?plan=` y no en el cliente.
       */}
      <RequestsClient key={planPedido ?? 'sin-plan'} planPedido={planPedido} />
    </RoleShell>
  )
}
