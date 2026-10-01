import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireUser } from '@/lib/auth/session'
import { getPrisma } from '@/lib/db'
import { assertSameOrigin, fail } from '@/lib/http'
import { reliabilityFor } from '@/lib/reliability'
import { alineacionDe } from '@/lib/alignment'

/**
 * Auto-resolucion de solicitudes vencidas. Regla del spec (`modelo-datos.md`
 * §5.8): si hay cupo, `ACCEPTED`; si el plan esta lleno, `DECLINED`. En ambos
 * casos `respondedAt = now()`.
 *
 * `expiresAt` NO se borra al resolver: el spec lo conserva como evidencia de
 * cuando vencio la solicitud. Solo se limpia en una cancelacion del
 * participante, donde no hay nada que evidenciar.
 *
 * Y lo mas importante: **una solicitud a la vez**.
 *
 * El spec (§8, riesgo #1) avisa que resolver en lote acepta a ciegas: un plan
 * de 4 con 15 solicitudes vencidas termina con 15 aceptados. Un plan
 * sobrecapacidadado destruye la promesa del producto, asi que el lote esta
 * prohibido por diseno.
 *
 * Cada solicitud abre su propia transaccion con el cupo en el mismo `WHERE` del
 * incremento. No hace falta `SELECT ... FOR UPDATE` como propone el spec: el
 * `updateMany` condicional da la misma garantia sin bloquear la fila, porque la
 * comparacion y la escritura son una sola sentencia. Lo que no se puede es
 * sacar la comparacion de la sentencia, que es justo lo que hace aceptable el
 * lote.
 */
async function resolveExpired(
  prisma: ReturnType<typeof getPrisma>,
  planId: string,
  now: Date,
): Promise<{ accepted: number; declined: number }> {
  const expired = await prisma.planParticipant.findMany({
    where: { planId, status: 'REQUESTED', expiresAt: { lte: now } },
    // Orden FIFO por vencimiento: si el plan se llena a mitad del lote, el que
    // pidio primero tiene prioridad sobre el que pidio despues.
    orderBy: [{ expiresAt: 'asc' }, { joinedAt: 'asc' }],
    select: { userId: true },
  })

  let accepted = 0
  let declined = 0

  for (const { userId } of expired) {
    const plan = await prisma.plan.findFirst({
      where: { id: planId, deletedAt: null },
      select: { capacity: true },
    })
    if (!plan) break

    const outcome = await prisma.$transaction(async (tx) => {
      // CAS: solo si sigue REQUESTED y vencida. Frena el doble resolving si
      // dos lectores entran a la vez.
      const claimed = await tx.planParticipant.updateMany({
        where: { planId, userId, status: 'REQUESTED', expiresAt: { lte: now } },
        data: { status: 'ACCEPTED', respondedAt: now },
      })
      if (claimed.count === 0) return 'stale' as const

      // El cupo va en el MISMO `WHERE` que el incremento.
      const bumped = await tx.plan.updateMany({
        where: { id: planId, deletedAt: null, acceptedCount: { lt: plan.capacity } },
        data: { acceptedCount: { increment: 1 } },
      })

      if (bumped.count === 0) {
        // Se asume ACCEPTED de mas y se corrige a DECLINED dentro de la misma
        // transaccion: si el updateMany no encuentra cupo, nunca hubo
        // incremento y esta fila queda coherente con el plan.
        await tx.planParticipant.update({
          where: { planId_userId: { planId, userId } },
          data: { status: 'DECLINED', respondedAt: now },
        })
        return 'declined' as const
      }

      return 'accepted' as const
    })

    if (outcome === 'accepted') accepted += 1
    else if (outcome === 'declined') declined += 1
  }

  return { accepted, declined }
}
/**
 * GET /api/plans/[planId]/requests
 *
 * La pantalla de aprobacion. Solo el creador del plan.
 *
 * Existe separada del detalle del plan porque el detalle lo puede ver cualquier
 * usuario con sesion, y aca va la reliability de los postulantes. Ponerlo en el
 * detalle publicaria el historial de plantones de terceros a cualquiera.
 *
 * Ademas devuelve `remainingSpots`: sin eso el organizador aprueba a ciegas y
 * la aprobacion se rebota sola cuando ya no hay lugar.
 *
 * **Orden: FIFO por `joinedAt`, no por reliability.** El spec (§5.9) propone
 * ordenar las solicitudes por el score de comportamiento "para que el
 * organizador ordene primero a quien mas probablemente va en serio", y con el
 * score crudo de `reliabilityFor` eso no se puede ni querer: sin historial da
 * `null`, y con una asistencia y cinco plantones la tasa es identica a la de
 * alguien con diez y cinco. Si se ordenara por la version suavizada de §5.9
 * (Laplace, con alfa=2) el problema cambia de forma pero no desaparece, porque la
 * varianza con `n` chico es enorme: 1 asistencia perfecta da 0.667 y 5 de 10 da
 * 0.5, o sea que **una sola muestra buena le gana a un historial real**. Un
 * ranking asi manda al frente al azar y castiga al que seunta tarde, que es la
 * unica vez que el FIFO le hace algo injusto a alguien. La reliability se
 * devuelve y se muestra como senal, no como orden.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ planId: string }> }) {
  const gate = await requireUser()
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })

  const { planId } = await ctx.params
  const prisma = getPrisma()

  const plan = await prisma.plan.findFirst({
    where: { id: planId, deletedAt: null },
    select: {
      id: true,
      creatorId: true,
      title: true,
      capacity: true,
      acceptedCount: true,
      startsAt: true,
      status: true,
      placeId: true,
    },
  })
  if (!plan) return fail(404, 'Plan no encontrado')
  if (plan.creatorId !== gate.user.id) return fail(403, 'Solo el organizador ve las peticiones')

  const pending = await prisma.planParticipant.findMany({
    where: { planId, status: 'REQUESTED' },
    orderBy: { joinedAt: 'asc' },
    select: { userId: true, joinedAt: true, expiresAt: true },
  })

  const now = new Date()

  // Barrido perezoso: se resuelve antes de listar, para que la pantalla no
  // muestre peticiones que ya vencieron. El indice [status, expiresAt] sirve
  // para esto y para el cron futuro; hoy lo dispara el que mira la pantalla.
  const resolved = await resolveExpired(prisma, planId, now)

  const live = pending.filter((p) => p.expiresAt !== null && p.expiresAt > now)

  const reliability = await reliabilityFor(
    prisma,
    live.map((p) => p.userId),
  )
  const names = await prisma.user.findMany({
    where: { id: { in: live.map((p) => p.userId) } },
    select: { id: true, name: true },
  })
  const nameById = new Map(names.map((n) => [n.id, n.name]))

  // Alineacion de cada postulante contra los rasgos del LUGAR del plan (§5.1 del
  // spec, `lib/alignment.ts`). Los pesos del lugar se leen una vez porque son
  // los mismos para todos los postulantes; lo que varia es el puntaje de cada
  // persona.
  const placeTraits = await prisma.placeTrait.findMany({
    where: { placeId: plan.placeId },
    select: { traitId: true, weight: true },
  })
  const pesos = new Map(placeTraits.map((t) => [t.traitId, t.weight]))

  // Un postulante puede tener varias versiones del test hechas. Se toma la MAS
  // RECIENTE de cada uno, no la de mayor `testId`: el `version` es un entero
  // del seed y no tiene por que crecer con el tiempo.
  const ids = live.map((p) => p.userId)
  const results = await prisma.personalityResult.findMany({
    where: { userId: { in: ids } },
    orderBy: { completedAt: 'desc' },
    select: { userId: true, scores: { select: { traitId: true, value: true } } },
  })
  const valoresPorUsuario = new Map<string, Map<string, number>>()
  for (const r of results) {
    // El `orderBy` de arriba ya los deja del mas nuevo al mas viejo, asi que el
    // primero que aparece para un usuario es el que se queda.
    if (valoresPorUsuario.has(r.userId)) continue
    valoresPorUsuario.set(r.userId, new Map(r.scores.map((s) => [s.traitId, s.value])))
  }

  return NextResponse.json({
    plan: {
      id: plan.id,
      title: plan.title,
      startsAt: plan.startsAt,
      capacity: plan.capacity,
      acceptedCount: plan.acceptedCount,
      remainingSpots: plan.capacity - plan.acceptedCount,
      status: plan.status,
    },
    requests: live.map((p) => ({
      userId: p.userId,
      name: nameById.get(p.userId) ?? 'Usuario',
      joinedAt: p.joinedAt,
      expiresAt: p.expiresAt,
      // Cuanto le queda, en horas redondeadas hacia arriba. El ceil es
      // deliberado: mostrar "0h" para algo que vence en 3 minutos hace que el
      // organizador lo descarte por tiempo cuando todavia tiene tiempo.
      hoursLeft: p.expiresAt
        ? Math.max(0, Math.ceil((p.expiresAt.getTime() - now.getTime()) / 3_600_000))
        : 0,
      reliability: reliability.get(p.userId) ?? null,
      // `null` cuando la persona no hizo el test, o cuando no comparte ningun
      // rasgo con el lugar. La pantalla tiene que distinguirlo de un `0`, que
      // seria "sus rasgos no encajan" en vez de "no hay nada que comparar".
      alineacion: alineacionDe(valoresPorUsuario.get(p.userId) ?? new Map(), pesos),
    })),
    resolved,
  })
}
const respondSchema = z
  .object({
    userId: z.string({ error: 'Falta el postulante' }).min(1, 'Falta el postulante'),
    decision: z.enum(['ACCEPTED', 'DECLINED'], {
      error: 'La decision debe ser ACCEPTED o DECLINED',
    }),
  })
  .strict()

/**
 * POST /api/plans/[planId]/requests
 *
 * El organizador acepta o rechaza una peticion. Aca es donde `acceptedCount`
 * sube, y por lo tanto aca esta el overbooking.
 *
 * Sobre el cupo, misma tecnica que se ideo para el join: el `updateMany` lleva
 * la comparacion y el incremento en la misma sentencia.
 *
 *   updateMany({ where: { id, acceptedCount: { lt: capacity } }, data: { increment } })
 *
 * Postgres evalua el `WHERE` y el `UPDATE` en un solo paso, asi que dos
 * aprobaciones simultaneas no pueden leer ambas "queda 1" y escribir 2. Con un
 * `findFirst` para leer el cupo y despues un `update`, las dos leen 1, las dos
 * escriben 2, y el plan queda con una persona de mas.
 */
export async function POST(req: Request, ctx: { params: Promise<{ planId: string }> }) {
  const originError = assertSameOrigin(req)
  if (originError) return originError

  const gate = await requireUser()
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })

  const { planId } = await ctx.params
  const organizerId = gate.user.id

  const raw = await req.json().catch(() => null)
  const parsed = respondSchema.safeParse(raw)
  if (!parsed.success) return fail(400, parsed.error.issues[0]?.message ?? 'Payload invalido')
  const { userId: applicantId, decision } = parsed.data

  const prisma = getPrisma()

  const plan = await prisma.plan.findFirst({
    where: { id: planId, deletedAt: null },
    select: { creatorId: true, capacity: true, status: true, startsAt: true },
  })
  if (!plan) return fail(404, 'Plan no encontrado')
  if (plan.creatorId !== organizerId) return fail(403, 'Solo el organizador responde peticiones')
  if (applicantId === organizerId) return fail(400, 'No podes responderte a vos mismo')

  const now = new Date()
  const request = await prisma.planParticipant.findUnique({
    where: { planId_userId: { planId, userId: applicantId } },
    select: { status: true, expiresAt: true },
  })
  if (!request) return fail(404, 'Esa persona no pidio unirse a este plan')
  if (request.status !== 'REQUESTED') return fail(409, 'La peticion ya fue respondida')
  if (request.expiresAt === null || request.expiresAt <= now) {
    // Vencida: se aplica la MISMA regla del barrido (cupo -> ACCEPTED, lleno ->
    // DECLINED) y no se espera al proximo que mire la pantalla. Aprobar a
    // ciegas una peticion vencida seria inventarse una decision.
    const resolved = await resolveExpired(prisma, planId, now)
    return fail(
      409,
      resolved.accepted > 0
        ? 'La peticion ya habia vencido y se resolvio automaticamente'
        : 'La peticion ya habia vencido y se rechazo por falta de cupo',
    )
  }

  if (decision === 'DECLINED') {
    // `expiresAt` se conserva: el spec lo mantiene como evidencia de cuando
    // vencio la solicitud. No se limpia al responder.
    await prisma.planParticipant.update({
      where: { planId_userId: { planId, userId: applicantId } },
      data: { status: 'DECLINED', respondedAt: now },
    })
    return NextResponse.json({ userId: applicantId, status: 'DECLINED' })
  }

  try {
    const outcome = await prisma.$transaction(async (tx) => {
      // Un rechazo concurrente gana la carrera: se marca el status en el mismo
      // `WHERE` del updateMany, asi que un solo CAS puede hacer de todo.
      const claimed = await tx.planParticipant.updateMany({
        where: { planId, userId: applicantId, status: 'REQUESTED', expiresAt: { gt: now } },
        data: { status: 'ACCEPTED', respondedAt: now },
      })
      if (claimed.count === 0) return { outcome: 'stale' as const }

      const bumped = await tx.plan.updateMany({
        where: {
          id: planId,
          deletedAt: null,
          status: 'OPEN',
          startsAt: { gt: now },
          acceptedCount: { lt: plan.capacity },
        },
        data: { acceptedCount: { increment: 1 } },
      })
      if (bumped.count === 0) return { outcome: 'full' as const }

      return { outcome: 'accepted' as const }
    })

    switch (outcome.outcome) {
      case 'accepted':
        return NextResponse.json({ userId: applicantId, status: 'ACCEPTED' })
      case 'full':
        // El cupo se llenó entre que se listó la pantalla y se aprobó. El
        // participante queda REQUESTED: el organizador puede rechazarlo o
        // esperar que alguien cancele. Perderlo automaticamente seria peor
        // que dejar la decision en manos de quien tiene el contexto.
        return fail(409, 'El plan ya esta completo')
      case 'stale':
        return fail(409, 'La peticion ya fue respondida')
    }
  } catch (err) {
    // Un fallo de base de datos NO es un conflicto del usuario. Traducirlo a
    // 409 lo camufla como "ya respondiste" y esconde el problema real.
    console.error('[plans/requests] fallo la transaccion de aceptacion', err)
    return fail(500, 'No se pudo completar la operacion')
  }
}
