import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { ParticipationStatus } from '@prisma/client'
import { hashPassword } from '../../lib/auth/password'
import { getPrisma } from '../../lib/db'
import { Client } from '../helpers/http'
import { closeDb, createPlace, createPlan, createUser, joinPlan, rawQuery, resetDb } from '../helpers/db'

/**
 * `POST /api/plans/[planId]/attendance`: el organizador dice quien estuvo.
 *
 * Este es el productor que faltaba, asi que el test mas importante del archivo
 * **no mira la respuesta**: mira la fila, leida de la base en crudo. Un endpoint
 * que devuelve `{ ok: true }` y no escribe nada pasa la mitad de los tests que
 * se escriben contra un status HTTP, y deja la reliability vacia sin que nadie
 * se entere. Por eso, el cierre del archivo relee `PlanParticipant` con `pg`.
 */

const PASSWORD = 'correcto-caballo-grapa-42'
const HACE_UN_RATO = () => new Date(Date.now() - 3_600_000)

let hilda: { id: string; email: string }
let ana: { id: string; email: string }
let beto: { id: string; email: string }
let place: { id: string }
/** Plan ya terminado: `startsAt` en el pasado y sin `endsAt`. */
let planTerminado: { id: string }
/** Plan que todavia no empezo. */
let planFuturo: { id: string }

beforeEach(async () => {
  await resetDb()
  const passwordHash = await hashPassword(PASSWORD)
  hilda = await createUser({ email: 'hilda@example.com', name: 'Hilda Host', passwordHash })
  ana = await createUser({ email: 'ana@example.com', name: 'Ana Ruiz', passwordHash })
  beto = await createUser({ email: 'beto@example.com', name: 'Beto Diaz', passwordHash })
  place = await createPlace({ name: 'Cafe Tortuga', lat: -34.6037, lng: -58.3816 })

  planTerminado = await createPlan({
    placeId: place.id,
    creatorId: hilda.id,
    startsAt: HACE_UN_RATO(),
    capacity: 4,
  })
  planFuturo = await createPlan({
    placeId: place.id,
    creatorId: hilda.id,
    startsAt: new Date(Date.now() + 86_400_000),
    capacity: 4,
  })

  await joinPlan({ planId: planTerminado.id, userId: hilda.id, status: 'ACCEPTED', role: 'ORGANIZER' })
  await joinPlan({ planId: planTerminado.id, userId: ana.id, status: 'ACCEPTED' })
  await joinPlan({ planId: planTerminado.id, userId: beto.id, status: 'ACCEPTED' })
})

afterAll(async () => {
  await closeDb()
})

async function loginAs(email: string): Promise<Client> {
  const c = new Client()
  expect((await c.login(email, PASSWORD)).status).toBe(200)
  return c
}

const marcar = (c: Client, planId: string, userId: string, attendance: string) =>
  c.post(`/api/plans/${planId}/attendance`, { userId, attendance })

/** El estado REAL en la base, sin pasar por la API que se esta probando. */
async function estadoEnBase(planId: string, userId: string) {
  const filas = await rawQuery<{ status: ParticipationStatus }>(
    `SELECT status FROM "PlanParticipant" WHERE "planId" = $1 AND "userId" = $2`,
    [planId, userId],
  )
  return filas[0]?.status ?? null
}

describe('POST /api/plans/[planId]/attendance', () => {
  it('escribe el estado en la base, no solo en la respuesta', async () => {
    const hildaC = await loginAs(hilda.email)
    const res = await marcar(hildaC, planTerminado.id, ana.id, 'ATTENDED')

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ userId: ana.id, status: 'ATTENDED', cambio: true })
    // La fila de verdad. Si esto falla, el endpoint miente.
    expect(await estadoEnBase(planTerminado.id, ana.id)).toBe('ATTENDED')
  })

  it('deja el NO_SHOW escrito igual, y el denominador de la reliability sigue contando', async () => {
    const hildaC = await loginAs(hilda.email)
    expect((await marcar(hildaC, planTerminado.id, beto.id, 'NO_SHOW')).status).toBe(200)

    expect(await estadoEnBase(planTerminado.id, beto.id)).toBe('NO_SHOW')
    // Marcar no libera el lugar: un NO_SHOW ocupaba el mismo lugar que un
    // ACCEPTED. Si esto se moviera, la regla de cupo tendria dos fuentes de
    // verdad.
    const [conteo] = await rawQuery<{ acceptedCount: number }>(
      `SELECT "acceptedCount" FROM "Plan" WHERE id = $1`,
      [planTerminado.id],
    )
    expect(Number(conteo.acceptedCount)).toBe(0)
  })

  it('corregir un NO_SHOW a ATTENDED esta permitido y no rompe nada', async () => {
    const hildaC = await loginAs(hilda.email)
    await marcar(hildaC, planTerminado.id, beto.id, 'NO_SHOW')
    const correction = await marcar(hildaC, planTerminado.id, beto.id, 'ATTENDED')

    expect(correction.status).toBe(200)
    expect(correction.body).toMatchObject({ status: 'ATTENDED', cambio: true })
    expect(await estadoEnBase(planTerminado.id, beto.id)).toBe('ATTENDED')
  })

  it('re-marcar lo mismo responde que no cambio, y no rompe', async () => {
    const hildaC = await loginAs(hilda.email)
    await marcar(hildaC, planTerminado.id, ana.id, 'ATTENDED')
    const otra = await marcar(hildaC, planTerminado.id, ana.id, 'ATTENDED')

    // Idempotente: la pantalla no tiene que recargar ni estañar el error, y el
    // toque repetido de un doble clic no puede ser un fallo.
    expect(otra.status).toBe(200)
    expect(otra.body).toMatchObject({ status: 'ATTENDED', cambio: false })
  })

  it('el organizador se marca a si mismo, y organiza tambien se asiste', async () => {
    const hildaC = await loginAs(hilda.email)
    const res = await marcar(hildaC, planTerminado.id, hilda.id, 'ATTENDED')

    expect(res.status).toBe(200)
    expect(await estadoEnBase(planTerminado.id, hilda.id)).toBe('ATTENDED')
  })
})

describe('quien puede marcar', () => {
  it('un participante no puede marcar a otro', async () => {
    const anaC = await loginAs(ana.email)
    const res = await marcar(anaC, planTerminado.id, beto.id, 'NO_SHOW')

    expect(res.status).toBe(403)
    expect(await estadoEnBase(planTerminado.id, beto.id)).toBe('ACCEPTED')
  })

  it('alguien de afuera no puede marcar, ni a un participante', async () => {
    const carla = await createUser({ email: 'carla@example.com', passwordHash: await hashPassword(PASSWORD) })
    const carlaC = await loginAs(carla.email)
    const res = await marcar(carlaC, planTerminado.id, ana.id, 'NO_SHOW')

    expect(res.status).toBe(403)
    expect(await estadoEnBase(planTerminado.id, ana.id)).toBe('ACCEPTED')
  })

  it('un REQUESTED no se puede marcar, porque nunca tuvo lugar', async () => {
    // Es el error mas caro del sistema si pasa: quedaria un ATTENDED de alguien
    // que nunca estuvo, y la reliability contaria como un plan que ocurrio algo
    // que no ocurrio.
    const nora = await createUser({ email: 'nora@example.com', passwordHash: await hashPassword(PASSWORD) })
    await joinPlan({ planId: planTerminado.id, userId: nora.id, status: 'REQUESTED' })
    const hildaC = await loginAs(hilda.email)

    const res = await marcar(hildaC, planTerminado.id, nora.id, 'ATTENDED')
    expect(res.status).toBe(409)
    expect(await estadoEnBase(planTerminado.id, nora.id)).toBe('REQUESTED')
  })

  it('no se puede volver a ACCEPTED: seria decir "no se"', async () => {
    const hildaC = await loginAs(hilda.email)
    const res = await hildaC.post(`/api/plans/${planTerminado.id}/attendance`, {
      userId: ana.id,
      attendance: 'ACCEPTED',
    })

    expect(res.status).toBe(400)
    expect(await estadoEnBase(planTerminado.id, ana.id)).toBe('ACCEPTED')
  })

  it('no se puede marcar a alguien que no esta en el plan', async () => {
    const hildaC = await loginAs(hilda.email)
    const res = await marcar(hildaC, planTerminado.id, '11111111-1111-1111-1111-111111111111', 'ATTENDED')

    expect(res.status).toBe(404)
  })
})

describe('cuando se puede marcar', () => {
  it('un plan que todavia no empezo no se puede marcar', async () => {
    await joinPlan({ planId: planFuturo.id, userId: ana.id, status: 'ACCEPTED' })
    const hildaC = await loginAs(hilda.email)

    const res = await marcar(hildaC, planFuturo.id, ana.id, 'ATTENDED')
    expect(res.status).toBe(403)
    expect(await estadoEnBase(planFuturo.id, ana.id)).toBe('ACCEPTED')
  })

  it('un plan CANCELLED no se puede marcar, aunque ya haya pasado la hora', async () => {
    // La cancelacion es la unica fuente de verdad de "no va": un plan que el
    // organizador cancelo no genera asistencia, y "no vino" seria falso.
    const cancelado = await createPlan({
      placeId: place.id,
      creatorId: hilda.id,
      startsAt: HACE_UN_RATO(),
      status: 'CANCELLED',
    })
    await joinPlan({ planId: cancelado.id, userId: ana.id, status: 'ACCEPTED' })
    const hildaC = await loginAs(hilda.email)

    const res = await marcar(hildaC, cancelado.id, ana.id, 'ATTENDED')
    expect(res.status).toBe(403)
    expect(await estadoEnBase(cancelado.id, ana.id)).toBe('ACCEPTED')
  })

  it('con endsAt futura todavia no se puede, aunque el plan ya empezo', async () => {
    // El caso que `startsAt` sola no cubre: el plan empezo pero no termino. Si
    // el gate mirara solo `startsAt`, se podria marcar asistencia de un plan que
    // todavia esta pasando y la lista quedaria mal a mitad de camino.
    const enCurso = await createPlan({
      placeId: place.id,
      creatorId: hilda.id,
      startsAt: HACE_UN_RATO(),
      endsAt: new Date(Date.now() + 3_600_000),
    })
    await joinPlan({ planId: enCurso.id, userId: ana.id, status: 'ACCEPTED' })
    const hildaC = await loginAs(hilda.email)

    const res = await marcar(hildaC, enCurso.id, ana.id, 'ATTENDED')
    expect(res.status).toBe(403)
    expect(await estadoEnBase(enCurso.id, ana.id)).toBe('ACCEPTED')
  })

  it('con endsAt pasada si se puede, aunque startsAt siga en el futuro', async () => {
    // El caso raro y por eso esta: un plan con `endsAt` en el pasado esta
    // terminado segun la regla de `lib/plan-finished.ts`. Si en vez de esa
    // funcion el gate mirara `startsAt <= now`, aca rechazaria.
    const raro = await createPlan({
      placeId: place.id,
      creatorId: hilda.id,
      startsAt: new Date(Date.now() + 86_400_000),
      endsAt: HACE_UN_RATO(),
    })
    await joinPlan({ planId: raro.id, userId: ana.id, status: 'ACCEPTED' })
    const hildaC = await loginAs(hilda.email)

    const res = await marcar(hildaC, raro.id, ana.id, 'ATTENDED')
    expect(res.status).toBe(200)
    expect(await estadoEnBase(raro.id, ana.id)).toBe('ATTENDED')
  })
})

describe('sesion y payload', () => {
  it('sin sesion es 401', async () => {
    const anon = new Client()
    const res = await marcar(anon, planTerminado.id, ana.id, 'ATTENDED')
    expect(res.status).toBe(401)
  })

  it('un plan inexistente es 404, no 403', async () => {
    const hildaC = await loginAs(hilda.email)
    const res = await marcar(hildaC, '11111111-1111-1111-1111-111111111111', ana.id, 'ATTENDED')
    expect(res.status).toBe(404)
  })

  it('un payload raro es 400 y no toca nada', async () => {
    const hildaC = await loginAs(hilda.email)
    for (const body of [
      {},
      { userId: ana.id },
      { attendance: 'ATTENDED' },
      { userId: ana.id, attendance: 'WALKED_IN' },
      { userId: ana.id, attendance: 'attended' },
      { userId: ana.id, attendance: 'ATTENDED', extra: 1 },
    ]) {
      const res = await hildaC.post(`/api/plans/${planTerminado.id}/attendance`, body)
      expect(res.status, `payload ${JSON.stringify(body)}`).toBe(400)
    }
    expect(await estadoEnBase(planTerminado.id, ana.id)).toBe('ACCEPTED')
  })
})

/**
 * El circuito completo, que es lo que no tenia el proyecto antes: marcar aqui,
 * y que la fila exista para lo que la pantalla y la reliability van a leer.
 *
 * No es una prueba de endpoint: es la prueba de que el productor existe.
 */
describe('el productor de ATTENDED y NO_SHOW', () => {
  it('deja datos que la reliability puede leer, no solo un 200', async () => {
    const hildaC = await loginAs(hilda.email)
    await marcar(hildaC, planTerminado.id, ana.id, 'ATTENDED')
    await marcar(hildaC, planTerminado.id, beto.id, 'NO_SHOW')

    // La misma consulta que arma la reliability del organizador (§5.9): cuenta
    // de los dos estados. Antes de este endpoint, estos numeros solo aparecian en
    // los tests, sembrados a mano por SQL crudo.
    const [{ total }] = await rawQuery<{ total: number }>(
      `SELECT count(*)::int AS total FROM "PlanParticipant"
       WHERE "planId" = $1 AND status IN ('ATTENDED', 'NO_SHOW')`,
      [planTerminado.id],
    )
    expect(total).toBe(2)

    const detalle = await getPrisma().planParticipant.findMany({
      where: { planId: planTerminado.id, status: { in: ['ATTENDED', 'NO_SHOW'] } },
      select: { userId: true, status: true },
    })
    // **Sin `orderBy` y sin asumir orden.** Los `id` de los fixtures son
    // `gen_random_uuid()`, o sea el orden por `userId` es distinto en cada
    // corrida: la primera version de este assert ordenaba por `userId` y fallo
    // en la suite completa despues de haber pasado en solitario. Un test
    // intermitente por el fixture, no por el codigo, es un test que hay que
    // arreglar antes que leer.
    expect(detalle).toHaveLength(2)
    expect(detalle).toEqual(
      expect.arrayContaining([
        { userId: ana.id, status: 'ATTENDED' },
        { userId: beto.id, status: 'NO_SHOW' },
      ]),
    )
  })
})
