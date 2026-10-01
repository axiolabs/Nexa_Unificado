import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth/guard'
import { getPrisma } from '@/lib/db'
import { fail } from '@/lib/http'

/**
 * GET /api/host/plans
 *
 * Los planes que organiza la persona con sesion, con cuantas solicitudes hay
 * pendientes en cada uno. Es lo que hace de selector en `/host/requests`.
 *
 * Sin este endpoint la pantalla de solicitudes no tiene por donde arrancar: el
 * unico listado de planes que hay es `GET /api/plans`, que es una busqueda en
 * un bounding box del mapa, y `/requests` es por plan. O sea que faltaba el
 * enlace entre los dos.
 *
 * **Devuelve los planes Propios, tambien para un ADMIN.** Un ADMIN puede ver
 * la pantalla porque el middleware lo deja pasar, pero `/requests` solo le
 * muestra los planes que el mismo creo (`plan.creatorId !== gate.user.id` da
 * 403). Si esta lista le trajera los planes de los demas, el selector lo
 * llevaria a pantallas que le rebotan 403 una tras otra.
 */
export async function GET() {
  const gate = await requireRole(['HOST', 'ADMIN'])
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })

  const prisma = getPrisma()
  const now = new Date()

  const plans = await prisma.plan.findMany({
    where: { creatorId: gate.user.id, deletedAt: null },
    // Primero los que empiezan antes. En una pantalla de triaje, el plan de
    // mañana es mas urgente que el de la semana que viene, y mezclar los
    // cancelados con los abiertos obliga a leer la fecha para saber cual es
    // cual. Los cancelados van despues, no se ocultan.
    //
    // El `status: 'asc'` NO ordena alfabeticamente: en Postgres los enums se
    // ordenan por su orden de declaracion, y aca el de `PlanStatus` es
    // OPEN, CANCELLED, COMPLETED. O sea que este orden es exactamente el
    // dichoso, pero depende de que nadie reescriba el enum. Por eso hay un test
    // que fija el orden de la respuesta: si una migracion reordena el enum, el
    // test se cae y se ve por que. Prisma no permite decir "OPEN antes que
    // CANCELLED" en un `orderBy`, y meter un `CASE` en SQL crudo por esto
    // seria mas fragil todavia.
    orderBy: [{ status: 'asc' }, { startsAt: 'asc' }],
    select: {
      id: true,
      title: true,
      startsAt: true,
      capacity: true,
      acceptedCount: true,
      status: true,
      place: { select: { name: true } },
      // Conteo en la misma consulta: una fila por solicitud pendiente y no
      // vencida. El filtro de `expiresAt` replica el de `/requests` para que el
      // numero del selector no cuente peticiones que la pantalla ya no lista.
      _count: {
        select: {
          participants: {
            where: { status: 'REQUESTED', expiresAt: { gt: now } },
          },
        },
      },
    },
  })

  return NextResponse.json({
    plans: plans.map((p) => ({
      id: p.id,
      title: p.title,
      placeName: p.place.name,
      startsAt: p.startsAt,
      capacity: p.capacity,
      acceptedCount: p.acceptedCount,
      status: p.status,
      pendingCount: p._count.participants,
    })),
  })
}
