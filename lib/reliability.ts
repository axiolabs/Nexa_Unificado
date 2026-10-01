import { getPrisma } from '@/lib/db'

/**
 * Señal de confianza de un postulante, para la pantalla de aprobacion del
 * organizador.
 *
 * La unica fuente es el historial de `ParticipationStatus`: cuantas veces esa
 * persona fue `ATTENDED` y cuantas `NO_SHOW`. Los dos estados existen en el enum
 * justamente para esto.
 *
 * NO se usa el modelo `Rating`, aunque parezca el candidato obvio, y conviene
 * dejar escrito por que: `Rating` es una calificacion DEL PLAN, no de una
 * persona. Es `@@unique([planId, authorId])` y no tiene ningun campo que apunte
 * al planificado. Promediarlo por usuario daria "como rated este plan", que no
 * dice nada sobre si la persona se presenta. Cuando exista una calificacion
 * entre personas, el lugar natural es este archivo.
 *
 * Se calcula aparte y NO se mete en el detalle del plan. El detalle lo puede ver
 * cualquier usuario con sesion (ver `app/api/plans/[planId]/route.ts`), asi que
 * las tasas de cada uno no pueden ir ahi: el historial de plantones de terceros
 * no es dato que deba ver cualquiera. Esto se llama solo desde el endpoint de
 * aprobacion, que exige ser el creador del plan.
 *
 * `attended` y `noShow` cuentan participaciones de planes YA OCURRIDOS. Una
 * participacion futura no dice nada todavia, asi que no cuenta para ninguna de
 * las dos, aunque este ACCEPTED.
 */
export type Reliability = {
  attended: number
  noShow: number
  /** 0 a 1, o `null` si no hay historial. Nunca fingir un 50% sin datos. */
  showUpRate: number | null
}

type Prisma = ReturnType<typeof getPrisma>

async function reliabilityFor(
  tx: Prisma,
  userIds: string[],
): Promise<Map<string, Reliability>> {
  const out = new Map<string, Reliability>()
  if (userIds.length === 0) return out

  for (const id of userIds) {
    out.set(id, { attended: 0, noShow: 0, showUpRate: null })
  }

  const history = await tx.planParticipant.findMany({
    where: {
      userId: { in: userIds },
      status: { in: ['ATTENDED', 'NO_SHOW'] },
      plan: { startsAt: { lt: new Date() }, deletedAt: null },
    },
    select: { userId: true, status: true },
  })

  for (const h of history) {
    const row = out.get(h.userId)
    if (!row) continue
    if (h.status === 'ATTENDED') row.attended += 1
    else row.noShow += 1
  }

  for (const row of out.values()) {
    const total = row.attended + row.noShow
    // `null` y no 0: "sin historial" y "no se presento nunca" son cosas
    // distintas, y el organizador tiene que poder distinguirlas.
    row.showUpRate = total > 0 ? row.attended / total : null
  }

  return out
}

export { reliabilityFor }
