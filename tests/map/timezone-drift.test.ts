import { describe, expect, it } from 'vitest'
import { getPrisma } from '../../lib/db'

/**
 * `Plan.startsAt` es `timestamp WITHOUT TIME ZONE`.
 *
 * Con node corriendo en una zona que no es UTC, eso hace que el instante que
 * se escribe y el que se lee no coincidan. No es un detalle de test: si el
 * read-back se corre 5 horas, la hora que se le muestra al organizador y la
 * que se le muestra al participante son distintas, y el auto-resolucion de
 * §5.8 decide mal porque compara contra un instante corrido.
 *
 * Este test existe para que la decision sea explicita: o las columnas son
 * `timestamptz` y esto da 0, o el desvío queda documentado a la vista.
 */
describe('deriva de zona horaria en Plan.startsAt', () => {
  it('lo que se escribe y lo que se lee son el mismo instante', async () => {
    const prisma = getPrisma()
    const target = new Date(Date.now() + 24 * 3_600_000)

    const user = await prisma.user.findFirstOrThrow()
    const plan = await prisma.plan.create({
      data: {
        title: 'tz probe',
        place: {
          create: {
            name: 'tz probe place',
            category: 'CAFE',
            latitude: -34.6,
            longitude: -58.38,
            timezone: 'America/Argentina/Buenos_Aires',
            verificationStatus: 'APPROVED',
          },
        },
        creator: { connect: { id: user.id } },
        startsAt: target,
        capacity: 4,
        acceptedCount: 1,
      },
      select: { id: true, startsAt: true },
    })

    try {
      const driftHours = (plan.startsAt.getTime() - target.getTime()) / 3_600_000
      // Tolera 1 minuto: lo que no se tolera son horas.
      expect(driftHours).toBe(0)
    } finally {
      await prisma.plan.delete({ where: { id: plan.id } }).catch(() => {})
      await prisma.place.deleteMany({ where: { name: 'tz probe place' } })
      await prisma.$disconnect()
    }
  })
})
