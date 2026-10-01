import { PlanDetailClient } from './plan-detail-client'

/**
 * Detalle de un plan: `/planes/[planId]`.
 *
 * Es la pantalla de "unirse", y tambien la que el flujo de creacion deberia
 * llevar al exito (hoy muestra un cartel y manda al mapa).
 *
 * El page.tsx es un Server Component minimo a proposito: NO consulta la base.
 * Toda la informacion, y sobre todo las reglas de visibilidad, salen de
 * `GET /api/plans/[planId]`, que ya tiene la excepcion de §13.6 escrita a mano.
 *
 * Duplicar esa consulta aca seria la peor version posible del error: dos copias
 * de un `OR` con tres ramas que evolve distinto, y una pantalla que muestra un
 * plan que la API acaba de decidir que no existe (o al reves, un 404 donde el plan
 * era visible). El 403/404 de esta pagina no viene del render: viene del `fetch`
 * del cliente, que es el unico que conoce las reglas.
 *
 * La proteccion de la ruta vive en el middleware por prefijo (`/planes` esta en
 * `AUTHENTICATED_PREFIXES`), asi que escribir la URL a mano tampoco la salva.
 */
export default async function PlanDetailPage({
  params,
}: {
  params: Promise<{ planId: string }>
}) {
  const { planId } = await params
  return <PlanDetailClient planId={planId} />
}
