import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth/session'
import { getPrisma } from '@/lib/db'
import { assertSameOrigin, fail, readJson } from '@/lib/http'
import { planCerrable, porQueNoSeCierra } from '@/lib/plan-finished'
import { puedeMarcar } from '@/lib/attendance'
import { attendanceSchema } from '@/lib/validation'

/**
 * POST /api/plans/[planId]/attendance
 *
 * El organizador marca quien estuvo. **Este es el productor que faltaba**:
 * `ATTENDED` y `NO_SHOW` ya se leian en tres lugares — la reliability que se le
 * muestra al organizador al aprobar (§5.9 de `docs/modelo-datos.md`), el gate
 * del chat y la ventana de calificacion — y nada en el proyecto los escribia.
 *
 * Eso no era un bug de los tres lectores: era un feature entero construido
 * sobre datos que no existen. La reliability devolvia "Sin historial" para todo
 * el mundo, para siempre, y los tests lo pasaban igual porque sembraban los
 * estados a mano por SQL crudo. Un test puede probar que la query esta bien; no
 * puede probar que algo produzca la fila que la query resume.
 *
 * **Por que lo escribe una persona y no un job.** La lista de quien estuvo la
 * sabe el organizador, no el sistema: nadie vio quien entro por la puerta. Un
 * job que pusiera `NO_SHOW` a quien no se presento seria una calumnia
 * automatizada, y `ATTENDED` no se puede inferir de nada. Lo que si se puede
 * automatizar es *ofrecer* la pantalla ("el plan termino, marcala asistencia"),
 * y eso lo decide la hora, no el estado (ver `lib/plan-finished.ts`).
 *
 * **El organizador tambien se marca a si mismo.** No es un caso especial a
 * menos: su fila de `PlanParticipant` es tan participante como la de cualquiera
 * y organizando tambien se asiste. Sin esto, la lista que el propio organizador
 * esta completando lo dejaria a el en `ACCEPTED` para siempre.
 *
 * **No toca `acceptedCount`.** Marcar asistencia no libera ni ocupa lugares: un
 * `ATTENDED` y un `NO_SHOW` ocupan un lugar igual que un `ACCEPTED`. Tocar el
 * contador aqui incrementaria un tope que ya no importa y dejaria la regla de
 * cupo — que se sostiene en el endpoint de solicitudes — con dos fuentes de
 * verdad.
 */

export async function POST(req: Request, ctx: { params: Promise<{ planId: string }> }) {
  const originError = assertSameOrigin(req)
  if (originError) return originError

  const gate = await requireUser()
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })

  const { planId } = await ctx.params
  const organizerId = gate.user.id

  const raw = await readJson(req)
  const parsed = attendanceSchema.safeParse(raw)
  if (!parsed.success) return fail(400, parsed.error.issues[0]?.message ?? 'Payload invalido')
  const { userId, attendance } = parsed.data

  const prisma = getPrisma()

  const plan = await prisma.plan.findFirst({
    where: { id: planId, deletedAt: null },
    select: { creatorId: true, status: true, startsAt: true, endsAt: true },
  })
  if (!plan) return fail(404, 'Plan no encontrado')
  if (plan.creatorId !== organizerId) {
    return fail(403, 'Solo el organizador marca la asistencia')
  }

  // La misma funcion que decide si la seccion aparece en la pantalla. Si el
  // render y el endpoint dijeran cosas distintas, el boton se veria y el POST
  // responderia 403: la combinacion que no tiene que existir.
  if (!planCerrable(plan)) {
    return fail(403, porQueNoSeCierra(plan) ?? 'El plan todavia no se puede cerrar')
  }

  const participant = await prisma.planParticipant.findUnique({
    where: { planId_userId: { planId, userId } },
    select: { status: true },
  })
  if (!participant) {
    return fail(404, 'Esa persona no participo de este plan')
  }
  if (!puedeMarcar(participant.status)) {
    // `REQUESTED` nunca fue, `DECLINED` no fue, `CANCELLED` se dio de baja. Los
    // tres se podrian marcar igual, y el resultado seria una persona que
    // "asistio" a un plan al que nunca estuvo: un dato falso dentro del mismo
    // sistema que despues calcula la confianza de la gente.
    return fail(409, 'No se puede marcar la asistencia de alguien que no tenia lugar')
  }

  const actualizado = await prisma.planParticipant.update({
    where: { planId_userId: { planId, userId } },
    data: { status: attendance },
    select: { status: true },
  })

  return NextResponse.json({
    userId,
    status: actualizado.status,
    // Si no cambio nada, se dice. El endpoint no falla y la pantalla no tiene
    // que recargar: la lista ya estaba bien y el toque fue un no-op.
    cambio: participant.status !== attendance,
  })
}
