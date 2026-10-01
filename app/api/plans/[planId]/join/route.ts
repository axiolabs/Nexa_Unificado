import { NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { requireUser } from '@/lib/auth/session'
import { getPrisma } from '@/lib/db'
import { assertSameOrigin, fail } from '@/lib/http'
import { isRetryableDbError } from '@/lib/prisma-errors'

/** Ventana que tiene el organizador para responder antes de que la peticion venza. */
export const REQUEST_TTL_HOURS = 24

/**
 * POST /api/plans/[planId]/join
 *
 * Cualquier usuario con sesion puede PEDIR "unirse". No hace falta rol: el que
 * organiza ya aprobo el plan al crearlo, y esto es un user diciendo "me sumo".
 *
 * Y "pide", no "entra". La peticion queda `REQUESTED` y la resuelve el
 * organizador. Esto no es un detalle de UI: el `PlanParticipant.status` tiene
 * `@default(REQUESTED)` en el schema, y hay un indice
 * `@@index([status, expiresAt])` que solo tiene sentido para el barrido de
 * vencidas. El flujo de aprobacion estaba resuelto; aca se lo implementa.
 *
 * Sobre el cupo: entrar NO consume cupo. `acceptedCount` sube recien cuando el
 * organizador ACEPTA, en el endpoint de respuesta, que es donde esta el
 * overbooking. Una peticion tampoco puede dispararse a un plan lleno por mucho
 * que se repita el endpoint, porque no toca `acceptedCount` en absoluto.
 */
export async function POST(req: Request, ctx: { params: Promise<{ planId: string }> }) {
  const originError = assertSameOrigin(req)
  if (originError) return originError

  const gate = await requireUser()
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })

  const { planId } = await ctx.params
  const userId = gate.user.id

  // El creador no se "une" a su propio plan: ya esta como ORGANIZER y ACCEPTED.
  // Sin este chequeo el insert choca con el PK compuesto [planId, userId] y
  // devolveria un 500 por una peticion que en realidad es un no-op.
  //
  // El lugar viene en la misma consulta a proposito. Es una lectura, y aunque
  // tenga su propia ventana, la consecuencia de perderla es acotada: queda una
  // fila `REQUESTED` que el organizador puede rechazar. No es lo mismo que en
  // la creacion, donde la carrera deixa un plan publico nacido en un lugar que
  // Curaduria acaba de sacar de circulacion; por eso alla la validacion va DENTRO
  // de la transaccion y aca alcanza con la lectura.
  const plan = await getPrisma().plan.findFirst({
    where: { id: planId, deletedAt: null },
    select: {
      creatorId: true,
      startsAt: true,
      status: true,
      capacity: true,
      acceptedCount: true,
      place: { select: { verificationStatus: true, isActive: true, deletedAt: true } },
    },
  })
  if (!plan) return fail(404, 'Plan no encontrado')
  if (plan.creatorId === userId) return fail(400, 'Ya sos el organizador de este plan')
  if (plan.status !== 'OPEN') return fail(409, 'El plan ya no acepta participantes')
  if (plan.startsAt.getTime() <= Date.now()) return fail(409, 'El plan ya empezo')

  // El plan no se CANCELA cuando el lugar deja de estar aprobado, pero deja de
  // admitting gente. Son dos decisiones y van en dos sentidos:
  //
  //   - Cancelar seria peor para los que ya estan: aceptaron con una promesa,
  //     canal de notificacion, y se enteran el dia que se presentan.
  //   - Seguir admitiendo es el problema de verdad: Curaduria existe para
  //     controlar que lugares son seguros y vigentes, y un lugar curado que
  //     sigue reclutando desconocidos hace vacua la curaduria.
  //
  // Entonces: los participantes existentes conservan su lugar, y la puerta se
  // cierra para los nuevos. Ver `planablePlaceWhere()` y la seccion 12 de
  // `docs/decisiones-auth.md`.
  if (
    plan.place.verificationStatus !== 'APPROVED' ||
    !plan.place.isActive ||
    plan.place.deletedAt !== null
  ) {
    return fail(409, 'El lugar de este plan ya no esta disponible')
  }

  const existing = await getPrisma().planParticipant.findUnique({
    where: { planId_userId: { planId, userId } },
    select: { status: true, expiresAt: true },
  })

  if (existing) {
    // Reintentar una peticion viva devuelve 409 con el estado, para que el
    // cliente pueda pintar \"esperando aprobacion\" en vez de un error generico.
    // Reenviar la peticion cuando ya vencio la deja vencer: el organizador
    // pierde la chance de aprobarla a ciegas, y el que la rehace es el
    // interesado.
    if (existing.status === 'REQUESTED' && existing.expiresAt && existing.expiresAt <= new Date()) {
      await getPrisma().planParticipant.update({
        where: { planId_userId: { planId, userId } },
        data: { status: 'CANCELLED', expiresAt: null },
      })
      return fail(409, 'Tu peticion vencio; volvela a enviar')
    }
    return NextResponse.json({ status: existing.status }, { status: 409 })
  }

  // Advertencia al pedir en un plan lleno: la peticion se acepta igual, porque
  // cancelar en el peor momento libera el lugar para otro. Lo que no se puede
  // es fingir que hay cupo.
  const remaining = plan.capacity - plan.acceptedCount

  // `expiresAt = min(now() + 24h, plan.startsAt)`.
  //
  // El `min` con el inicio del plan no es un detalle: si el plan arranca en dos
  // horas, el plazo es de dos horas. Un plazo de 24h sobre un plan que ya
  // empezo dejaria solicitudes REQUESTED para siempre, porque nadie las puede
  // resolver: el plan ya no acepta participantes. El plazo nunca sobrevive al
  // inicio del plan.
  const ttlEnd = Date.now() + REQUEST_TTL_HOURS * 3_600_000
  const expiresAt = new Date(Math.min(ttlEnd, plan.startsAt.getTime()))

  try {
    const created = await getPrisma().planParticipant.create({
      data: {
        planId,
        userId,
        role: 'PARTICIPANT',
        status: 'REQUESTED',
        expiresAt,
      },
      select: { status: true, expiresAt: true },
    })

    return NextResponse.json(
      {
        status: created.status,
        expiresAt: created.expiresAt,
        remainingSpots: remaining,
        planIsFull: remaining <= 0,
      },
      { status: 201 },
    )
  } catch (err) {
    // Infraestructura primero: caida de la base o deadlock son 503, no un
    // mensaje de negocio. Ver `isRetryableDbError`.
    if (isRetryableDbError(err)) {
      return fail(503, 'No pudimos anotarte; reintenta en un momento')
    }
    // P2002 es la unica colision esperable aca: el PK compuesto [planId, userId]
    // frena dos peticiones identicas. Sin el filtro de `code`, un `catch { }`
    // responde "ya participas de este plan" a TODO error, y eso miente sobre la
    // causa cuando lo que se cayo es la conexion: el usuario cree que entro y no
    // entro, y en el log el incidente queda escondido detras de un 409.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return fail(409, 'Ya participas de este plan')
    }
    throw err
  }
}
