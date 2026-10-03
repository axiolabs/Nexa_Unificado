import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, createPlace, createPlan, createUser, rawQuery, resetDb } from '../helpers/db'
import { hashPassword } from '../../lib/auth/password'

/**
 * Que el borrado de un reporte se comporte, medido contra la base y no de memoria.
 *
 * Esto existia ya con el modelo en verde y fallaba en las dos direcciones, que
 * es lo peor: la suite pasaba mientras la accion central de una cola de
 * moderacion era imposible de ejecutar.
 *
 *   - Las cuatro FK de objetivo eran `ON DELETE SET NULL` y al lado hay un CHECK
 *     de `num_nonnulls(...) = 1`. Borrar lo reportado dejaba la fila con cero
 *     objetivos y Postgres respondia `violates check constraint
 *     "ModerationReport_exactamente_un_objetivo"`. No era un borde: era la
 *     operacion principal.
 *   - `reporterId` era `ON DELETE CASCADE`, asi que borrar la cuenta del
 *     denunciante se llevaba sus reportes. Aqui se mide 3 -> 0.
 *
 * Los dos eran silenciosos en el sentido que importa: el primero reventaba con
 * un error de Postgres que no nombra al reporte, y el segundo no reventaba nada.
 */

const CAFE = { name: 'Cafe Tortuga', lat: 6.24, lng: -75.57 }

// Se hashea una vez, en el primer beforeEach: argon2 a 64 MiB por hash hace que
// hashear por test se note en la duracion de la suite.
let passwordHash = ''

const nuevoUsuario = async (email: string) => createUser({ email, passwordHash, roles: ['USER'] })

/** Un reporte valido, con la FK que corresponde a su `target`. */
async function reportar(opts: {
  reporterId: string
  target: 'PLACE' | 'PLAN' | 'USER'
  placeId?: string
  planId?: string
  userId?: string
}) {
  const columna = { PLACE: 'placeId', PLAN: 'planId', USER: 'userId' }[opts.target]
  const filas = await rawQuery<{ id: string }>(
    `INSERT INTO "ModerationReport" (id, "reporterId", target, reason, "${columna}", "createdAt", "updatedAt")
     VALUES (gen_random_uuid()::text, $1, $2, 'OTHER', $3, now(), now()) RETURNING id`,
    [opts.reporterId, opts.target, (opts as Record<string, string | undefined>)[columna]],
  )
  return filas[0].id
}

/** Cuenta reportes, para no afirmar sobre un id que no se sabe si sobrevivio. */
async function contarReportes(reporterId: string): Promise<number> {
  const filas = await rawQuery<{ c: number }>(
    'SELECT count(*)::int AS c FROM "ModerationReport" WHERE "reporterId" = $1',
    [reporterId],
  )
  return filas[0].c
}

describe('borrado y evidencia de reportes', () => {
  beforeEach(async () => {
    await resetDb()
    passwordHash = await hashPassword('prueba-1234')
  })
  afterAll(closeDb)

  it('borrar un lugar reportado falla con la FK, no con el CHECK', async () => {
    // La distincion importa. Con `SET NULL` el error era del CHECK y decia
    // "exactamente un objetivo", que manda a mirar el reporte en vez de a la
    // FK. Con `Restrict` el error nombra la constraint de la FK, que es donde
    // esta la decision.
    const ana = await nuevoUsuario('ana@test.local')
    const lugar = await createPlace(CAFE)
    await reportar({ reporterId: ana.id, target: 'PLACE', placeId: lugar.id })

    await expect(rawQuery('DELETE FROM "Place" WHERE id = $1', [lugar.id])).rejects.toThrow(
      /ModerationReport_placeId_fkey/,
    )

    // Y el reporte sigue ahi: bloqueado, no destruido.
    expect(await contarReportes(ana.id)).toBe(1)
  })

  it('borrar un plan reportado tambien falla, y no solo el lugar', async () => {
    // El caso del lugar daba a entender que el bug era de `Place`: el primer
    // `DELETE` de la sesion chocaba antes con `Plan_placeId_fkey`. Este caso
    // aisla el de `Plan`.
    const ana = await nuevoUsuario('ana@test.local')
    const beto = await nuevoUsuario('beto@test.local')
    const lugar = await createPlace(CAFE)
    const plan = await createPlan({ placeId: lugar.id, creatorId: beto.id })
    await reportar({ reporterId: ana.id, target: 'PLAN', planId: plan.id })

    await expect(rawQuery('DELETE FROM "Plan" WHERE id = $1', [plan.id])).rejects.toThrow(
      /ModerationReport_planId_fkey/,
    )
    expect(await contarReportes(ana.id)).toBe(1)
  })

  it('borrar la cuenta de quien reporto no se lleva sus reportes', async () => {
    const ana = await nuevoUsuario('ana@test.local')
    const beto = await nuevoUsuario('beto@test.local')
    const carlos = await nuevoUsuario('carlos@test.local')
    const lugar = await createPlace(CAFE)
    const plan = await createPlan({ placeId: lugar.id, creatorId: beto.id })

    await reportar({ reporterId: ana.id, target: 'PLACE', placeId: lugar.id })
    await reportar({ reporterId: ana.id, target: 'PLAN', planId: plan.id })
    await reportar({ reporterId: ana.id, target: 'USER', userId: carlos.id })
    expect(await contarReportes(ana.id)).toBe(3)

    // Esto antes no fallaba: `CASCADE` borraba los tres y seguia de largo.
    // Que ahora falle es lo que avisa de que la evidencia existe.
    await expect(rawQuery('DELETE FROM "User" WHERE id = $1', [ana.id])).rejects.toThrow(
      /ModerationReport_reporterId_fkey/,
    )
    expect(await contarReportes(ana.id)).toBe(3)
  })

  it('el soft delete si funciona: el reporte no bloquea la baja logica', async () => {
    // El freno es para el borrado duro, no para el de verdad. Si esto fallara,
    // la decision de `Restrict` habria dejado al usuario sin forma de darse de
    // baja, que es un problema del producto vestido de decision de base.
    const ana = await nuevoUsuario('ana@test.local')
    const beto = await nuevoUsuario('beto@test.local')
    const lugar = await createPlace(CAFE)
    const plan = await createPlan({ placeId: lugar.id, creatorId: beto.id })
    await reportar({ reporterId: ana.id, target: 'PLAN', planId: plan.id })

    await rawQuery('UPDATE "Plan" SET "deletedAt" = now() WHERE id = $1', [plan.id])
    await rawQuery('UPDATE "User" SET "deletedAt" = now() WHERE id = $1', [ana.id])

    expect(await contarReportes(ana.id)).toBe(1)
  })

  it('los CHECK siguen valiendo: no se compro permiso de escribir reportes degenerados', async () => {
    // Relajar las FKs no puede haber relajado de paso el contrato de la base.
    const ana = await nuevoUsuario('ana@test.local')
    const beto = await nuevoUsuario('beto@test.local')
    const lugar = await createPlace(CAFE)
    const plan = await createPlan({ placeId: lugar.id, creatorId: beto.id })

    // Sin ningun objetivo.
    await expect(
      rawQuery(
        `INSERT INTO "ModerationReport" (id, "reporterId", target, reason, "createdAt", "updatedAt")
         VALUES (gen_random_uuid()::text, $1, 'PLACE', 'OTHER', now(), now())`,
        [ana.id],
      ),
    ).rejects.toThrow(/exactamente_un_objetivo/)

    // Dos objetivos.
    await expect(
      rawQuery(
        `INSERT INTO "ModerationReport" (id, "reporterId", target, reason, "placeId", "planId", "createdAt", "updatedAt")
         VALUES (gen_random_uuid()::text, $1, 'PLACE', 'OTHER', $2, $3, now(), now())`,
        [ana.id, lugar.id, plan.id],
      ),
    ).rejects.toThrow(/exactamente_un_objetivo/)

    // `target` que no coincide con la FK informada.
    await expect(
      rawQuery(
        `INSERT INTO "ModerationReport" (id, "reporterId", target, reason, "planId", "createdAt", "updatedAt")
         VALUES (gen_random_uuid()::text, $1, 'PLACE', 'OTHER', $2, now(), now())`,
        [beto.id, plan.id],
      ),
    ).rejects.toThrow(/target_coincide/)

    // Y el camino bueno, que tiene que seguir funcionando.
    const id = await reportar({ reporterId: ana.id, target: 'PLACE', placeId: lugar.id })
    expect(id).toBeTruthy()
    expect(await contarReportes(ana.id)).toBe(1)
  })
})