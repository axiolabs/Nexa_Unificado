import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { hashPassword } from '../../lib/auth/password'
import { getPrisma } from '../../lib/db'
import { sembrarTestV1 } from '../../prisma/personality-v1.mjs'
import { Client } from '../helpers/http'
import {
  addRole,
  closeDb,
  createPlace,
  createPlan,
  createUser,
  rawQuery,
  resetDb,
} from '../helpers/db'

/**
 * El detalle de un plan EXIGE SESION para verse. El mapa es publico; el plan
 * no. La razon esta escrita en el route handler y la regla de oro aca es: si
 * esto se relaja, se filtra la agenda social de gente que no publico nada.
 *
 * Los tests de abajo hacen las dos mitades:
 *   1. Sin sesion, 401. Ni siquiera un plan inventado se distingue.
 *   2. Con sesion, los datos del plan son correctos y no incluyen de mas.
 */

const PASSWORD = 'correcto-caballo-grapa-42'
const BA = '-58.50,-34.65,-58.30,-34.55'

let ana: { id: string; email: string }
let beto: { id: string; email: string }
/** Carla no esta en ningun plan. Existe para probar `join` con alguien que
 *  REALLY no participaba: si el que intenta unirse ya esta ACCEPTED, el 409 lo
 *  produce el PK compuesto y el test pasa aunque el lugar este perfectamente
 *  disponible. */
let carla: { id: string; email: string }
let place: { id: string }
let plan: { id: string }

beforeEach(async () => {
  await resetDb()
  const passwordHash = await hashPassword(PASSWORD)
  ana = await createUser({ email: 'ana@example.com', name: 'Ana Ruiz', passwordHash, roles: ['USER'] })
  beto = await createUser({ email: 'beto@example.com', name: 'Beto Diaz', passwordHash, roles: ['USER'] })
  carla = await createUser({ email: 'carla@example.com', name: 'Carla Gomez', passwordHash, roles: ['USER'] })
  place = await createPlace({ name: 'Cafe Tortuga', lat: -34.6037, lng: -58.3816 })
  plan = await createPlan({ placeId: place.id, creatorId: ana.id, capacity: 2, acceptedCount: 1 })
})

afterAll(async () => {
  await closeDb()
})

async function anaClient() {
  const c = new Client()
  expect((await c.login(ana.email, PASSWORD)).status).toBe(200)
  return c
}

async function betoClient() {
  const c = new Client()
  expect((await c.login(beto.email, PASSWORD)).status).toBe(200)
  return c
}

async function carlaClient() {
  const c = new Client()
  expect((await c.login(carla.email, PASSWORD)).status).toBe(200)
  return c
}

/** El status del detalle, para no repetir el await anidado en cada asercion. */
async function statusDe(client: Promise<Client>, planId: string): Promise<number> {
  return (await (await client).get(`/api/plans/${planId}`)).status
}

describe('GET /api/plans/[planId]', () => {
  it('sin sesion responde 401, no el plan', async () => {
    const res = await new Client().get(`/api/plans/${plan.id}`)
    expect(res.status).toBe(401)
    // Y el cuerpo no puede contener los datos que protege.
    expect(res.text).not.toContain('Plan de prueba')
  })

  it('sin sesion responde 401 tambien para un plan inexistente', async () => {
    // Si el inexistente diera 404 y el existente 401, el status code confirmaria
    // que el plan existe. El orden de los chequeos es informacion.
    const res = await new Client().get('/api/plans/no-existe-este-id')
    expect(res.status).toBe(401)
  })

  it('con sesion devuelve el detalle', async () => {
    const res = await (await anaClient()).get(`/api/plans/${plan.id}`)
    expect(res.status).toBe(200)
    const body = res.body as { plan: Record<string, unknown> }
    expect(body.plan.id).toBe(plan.id)
    expect(body.plan.title).toBe('Plan de prueba')
  })

  it('un plan inexistente con sesion da 404', async () => {
    const res = await (await anaClient()).get('/api/plans/no-existe-este-id')
    expect(res.status).toBe(404)
  })

  it('un plan borrado logicamente da 404', async () => {
    await createPlan({ placeId: place.id, creatorId: ana.id, deleted: true })
    const targets = await rawQuery<{ id: string }>(
      'SELECT id FROM "Plan" WHERE "deletedAt" IS NOT NULL',
    )
    const res = await (await anaClient()).get(`/api/plans/${targets[0].id}`)
    expect(res.status).toBe(404)
  })

  it('las coordenadas del lugar llegan como numero', async () => {
    const res = await (await anaClient()).get(`/api/plans/${plan.id}`)
    const body = res.body as { plan: { place: { latitude: unknown; longitude: unknown } } }
    expect(typeof body.plan.place.latitude).toBe('number')
    expect(typeof body.plan.place.longitude).toBe('number')
  })

  it('la lista de participantes no incluye emails', async () => {
    const res = await (await anaClient()).get(`/api/plans/${plan.id}`)
    // Con sesion se ven nombres, no emails. El email es el dato que permite
    // pasar de "alguien va" a "esta persona concretamente tiene esta cuenta".
    expect(res.text).not.toContain(ana.email)
    expect(res.text).not.toContain(beto.email)
  })

  it('suspender la cuenta corta el acceso al detalle aunque la cookie sea valida', async () => {
    const c = await anaClient()
    expect((await c.get(`/api/plans/${plan.id}`)).status).toBe(200)

    await rawQuery('UPDATE "User" SET "suspendedAt" = now() WHERE id = $1', [ana.id])

    expect((await c.get(`/api/plans/${plan.id}`)).status).toBe(403)
  })

  it('el detalle NO lleva la reliability de los participantes', async () => {
    // El detalle lo ve cualquier usuario con sesion. Si apareciera la tasa de
    // presentismo de cada uno, el historial de plantones de terceros se leaky
    // por una API que no deberia exponerlo. La reliability vive solo en
    // /requests, que exige ser el organizador.
    const carmen = await createUser({
      email: 'carmen@example.com',
      name: 'Carmen Diaz',
      passwordHash: await hashPassword(PASSWORD),
      roles: ['USER'],
    })
    const c = new Client()
    await c.login(carmen.email, PASSWORD)
    await c.post(`/api/plans/${plan.id}/join`, {})

    const res = await (await anaClient()).get(`/api/plans/${plan.id}`)
    expect(res.status).toBe(200)
    expect(res.text).not.toContain('showUpRate')
    expect(res.text).not.toContain('noShow')
    expect(res.text).not.toContain('reliability')
  })

  /**
   * La asimetria detalle/listado.
   *
   * El listado ya traia `viewer` y el detalle no. Antes, la unica forma de
   * saber si uno ya habia pedido era hacer el POST y leer el 409, es decir, una
   * accion con efecto secundario para averiguar un estado. Estos tests fijan que
   * el detalle lo dice de entrada, igual que el listado.
   */
  describe('el detalle sabe quien mira', () => {
    it('un usuario que no pidio nada ve participation null', async () => {
      const res = await (await anaClient()).get(`/api/plans/${plan.id}`)
      const body = res.body as { plan: { viewer: Record<string, unknown> } }
      expect(body.plan.viewer).toEqual({ isCreator: true, participation: null })
    })

    it('el creador se reconoce como creador', async () => {
      const res = await (await betoClient()).get(`/api/plans/${plan.id}`)
      const body = res.body as { plan: { viewer: { isCreator: boolean } } }
      expect(body.plan.viewer.isCreator).toBe(false)
    })

    it('el que pidio unirse ve SU participacion, no la de otro', async () => {
      // Carla pide, y a partir de ahi el detalle tiene que mostrarle su propio
      // estado. Es el caso que la pagina de detalle necesita para pintar
      // "esperando aprobacion" sin preguntar por un lado con un POST.
      const c = await carlaClient()
      expect((await c.post(`/api/plans/${plan.id}/join`, {})).status).toBe(201)

      const res = await c.get(`/api/plans/${plan.id}`)
      const body = res.body as { plan: { viewer: { isCreator: boolean; participation: unknown } } }
      expect(body.plan.viewer.isCreator).toBe(false)
      expect(body.plan.viewer.participation).toEqual({
        status: 'REQUESTED',
        role: 'PARTICIPANT',
      })
    })

    it('la participacion no filtra la de terceros: Ana es ORGANIZER y Carla pide', async () => {
      // El fixture `createPlan` pone `acceptedCount: 1` pero NO crea la fila de
      // `PlanParticipant`: el contador queda mintiendo hasta que alguien la
      // crea. Por eso esta se inserta a mano: el detalle arma la lista de
      // confirmados desde `PlanParticipant`, no desde el contador.
      await rawQuery(
        `INSERT INTO "PlanParticipant" ("planId", "userId", role, status, "joinedAt")
         VALUES ($1, $2, 'ORGANIZER', 'ACCEPTED', now())`,
        [plan.id, ana.id],
      )

      const c = await carlaClient()
      await c.post(`/api/plans/${plan.id}/join`, {})

      // Ana mira el plan: su `viewer.participation` es el suyo propio, no el de
      // Carla, aunque Carla este REQUESTED en este mismo plan.
      const res = await (await anaClient()).get(`/api/plans/${plan.id}`)
      const body = res.body as {
        plan: { viewer: { participation: unknown }; participants: unknown[] }
      }
      expect(body.plan.viewer.participation).toEqual({ status: 'ACCEPTED', role: 'ORGANIZER' })
      // La lista de confirmados trae a Ana y solo a Ana. Carla esta REQUESTED, y
      // un REQUESTED todavia no se sabe si va: no figura.
      expect(body.plan.participants).toHaveLength(1)
      expect(res.text).not.toContain('Carla Gomez')
    })

    it('el cupo llega como remainingSpots e isFull, igual que el listado', async () => {
      const res = await (await anaClient()).get(`/api/plans/${plan.id}`)
      const body = res.body as {
        plan: { capacity: number; acceptedCount: number; remainingSpots: number; isFull: boolean }
      }
      expect(body.plan.capacity).toBe(2)
      expect(body.plan.acceptedCount).toBe(1)
      expect(body.plan.remainingSpots).toBe(1)
      expect(body.plan.isFull).toBe(false)
    })

    it('un plan lleno se marca isFull y remainingSpots 0', async () => {
      await rawQuery('UPDATE "Plan" SET "acceptedCount" = $1 WHERE id = $2', [2, plan.id])
      const res = await (await anaClient()).get(`/api/plans/${plan.id}`)
      const body = res.body as { plan: { remainingSpots: number; isFull: boolean } }
      expect(body.plan.remainingSpots).toBe(0)
      expect(body.plan.isFull).toBe(true)
    })
  })

  /**
   * El segundo hueco, del mismo tipo: el detalle no aplicaba el filtro de
   * visibilidad por lugar. Un plan cuyo lugar dejo de estar visible se
   * escondia del listado pero se abria por URL, con el boton de unirse pintado.
   */
  describe('el detalle no muestra planes de lugares que ya no se ven', () => {
    it('un plan en un lugar desactivado da 404 por URL, no solo desaparece del mapa', async () => {
      await rawQuery('UPDATE "Place" SET "isActive" = false WHERE id = $1', [place.id])
      // Carla no organizo ni participo: para ella el plan es descubrimiento puro
      // y tiene que desaparecer con el lugar.
      const res = await (await carlaClient()).get(`/api/plans/${plan.id}`)
      expect(res.status).toBe(404)
    })

    it('un plan en un lugar REJECTED da 404 para un usuario normal', async () => {
      await rawQuery('UPDATE "Place" SET "verificationStatus" = $1 WHERE id = $2', [
        'REJECTED',
        place.id,
      ])
      const res = await (await betoClient()).get(`/api/plans/${plan.id}`)
      expect(res.status).toBe(404)
    })

    it('un plan en un lugar PENDING da 404 para un usuario normal', async () => {
      // El detalle tiene que seguir la MISMA regla que el listado, no una mas
      // laxa: si el listado oculta el PENDING, el detalle tambien.
      await rawQuery('UPDATE "Place" SET "verificationStatus" = $1 WHERE id = $2', [
        'PENDING',
        place.id,
      ])
      expect(await statusDe(carlaClient(), plan.id)).toBe(404)
    })

    it('un curador SI puede abrir el de un lugar PENDING, igual que lo ve en el listado', async () => {
      // Al reves: si el filtro fuera mas estricto que el del listado, el curador
      // veria el plan en el mapa y el link le daria 404. Coincidir es el punto.
      await rawQuery('UPDATE "Place" SET "verificationStatus" = $1 WHERE id = $2', [
        'PENDING',
        place.id,
      ])
      const curador = await createUser({
        email: 'curador@example.com',
        name: 'Cora Diaz',
        passwordHash: await hashPassword(PASSWORD),
        roles: ['USER', 'CURATOR'],
      })
      const c = new Client()
      await c.login(curador.email, PASSWORD)
      expect((await c.get(`/api/plans/${plan.id}`)).status).toBe(200)
    })

    it('un lugar desactivado le da 404 al curador tambien: la circulacion esta fuera', async () => {
      await rawQuery('UPDATE "Place" SET "isActive" = false WHERE id = $1', [place.id])
      const curador = await createUser({
        email: 'curador2@example.com',
        name: 'Ciro Diaz',
        passwordHash: await hashPassword(PASSWORD),
        roles: ['USER', 'CURATOR'],
      })
      const c = new Client()
      await c.login(curador.email, PASSWORD)
      expect((await c.get(`/api/plans/${plan.id}`)).status).toBe(404)
    })
  })

  /**
   * La excepcion de §12: el lugar dejo de estar disponible, pero el plan sigue.
   *
   * Sin esto, el filtro de visibilidad hace que el organizador y los confirmados
   * pierdan el detalle de su propio plan. La URL guardada daria 404, igual que si
   * el plan nunca hubiera existido: el mismo dano que cancelar, pero en silencio.
   */
  describe('la excepcion de quien ya esta adentro', () => {
    /** Deja a alguien ACCEPTED sin pasar por el endpoint de aprobacion. */
    async function accept(userId: string, who: 'organizer' | 'participant' = 'participant') {
      await rawQuery(
        `INSERT INTO "PlanParticipant" ("planId", "userId", role, status, "joinedAt", "respondedAt")
         VALUES ($1, $2, $3, 'ACCEPTED', now(), now())`,
        [plan.id, userId, who === 'organizer' ? 'ORGANIZER' : 'PARTICIPANT'],
      )
      await rawQuery('UPDATE "Plan" SET "acceptedCount" = 2 WHERE id = $1', [plan.id])
    }

    async function rejectPlace() {
      await rawQuery('UPDATE "Place" SET "verificationStatus" = $1 WHERE id = $2', [
        'REJECTED',
        place.id,
      ])
    }

    it('el organizador conserva el detalle aunque el lugar se caiga', async () => {
      await rejectPlace()
      const res = await (await anaClient()).get(`/api/plans/${plan.id}`)
      expect(res.status).toBe(200)
      const body = res.body as { plan: { id: string; viewer: { isCreator: boolean } } }
      expect(body.plan.id).toBe(plan.id)
      expect(body.plan.viewer.isCreator).toBe(true)
    })

    it('un CONFIRMADO conserva el detalle aunque el lugar se caiga', async () => {
      await accept(beto.id)
      await rejectPlace()
      const res = await (await betoClient()).get(`/api/plans/${plan.id}`)
      expect(res.status).toBe(200)
      const body = res.body as { plan: { viewer: { participation: unknown } } }
      expect(body.plan.viewer.participation).toEqual({
        status: 'ACCEPTED',
        role: 'PARTICIPANT',
      })
    })

    it('un ATTENDED tambien: estuvo en el plan, no es menos parte', async () => {
      await accept(beto.id)
      await rawQuery('UPDATE "PlanParticipant" SET status = $1 WHERE "planId" = $2', [
        'ATTENDED',
        plan.id,
      ])
      await rejectPlace()
      expect(await statusDe(betoClient(), plan.id)).toBe(200)
    })

    it('quien solo PIDIO no alcanza: la excepcion es para el que entro', async () => {
      // Beto pide y queda REQUESTED. No tiene lugar guardado todavia, asi que
      // sigue el filtro del mapa. Y no es una piedad artificial: al join lo
      // habria rechazado el mismo filtro, con el 409 de §12.
      const c = await betoClient()
      expect((await c.post(`/api/plans/${plan.id}/join`, {})).status).toBe(201)
      await rejectPlace()
      expect((await c.get(`/api/plans/${plan.id}`)).status).toBe(404)
    })

    it('un DECLINED tampoco alcanza', async () => {
      await accept(beto.id)
      await rawQuery('UPDATE "PlanParticipant" SET status = $1 WHERE "planId" = $2', [
        'DECLINED',
        plan.id,
      ])
      await rejectPlace()
      expect(await statusDe(betoClient(), plan.id)).toBe(404)
    })

    it('un NO_SHOW tampoco: el que fallo una vez pierde el acceso', async () => {
      // Decision, no olvido. `NO_SHOW` sigue siendo un exito de la reliability
      // del organizador, y §13.5 deja esa pantalla en `/requests`, que tiene su
      // propio corte. Este detalle es descubrimiento; el planton se mira ahi.
      await accept(beto.id)
      await rawQuery('UPDATE "PlanParticipant" SET status = $1 WHERE "planId" = $2', [
        'NO_SHOW',
        plan.id,
      ])
      await rejectPlace()
      expect(await statusDe(betoClient(), plan.id)).toBe(404)
    })

    it('la excepcion no filtra el plan a los que no participan', async () => {
      // El riesgo de un `OR` como este es que la exception se/contamine: que
      // ver el plan de uno lo vuelva visible para todos. Carla pide SOLO para
      // poder comprobar que sigue sin verlo.
      await accept(beto.id)
      await rejectPlace()
      expect(await statusDe(carlaClient(), plan.id)).toBe(404)
    })

    it('la excepcion sobrevive a un lugar DESACTIVADO, no solo a un REJECTED', async () => {
      await accept(beto.id)
      await rawQuery('UPDATE "Place" SET "isActive" = false WHERE id = $1', [place.id])
      expect(await statusDe(betoClient(), plan.id)).toBe(200)
      expect(await statusDe(anaClient(), plan.id)).toBe(200)
    })

    it('y no abre la puerta a un plan BORRADO logicamente', async () => {
      // La excepcion es sobre el LUGAR, no sobre el plan. Un plan borrado sigue
      // borrado para todos, incluido el organizador: si no, el filtro de
      // `deletedAt` se podria anular por la rama de la exception.
      await accept(beto.id)
      await rejectPlace()
      await rawQuery('UPDATE "Plan" SET "deletedAt" = now() WHERE id = $1', [plan.id])
      expect(await statusDe(betoClient(), plan.id)).toBe(404)
      expect(await statusDe(anaClient(), plan.id)).toBe(404)
    })

    it('un lugar PENDING NO abre la puerta a los que no invirtieron, como cualquier otro', async () => {
      // El filtro `visiblePlaceWhere` deja pasar PENDING a los curadores y no a
      // los USER. Beto es USER, asi que sin la exception no lo veria.
      await rawQuery('UPDATE "Place" SET "verificationStatus" = $1 WHERE id = $2', [
        'PENDING',
        place.id,
      ])
      expect(await statusDe(betoClient(), plan.id)).toBe(404)
    })

    it('pero a un CONFIRMADO si, porque un plan en PENDING solo puede ser un lugar degradado', async () => {
      // La exception no mira el motivo por el que el lugar no es visible: mira si
      // la persona esta adentro. Y hay una razon de fondo para que eso no sea un
      // agujero: un plan no se puede crear en un lugar que no sea APPROVED, asi
      // que la unica forma de que exista un plan en un lugar PENDING es que el
      // lugar estuviera APPROVED y lo bajaran. O sea, es el mismo caso que
      // REJECTED -- degradado despues -- y no un lugar nunca aprobado.
      await accept(beto.id)
      await rawQuery('UPDATE "Place" SET "verificationStatus" = $1 WHERE id = $2', [
        'PENDING',
        place.id,
      ])
      expect(await statusDe(betoClient(), plan.id)).toBe(200)
      // Y el que no participo sigue sin verlo, en el mismo estado del lugar.
      expect(await statusDe(carlaClient(), plan.id)).toBe(404)
    })
  })
})

describe('POST /api/plans', () => {
  const body = () => ({
    title: 'Cafe con strangers',
    placeId: place.id,
    startsAt: new Date(Date.now() + 86_400_000).toISOString(),
    capacity: 4,
  })

  it('sin sesion responde 401', async () => {
    const res = await new Client().post('/api/plans', body())
    expect(res.status).toBe(401)
  })

  it('un USER sin rol HOST responde 403', async () => {
    const res = await (await anaClient()).post('/api/plans', body())
    expect(res.status).toBe(403)
  })

  it('con rol HOST crea el plan con 201', async () => {
    await addRole(ana.id, 'HOST')
    const res = await (await anaClient()).post('/api/plans', body())
    expect(res.status).toBe(201)
  })

  it('el creador queda como ORGANIZER y el contador arranca en 1', async () => {
    await addRole(ana.id, 'HOST')
    const res = await (await anaClient()).post('/api/plans', body())
    const created = (res.body as { plan: { id: string } }).plan

    const rows = await rawQuery<{ role: string; status: string }>(
      'SELECT role, status FROM "PlanParticipant" WHERE "planId" = $1',
      [created.id],
    )
    expect(rows).toHaveLength(1)
    // ORGANIZER, no HOST: son enums distintos. Ver la nota en el route handler.
    expect(rows[0].role).toBe('ORGANIZER')
    expect(rows[0].status).toBe('ACCEPTED')

    const planRow = await rawQuery<{ acceptedCount: number }>(
      'SELECT "acceptedCount" FROM "Plan" WHERE id = $1',
      [created.id],
    )
    expect(planRow[0].acceptedCount).toBe(1)
  })

  it('el invariante acceptedCount = COUNT(ACCEPTED|ATTENDED) se cumple al crear', async () => {
    // Este es el chequeo que pide el spec (modelo-datos.md 8, riesgo del
    // contador desnormalizado). Con `acceptedCount: 1` hardcodeado en el create
    // y un participante ACCEPTED creado en la misma transaccion, los dos numeros
    // tienen que coincidir desde el primer instante.
    //
    // Si alguna vez el create inserta al organizador y el contador no lo sigue
    // (o al reves), el invariante se rompe aqui y no cuando alguien intente
    // llenar el plan, que es cuando ya hay gente con planes tomadas.
    await addRole(ana.id, 'HOST')
    const res = await (await anaClient()).post('/api/plans', body())
    const created = (res.body as { plan: { id: string } }).plan

    const rows = await rawQuery<{ acceptedCount: number; real: number }>(
      `SELECT p."acceptedCount"::int AS "acceptedCount",
              COUNT(pp."userId")::int AS real
         FROM "Plan" p
         JOIN "PlanParticipant" pp ON pp."planId" = p.id AND pp.status IN ('ACCEPTED','ATTENDED')
        WHERE p.id = $1
        GROUP BY p."acceptedCount"`,
      [created.id],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].acceptedCount).toBe(rows[0].real)
  })

  it('no se puede crear un plan en un lugar desactivado o borrado logicamente', async () => {
    // La misma regla que en `join`, y por el mismo motivo: son tres banderas
    // (`verificationStatus`, `isActive`, `deletedAt`) que se mueven por
    // separado y es facil cubrir dos y olvidar la tercera.
    await addRole(ana.id, 'HOST')
    for (const sql of [
      `UPDATE "Place" SET "isActive" = false WHERE id = $1`,
      `UPDATE "Place" SET "deletedAt" = now() WHERE id = $1`,
    ]) {
      await rawQuery(sql, [place.id])
      const res = await (await anaClient()).post('/api/plans', body())
      expect(res.status, sql).toBe(404)
      await rawQuery(`UPDATE "Place" SET "isActive" = true, "deletedAt" = NULL WHERE id = $1`, [place.id])
    }
  })

  it('no se puede crear un plan en un lugar PENDING', async () => {
    const { id } = await createPlace({
      name: 'Lugar Sin Revisar',
      lat: -34.6,
      lng: -58.38,
      verificationStatus: 'PENDING',
    })
    await addRole(ana.id, 'HOST')
    const res = await (await anaClient()).post('/api/plans', { ...body(), placeId: id })
    expect(res.status).toBe(404)
  })

  it('no se puede crear un plan en un lugar inexistente', async () => {
    await addRole(ana.id, 'HOST')
    const res = await (await anaClient()).post('/api/plans', { ...body(), placeId: 'no-existe' })
    expect(res.status).toBe(404)
  })

  it('rechaza una capacidad de 1', async () => {
    await addRole(ana.id, 'HOST')
    const res = await (await anaClient()).post('/api/plans', { ...body(), capacity: 1 })
    expect(res.status).toBe(400)
  })

  it('rechaza una fecha de inicio en el pasado', async () => {
    await addRole(ana.id, 'HOST')
    const res = await (await anaClient()).post('/api/plans', {
      ...body(),
      startsAt: new Date(Date.now() - 86_400_000).toISOString(),
    })
    expect(res.status).toBe(400)
  })

  it('rechaza un plan sin lugar: no hay planes virtuales', async () => {
    await addRole(ana.id, 'HOST')
    const { placeId: _omit, ...sinLugar } = body()
    const res = await (await anaClient()).post('/api/plans', sinLugar)
    expect(res.status).toBe(400)
  })

  it('un CURATOR tampoco puede crear un plan en un lugar PENDING', async () => {
    // El rol da VISIBILIDAD, no permiso. Un curador ve los PENDING para
    // revisarlos, y si pudiera crear planes ahi publicaria lugares que el
    // equipo todavia no aprobo. La regla que se rompe aca es la de exposicion,
    // no la de autorizacion.
    const { id } = await createPlace({
      name: 'Lugar Sin Revisar',
      lat: -34.6,
      lng: -58.38,
      verificationStatus: 'PENDING',
    })
    await addRole(ana.id, 'HOST')
    await addRole(ana.id, 'CURATOR')
    const res = await (await anaClient()).post('/api/plans', { ...body(), placeId: id })
    expect(res.status).toBe(404)
  })

  it('el lugar se revalida DENTRO de la transaccion, no solo antes', async () => {
    // Este test no puede simular la carrera con HTTP: necesitaria cambiar el
    // estado del lugar entre el chequeo y el create, que es exactamente lo que
    // la transaccion cerrada impide hacer.
    //
    // Lo que si verifica es la garantia observable: si el lugar NO esta
    // disponible, no se crea el plan, y no queda nada a medio hacer. La
    // revalidacion interna se cubre con el mutante de `scripts/mutate-plan.mjs`.
    const { id } = await createPlace({
      name: 'Lugar Que Se Oscurece',
      lat: -34.6,
      lng: -58.38,
      verificationStatus: 'APPROVED',
    })
    await rawQuery(`UPDATE "Place" SET "verificationStatus" = 'REJECTED' WHERE id = $1`, [id])
    await addRole(ana.id, 'HOST')
    const res = await (await anaClient()).post('/api/plans', { ...body(), placeId: id })
    expect(res.status).toBe(404)

    // Y sobre todo: no quedo un plan huerfano.
    const planes = await rawQuery<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM "Plan" WHERE "placeId" = $1`,
      [id],
    )
    expect(planes[0].n).toBe(0)
  })
})

/**
 * Decision de producto: que pasa cuando un lugar deja de estar disponible con
 * planes ya creados. Ver seccion 12 de `docs/decisiones-auth.md`.
 */
describe('un lugar que deja de estar disponible', () => {
  const body = () => ({
    title: 'Plan sobre un lugar en riesgo',
    placeId: place.id,
    startsAt: new Date(Date.now() + 86_400_000).toISOString(),
    capacity: 4,
  })

  /**
   * Crea un plan con un participante ACCEPTED (Beto), como si alguien se hubiera
   * unido. Carla queda AFUERA a proposito: los tests de `join` la usan porque
   * si el que pide entrar ya esta ACCEPTED, el 409 lo produce el PK compuesto
   * y el test pasa con el lugar en cualquier estado.
   */
  async function planConGente() {
    await addRole(ana.id, 'HOST')
    const res = await (await anaClient()).post('/api/plans', body())
    const created = (res.body as { plan: { id: string } }).plan
    await rawQuery(
      `INSERT INTO "PlanParticipant" ("planId", "userId", role, status, "joinedAt")
       VALUES ($1, $2, 'PARTICIPANT', 'ACCEPTED', now())`,
      [created.id, beto.id],
    )
    await rawQuery(`UPDATE "Plan" SET "acceptedCount" = 2 WHERE id = $1`, [created.id])
    return created.id as string
  }

  /** Intenta entrar como Carla, que no participa de ningun plan. */
  async function carlaIntentaUnirse(planId: string) {
    const c = new Client()
    expect((await c.login(carla.email, PASSWORD)).status).toBe(200)
    return c.post(`/api/plans/${planId}/join`, {})
  }

  /** Filas de Carla en el plan, de cualquier estado. */
  async function filasDeCarla(planId: string) {
    return rawQuery<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM "PlanParticipant" WHERE "planId" = $1 AND "userId" = $2`,
      [planId, carla.id],
    )
  }

  it('NO cancela los planes existentes: la gente ya aceptada conserva su lugar', async () => {
    // Este es el corazon de la decision. Un plan es una promesa con horas
    // adentro y gente que se compro un lugar. Cancelarlo en silencio deja a
    // todos esos desconocidos presentados a un plan que ya no existe, y sin
    // canal de notificacion no hay forma de avisarles.
    const planId = await planConGente()
    await rawQuery(`UPDATE "Place" SET "verificationStatus" = 'REJECTED' WHERE id = $1`, [place.id])

    const planRow = await rawQuery<{ status: string; acceptedCount: number }>(
      `SELECT status, "acceptedCount"::int AS "acceptedCount" FROM "Plan" WHERE id = $1`,
      [planId],
    )
    expect(planRow[0].status).toBe('OPEN')
    expect(planRow[0].acceptedCount).toBe(2)

    // Y los participantes siguen como estaban: nadie se cae del plan por una
    // decision de curaduria.
    const parts = await rawQuery<{ status: string }>(
      `SELECT status FROM "PlanParticipant" WHERE "planId" = $1`,
      [planId],
    )
    expect(parts).toHaveLength(2)
    expect(parts.every((p) => p.status === 'ACCEPTED')).toBe(true)
  })

  it('pero tampoco se puede PEDIR entrar a un plan cuyo lugar ya no esta disponible', async () => {
    // La otra mitad, y la que hace que la curaduria signifique algo. Si el plan
    // siguiera admitiendo joiners, un lugar que fue rechazado por no cumplir
    // los criterios seguiria siendo un lugar donde se conoce gente nueva.
    const planId = await planConGente()
    await rawQuery(`UPDATE "Place" SET "verificationStatus" = 'REJECTED' WHERE id = $1`, [place.id])

    const res = await carlaIntentaUnirse(planId)
    expect(res.status).toBe(409)
    // El mensaje importa: es lo que diferencia "el lugar ya no sirve" de "el plan
    // se lleno" o "ya pediste entrar". Un 409 con cualquier texto pasaria.
    expect(res.text).toContain('lugar')
    // Y lo importante: no se escribio NADA.
    expect((await filasDeCarla(planId))[0].n).toBe(0)
  })

  it('el mismo join funciona con el lugar disponible (el 409 no es siempre igual)', async () => {
    // Control negativo del test anterior. Si este falla, el 409 de arriba no
    // venia del lugar y el test no demuestra lo que dice demostrar.
    const planId = await planConGente()
    const res = await carlaIntentaUnirse(planId)
    expect(res.status).toBe(201)
    expect((await filasDeCarla(planId))[0].n).toBe(1)
  })

  it('tambien corta el join si el lugar se desactiva o se borra logicamente', async () => {
    // `REJECTED` no es el unico caso: hay dos banderas mas que hacen el mismo
    // efecto y que es facil olvidar por separado.
    for (const sql of [
      `UPDATE "Place" SET "isActive" = false WHERE id = $1`,
      `UPDATE "Place" SET "deletedAt" = now() WHERE id = $1`,
    ]) {
      const planId = await planConGente()
      await rawQuery(sql, [place.id])

      const res = await carlaIntentaUnirse(planId)
      expect(res.status, sql).toBe(409)
      expect(res.text, sql).toContain('lugar')
      expect((await filasDeCarla(planId))[0].n, sql).toBe(0)

      await rawQuery(`UPDATE "Place" SET "isActive" = true, "deletedAt" = NULL,
                      "verificationStatus" = 'APPROVED' WHERE id = $1`, [place.id])
    }
  })

  it('un plan cuyo lugar se apago tampoco aparece en el listado', async () => {
    // El plan deja de ser descubrible sin dejar de existir. Son cosas distintas:
    // desaparece de la lista, y el link de quien ya lo tiene sigue funcionando.
    const planId = await planConGente()
    const c = await anaClient()
    const antes = await c.get(`/api/plans?bbox=${BA}`)
    expect((antes.body as { plans: { id: string }[] }).plans.map((p) => p.id)).toContain(planId)

    await rawQuery(`UPDATE "Place" SET "verificationStatus" = 'REJECTED' WHERE id = $1`, [place.id])
    const despues = await c.get(`/api/plans?bbox=${BA}`)
    expect((despues.body as { plans: { id: string }[] }).plans.map((p) => p.id)).not.toContain(planId)
  })

  it('ni en el mapa publico de lugares', async () => {
    await rawQuery(`UPDATE "Place" SET "verificationStatus" = 'REJECTED' WHERE id = $1`, [place.id])
    const res = await new Client().get(`/api/places?bbox=${BA}`)
    expect(res.status).toBe(200)
    expect((res.body as { places: { id: string }[] }).places.map((p) => p.id)).not.toContain(place.id)
  })

  it('volver a APPROVED reabre el plan sin tocar sus participantes', async () => {
    const planId = await planConGente()
    await rawQuery(`UPDATE "Place" SET "verificationStatus" = 'REJECTED' WHERE id = $1`, [place.id])
    await rawQuery(`UPDATE "Place" SET "verificationStatus" = 'APPROVED' WHERE id = $1`, [place.id])

    // Y el join vuelve a andar: no es un cierre permanente.
    const res = await carlaIntentaUnirse(planId)
    expect(res.status).toBe(201)

    const planRow = await rawQuery<{ status: string; acceptedCount: number }>(
      `SELECT status, "acceptedCount"::int AS "acceptedCount" FROM "Plan" WHERE id = $1`,
      [planId],
    )
    expect(planRow[0].status).toBe('OPEN')
    // La aceptacion de Carla no toco el contador: sigue siendo REQUESTED.
    expect(planRow[0].acceptedCount).toBe(2)
  })
})

describe('POST /api/plans/[planId]/join', () => {
  it('sin sesion responde 401', async () => {
    const res = await new Client().post(`/api/plans/${plan.id}/join`, {})
    expect(res.status).toBe(401)
  })

  it('un usuario con sesion puede pedir unirse: 201 y estado REQUESTED', async () => {
    const c = new Client()
    expect((await c.login(beto.email, PASSWORD)).status).toBe(200)

    const res = await c.post(`/api/plans/${plan.id}/join`, {})
    expect(res.status).toBe(201)
    expect((res.body as { status: string }).status).toBe('REQUESTED')
  })

  it('el creador no puede unirse a su propio plan: 400, no 500', async () => {
    const res = await (await anaClient()).post(`/api/plans/${plan.id}/join`, {})
    expect(res.status).toBe(400)
  })

  it('pedir dos veces da 409 y no duplica la fila', async () => {
    const c = new Client()
    await c.login(beto.email, PASSWORD)
    expect((await c.post(`/api/plans/${plan.id}/join`, {})).status).toBe(201)

    const again = await c.post(`/api/plans/${plan.id}/join`, {})
    expect(again.status).toBe(409)

    const rows = await rawQuery<{ n: number }>(
      'SELECT count(*)::int AS n FROM "PlanParticipant" WHERE "planId" = $1',
      [plan.id],
    )
    expect(rows[0].n).toBe(1)
  })

  it('un plan ya empezado no acepta peticiones', async () => {
    const pasado = await createPlan({
      placeId: place.id,
      creatorId: ana.id,
      startsAt: new Date(Date.now() - 3_600_000),
    })
    const c = new Client()
    await c.login(beto.email, PASSWORD)
    const res = await c.post(`/api/plans/${pasado.id}/join`, {})
    expect(res.status).toBe(409)
  })

  it('un plan cancelado no acepta peticiones', async () => {
    const cancelado = await createPlan({
      placeId: place.id,
      creatorId: ana.id,
      status: 'CANCELLED',
    })
    const c = new Client()
    await c.login(beto.email, PASSWORD)
    const res = await c.post(`/api/plans/${cancelado.id}/join`, {})
    expect(res.status).toBe(409)
  })
})

describe('el flujo de aprobacion', () => {
  /** Pide unirse y devuelve la fila creada. */
  async function request(c: Client, planId: string) {
    const res = await c.post(`/api/plans/${planId}/join`, {})
    expect(res.status).toBe(201)
    return res
  }

  it('pedir NO sube acceptedCount: la entrada la decide el organizador', async () => {
    // Este es el test que Define la diferencia entre "pedirse" y "entrar".
    // Si el contador subiera en el join, la aprobacion seria decorativa.
    const c = new Client()
    await c.login(beto.email, PASSWORD)
    await request(c, plan.id)

    const rows = await rawQuery<{ acceptedCount: number; status: string }>(
      `SELECT p."acceptedCount", pp.status
         FROM "Plan" p
         JOIN "PlanParticipant" pp ON pp."planId" = p.id
        WHERE p.id = $1 AND pp."userId" = $2`,
      [plan.id, beto.id],
    )
    expect(rows[0].status).toBe('REQUESTED')
    expect(rows[0].acceptedCount).toBe(1)
  })

  it('la peticion nace con expiresAt a 24h', async () => {
    const c = new Client()
    await c.login(beto.email, PASSWORD)
    const res = await request(c, plan.id)

    const expiresAt = (res.body as { expiresAt: string }).expiresAt
    const hours = (new Date(expiresAt).getTime() - Date.now()) / 3_600_000
    // 23.5 a 24.5: tolerate el reloj, pero confirma que el TTL existe y vale
    // un dia. Un `null` o un 0 dejarian la peticion eterna.
    expect(hours).toBeGreaterThan(23.5)
    expect(hours).toBeLessThan(24.5)
  })

  it('el plazo NUNCA sobrevive al inicio del plan', async () => {
    // `expiresAt = min(now() + 24h, plan.startsAt)`. Un plan que arranca en
    // dos horas tiene que dar un plazo de dos horas: con 24h, las solicitudes
    // quedan REQUESTED para siempre, porque un plan ya empezado no se puede
    // volver a abrir para aprobar a nadie.
    const pronto = await createPlan({
      placeId: place.id,
      creatorId: ana.id,
      startsAt: new Date(Date.now() + 2 * 3_600_000),
      capacity: 4,
    })
    const c = new Client()
    await c.login(beto.email, PASSWORD)
    const res = await c.post(`/api/plans/${pronto.id}/join`, {})
    expect(res.status).toBe(201)

    const expiresAt = new Date((res.body as { expiresAt: string }).expiresAt)
    const startsAt = new Date(pronto.startsAt.getTime())

    // El plazo cae exactamente en el inicio del plan, ni antes ni despues.
    expect(expiresAt.getTime()).toBeLessThanOrEqual(startsAt.getTime())
    expect(startsAt.getTime() - expiresAt.getTime()).toBeLessThan(5_000)
  })

  it('un plan lejano usa el TTL de 24h, no el inicio', async () => {
    const lejos = await createPlan({
      placeId: place.id,
      creatorId: ana.id,
      startsAt: new Date(Date.now() + 10 * 86_400_000),
      capacity: 4,
    })
    const c = new Client()
    await c.login(beto.email, PASSWORD)
    const res = await c.post(`/api/plans/${lejos.id}/join`, {})

    const hours = (new Date((res.body as { expiresAt: string }).expiresAt).getTime() - Date.now()) / 3_600_000
    expect(hours).toBeGreaterThan(23.5)
    expect(hours).toBeLessThan(24.5)
  })

  it('la respuesta del join avisa si el plan ya estaba lleno', async () => {
    // Pedir en un plan lleno se permite, pero avisando. Cancelar en el peor
    // momento libera el lugar para otro.
    await rawQuery('UPDATE "Plan" SET capacity = 1 WHERE id = $1', [plan.id])
    const c = new Client()
    await c.login(beto.email, PASSWORD)
    const res = await request(c, plan.id)

    const body = res.body as { planIsFull: boolean; remainingSpots: number }
    expect(body.planIsFull).toBe(true)
    expect(body.remainingSpots).toBe(0)
  })
})

describe('GET /api/plans/[planId]/requests', () => {
  it('sin sesion responde 401', async () => {
    expect((await new Client().get(`/api/plans/${plan.id}/requests`)).status).toBe(401)
  })

  it('un participante comun no ve la pantalla: 403', async () => {
    const c = new Client()
    await c.login(beto.email, PASSWORD)
    expect((await c.get(`/api/plans/${plan.id}/requests`)).status).toBe(403)
  })

  it('el organizador ve las peticiones pendientes', async () => {
    const betoClient = new Client()
    await betoClient.login(beto.email, PASSWORD)
    await betoClient.post(`/api/plans/${plan.id}/join`, {})

    const res = await (await anaClient()).get(`/api/plans/${plan.id}/requests`)
    expect(res.status).toBe(200)

    const body = res.body as {
      requests: { userId: string; hoursLeft: number; reliability: unknown }[]
      plan: { remainingSpots: number }
    }
    expect(body.requests).toHaveLength(1)
    expect(body.requests[0].userId).toBe(beto.id)
    expect(body.requests[0].hoursLeft).toBeGreaterThan(23)
    // La reliability viene siempre, aunque sea sin historial: el organizador
    // tiene que poder distinguir "sin datos" de "cero confirmados".
    expect(body.requests[0].reliability).toEqual({
      attended: 0,
      noShow: 0,
      showUpRate: null,
    })
    expect(body.plan.remainingSpots).toBe(1)
  })

  it('la reliability cuenta asistencia real de planes pasados', async () => {
    // Beto estuvo en dos planes ya ocurridos y no se presento a uno.
    const pasado = new Date(Date.now() - 86_400_000)
    for (const status of ['ATTENDED', 'ATTENDED', 'NO_SHOW'] as const) {
      const viejo = await createPlan({
        placeId: place.id,
        creatorId: ana.id,
        startsAt: pasado,
        status: 'COMPLETED',
      })
      await rawQuery(
        // PlanParticipant no tiene `id` (el PK es la compuesta
        // [planId, userId]) ni timestamps de createdAt/updatedAt: solo
        // joinedAt, respondedAt, expiresAt y reminderSentAt.
        `INSERT INTO "PlanParticipant" ("planId", "userId", role, status, "joinedAt")
         VALUES ($1, $2, 'PARTICIPANT', $3, now())`,
        [viejo.id, beto.id, status],
      )
    }

    const betoClient = new Client()
    await betoClient.login(beto.email, PASSWORD)
    await betoClient.post(`/api/plans/${plan.id}/join`, {})

    const res = await (await anaClient()).get(`/api/plans/${plan.id}/requests`)
    const body = res.body as { requests: { reliability: { attended: number; noShow: number; showUpRate: number } }[] }
    const rel = body.requests[0].reliability
    expect(rel.attended).toBe(2)
    expect(rel.noShow).toBe(1)
    expect(rel.showUpRate).toBeCloseTo(2 / 3, 5)
  })

  it('no se ven los emails de los postulantes', async () => {
    const betoClient = new Client()
    await betoClient.login(beto.email, PASSWORD)
    await betoClient.post(`/api/plans/${plan.id}/join`, {})

    const res = await (await anaClient()).get(`/api/plans/${plan.id}/requests`)
    expect(res.text).not.toContain(beto.email)
  })

  it('las peticiones vencidas se limpian y no se listan', async () => {
    const betoClient = new Client()
    await betoClient.login(beto.email, PASSWORD)
    await betoClient.post(`/api/plans/${plan.id}/join`, {})

    // El TTL dice 24h. Se simula el paso del tiempo corriendolo en la base.
    await rawQuery(
      `UPDATE "PlanParticipant"
          SET "expiresAt" = now() - interval '1 hour'
        WHERE "planId" = $1`,
      [plan.id],
    )

    const res = await (await anaClient()).get(`/api/plans/${plan.id}/requests`)
    const body = res.body as { requests: unknown[]; resolved: { accepted: number; declined: number } }
    expect(body.requests).toHaveLength(0)
  })

  /**
   * Alineacion persona <-> lugar en la pantalla de aprobaciones.
   *
   * El endpoint tiene que distinguir tres casos que en pantalla se ven
   * distinto: la persona no hizo el test, el lugar no tiene rasgos cargados, y
   * los dos tienen datos pero no encajan. Los tres viajan como `null` menos el
   * tercero, y el ultimo como un numero. Un `0` de relleno seria mentir.
   */
  describe('la alineacion con el lugar del plan', () => {
    /** Siembra la v1, que trae los 5 rasgos, y devuelve id por `key`. */
    async function rasgos() {
      const prisma = getPrisma()
      const info = await sembrarTestV1(prisma)
      const traits = await prisma.trait.findMany({ select: { id: true, key: true } })
      return { testId: info.testId, byKey: new Map(traits.map((t) => [t.key, t.id])) }
    }

    /** Le pone pesos al lugar del fixture. */
    async function pesarLugar(byKey: Map<string, string>, pesos: Record<string, number>) {
      for (const [key, weight] of Object.entries(pesos)) {
        const traitId = byKey.get(key)
        if (!traitId) throw new Error(`rasgo desconocido: ${key}`)
        await getPrisma().placeTrait.create({ data: { placeId: place.id, traitId, weight } })
      }
    }

    /** Guarda un resultado de personalidad con los puntajes dados, por `key`. */
    async function resultadoDe(
      userId: string,
      testId: string,
      byKey: Map<string, string>,
      scores: Record<string, number>,
      completedAt = new Date(),
    ) {
      const prisma = getPrisma()
      const result = await prisma.personalityResult.create({
        data: { userId, testId, completedAt },
      })
      for (const [key, value] of Object.entries(scores)) {
        const traitId = byKey.get(key)
        if (!traitId) throw new Error(`rasgo desconocido: ${key}`)
        await prisma.personalityScore.create({ data: { resultId: result.id, traitId, value } })
      }
      return result
    }

    /** Beto pide unirse y el organizador lee la pantalla. */
    async function pantallaConBetoPediendo() {
      const betoClient = new Client()
      await betoClient.login(beto.email, PASSWORD)
      expect((await betoClient.post(`/api/plans/${plan.id}/join`, {})).status).toBe(201)
      const res = await (await anaClient()).get(`/api/plans/${plan.id}/requests`)
      expect(res.status).toBe(200)
      return res.body as {
        requests: { userId: string; alineacion: { score: number; normalizado: number; traits: number } | null }[]
      }
    }

    it('es null cuando el postulante no hizo el test de personalidad', async () => {
      await rasgos()
      const body = await pantallaConBetoPediendo()
      expect(body.requests).toHaveLength(1)
      expect(body.requests[0].alineacion).toBeNull()
    })

    it('es null cuando el lugar no tiene rasgos cargados', async () => {
      const { testId, byKey } = await rasgos()
      // Beto hizo el test, pero del lugar no hay ni un peso: no hay con que
      // compararlo, y eso no es lo mismo que "no encaja".
      await resultadoDe(beto.id, testId, byKey, { nueva_gente: 2, charlas: 2 })
      const body = await pantallaConBetoPediendo()
      expect(body.requests[0].alineacion).toBeNull()
    })

    it('es null cuando la persona hizo el test pero no comparte ningun rasgo con el lugar', async () => {
      const { testId, byKey } = await rasgos()
      await pesarLugar(byKey, { nueva_gente: 0.5, charlas: 0.25 })
      await resultadoDe(beto.id, testId, byKey, { actividad: 3, improvisar: 3 })
      const body = await pantallaConBetoPediendo()
      expect(body.requests[0].alineacion).toBeNull()
    })

    it('devuelve el numero cuando hay datos de los dos lados', async () => {
      const { testId, byKey } = await rasgos()
      await pesarLugar(byKey, { nueva_gente: 0.5, charlas: 0.25 })
      // 2*0.5 + (-1)*0.25 = 0.75 de score, sobre una masa de 0.75 -> 1.0
      await resultadoDe(beto.id, testId, byKey, { nueva_gente: 2, charlas: -1 })
      const body = await pantallaConBetoPediendo()
      expect(body.requests[0].alineacion).toEqual({
        score: 0.75,
        normalizado: 1,
        traits: 2,
      })
    })

    it('descarta los rasgos que el lugar no pesa, aunque la persona los tenga', async () => {
      const { testId, byKey } = await rasgos()
      await pesarLugar(byKey, { nueva_gente: 0.5 })
      // Beto tiene 4 rasgos, el lugar solo mira 1. `traits` cuenta los
      // comparados, no los que tiene la persona.
      await resultadoDe(beto.id, testId, byKey, {
        nueva_gente: 2,
        charlas: 2,
        actividad: 2,
        improvisar: 2,
      })
      const body = await pantallaConBetoPediendo()
      expect(body.requests[0].alineacion).toEqual({ score: 1, normalizado: 2, traits: 1 })
    })

    it('usa el resultado mas reciente cuando la persona hizo el test mas de una vez', async () => {
      const prisma = getPrisma()
      const { testId, byKey } = await rasgos()
      await pesarLugar(byKey, { nueva_gente: 1 })

      // Segunda version del test, con las mismas preguntas, para poder tener dos
      // resultados del mismo usuario (el UNIQUE es [userId, testId]).
      const v1 = await prisma.personalityTest.findUniqueOrThrow({
        where: { id: testId },
        include: { questions: { include: { options: true } } },
      })
      const v2 = await prisma.personalityTest.create({
        data: {
          version: v1.version + 1,
          name: 'Personalidad v2',
          isActive: true,
          questions: {
            create: v1.questions.map((q) => ({
              order: q.order,
              prompt: q.prompt,
              traitId: q.traitId,
              options: {
                create: q.options.map((o) => ({ order: o.order, label: o.label, scoreDelta: o.scoreDelta })),
              },
            })),
          },
        },
      })

      const viejo = new Date(Date.now() - 86_400_000)
      await resultadoDe(beto.id, testId, byKey, { nueva_gente: 2 }, viejo)
      await resultadoDe(beto.id, v2.id, byKey, { nueva_gente: 1 })

      // Si tomara la vieja, daria 2. Si toma la reciente, da 1.
      const body = await pantallaConBetoPediendo()
      expect(body.requests[0].alineacion).toEqual({ score: 1, normalizado: 1, traits: 1 })
    })

    it('el peso con signo negativo del lugar se aplica tal cual', async () => {
      const { testId, byKey } = await rasgos()
      // El fixture se parece a "Bar El Clan" del seed: ambiente calmo pesa
      // -0.7, o sea que ahi se busca lo contrario de ese rasgo.
      await pesarLugar(byKey, { nueva_gente: 0.8, ambiente_calmo: -0.7 })
      // 2*0.8 + 2*(-0.7) = 0.2 sobre una masa de 1.5
      await resultadoDe(beto.id, testId, byKey, { nueva_gente: 2, ambiente_calmo: 2 })
      const body = await pantallaConBetoPediendo()
      // El score se compara con tolerancia: 0.2 no es representable en binario y
      // la suma da 0.20000000000000018. El numero exacto lo decide la pantalla
      // al formatear, no la API.
      expect(body.requests[0].alineacion!.traits).toBe(2)
      expect(body.requests[0].alineacion!.score).toBeCloseTo(0.2, 10)
      expect(body.requests[0].alineacion!.normalizado).toBeCloseTo(0.2 / 1.5, 10)
    })
  })
})

describe('el barrido de auto-resolucion', () => {
  /** Pide unse, la deja vencida y devuelve la fila. */
  async function requestThenExpire(email: string, planId: string) {
    const c = new Client()
    await c.login(email, PASSWORD)
    expect((await c.post(`/api/plans/${planId}/join`, {})).status).toBe(201)
    await rawQuery(
      `UPDATE "PlanParticipant"
          SET "expiresAt" = now() - interval '1 hour'
        WHERE "planId" = $1 AND "userId" = (SELECT id FROM "User" WHERE email = $2)`,
      [planId, email],
    )
  }

  async function statusOf(planId: string, email: string) {
    const rows = await rawQuery<{ status: string; respondedAt: Date | null; expiresAt: Date | null }>(
      `SELECT pp.status, pp."respondedAt", pp."expiresAt"
         FROM "PlanParticipant" pp
         JOIN "User" u ON u.id = pp."userId"
        WHERE pp."planId" = $1 AND u.email = $2`,
      [planId, email],
    )
    return rows[0]
  }

  it('una vencida con CUPO se auto-acepta, no se cancela', async () => {
    // Este es el test que define la regla del spec: cupo -> ACCEPTED.
    // Con CANCELLED el campo se va de vacio y nadie se entera.
    await requestThenExpire(beto.email, plan.id)

    await (await anaClient()).get(`/api/plans/${plan.id}/requests`)

    const row = await statusOf(plan.id, beto.email)
    expect(row.status).toBe('ACCEPTED')
    expect(row.respondedAt).not.toBeNull()

    // Y el cupo se consume: es una entrada de verdad, no una marca.
    const planRows = await rawQuery<{ acceptedCount: number }>(
      'SELECT "acceptedCount" FROM "Plan" WHERE id = $1',
      [plan.id],
    )
    expect(planRows[0].acceptedCount).toBe(2)
  })

  it('una vencida en un plan LLENO se auto-rechaza', async () => {
    // capacidad 2, creador = 1. Llenamos con Beto y dejamos a Carmen vencida.
    await rawQuery('UPDATE "Plan" SET capacity = 1 WHERE id = $1', [plan.id])
    const carmen = await createUser({
      email: 'carmen@example.com',
      name: 'Carmen Diaz',
      passwordHash: await hashPassword(PASSWORD),
      roles: ['USER'],
    })
    void carmen
    await requestThenExpire(beto.email, plan.id)

    await (await anaClient()).get(`/api/plans/${plan.id}/requests`)

    const row = await statusOf(plan.id, beto.email)
    expect(row.status).toBe('DECLINED')
    expect(row.respondedAt).not.toBeNull()

    // Nada de sobrecapacidad.
    const planRows = await rawQuery<{ acceptedCount: number }>(
      'SELECT "acceptedCount" FROM "Plan" WHERE id = $1',
      [plan.id],
    )
    expect(planRows[0].acceptedCount).toBe(1)
  })

  it('el barrido NO desborda el cupo con muchas vencidas', async () => {
    // El riesgo #1 del spec: un plan de 3 con 7 solicitudes vencidas no puede
    // terminar con 8 aceptados. Capacidad 3, organizador cuenta 1, entran 2 mas.
    //
    // El plan del `beforeEach` trae `acceptedCount: 1` pero no tiene fila de
    // organizador, asi que hay que insertarla o el invariante del spec
    // (`acceptedCount = COUNT(ACCEPTED|ATTENDED)`) empieza desbalanceado y
    // mide la inconsistencia del fixture en vez del barrido.
    await rawQuery(
      `INSERT INTO "PlanParticipant" ("planId", "userId", role, status, "joinedAt")
       VALUES ($1, $2, 'ORGANIZER', 'ACCEPTED', now())`,
      [plan.id, ana.id],
    )
    await rawQuery('UPDATE "Plan" SET capacity = 3 WHERE id = $1', [plan.id])

    for (let i = 0; i < 7; i++) {
      const email = `postulante${i}@example.com`
      const c = new Client()
      await createUser({
        email,
        name: `Postulante ${i}`,
        passwordHash: await hashPassword(PASSWORD),
        roles: ['USER'],
      })
      await c.login(email, PASSWORD)
      expect((await c.post(`/api/plans/${plan.id}/join`, {})).status).toBe(201)
    }
    await rawQuery(
      `UPDATE "PlanParticipant"
          SET "expiresAt" = now() - interval '1 hour'
        WHERE "planId" = $1 AND role = 'PARTICIPANT'`,
      [plan.id],
    )

    await (await anaClient()).get(`/api/plans/${plan.id}/requests`)

    // El invariante del spec: acceptedCount = COUNT(ACCEPTED | ATTENDED).
    const drift = await rawQuery<{ n: number }>(
      `SELECT count(*)::int AS n FROM "Plan" p
         WHERE p.id = $1
           AND p."acceptedCount" <> (
             SELECT count(*) FROM "PlanParticipant" pp
              WHERE pp."planId" = p.id AND pp.status IN ('ACCEPTED','ATTENDED'))`,
      [plan.id],
    )
    expect(drift[0].n).toBe(0)

    const planRows = await rawQuery<{ acceptedCount: number }>(
      'SELECT "acceptedCount" FROM "Plan" WHERE id = $1',
      [plan.id],
    )
    expect(planRows[0].acceptedCount).toBe(3)

    const counts = await rawQuery<{ status: string; n: number }>(
      `SELECT status, count(*)::int AS n FROM "PlanParticipant"
        WHERE "planId" = $1 GROUP BY status`,
      [plan.id],
    )
    const by = Object.fromEntries(counts.map((c) => [c.status, c.n]))
    // 1 organizador + 2 aceptados; los otros 5 rechazados por falta de cupo.
    expect(by.ACCEPTED).toBe(3)
    expect(by.DECLINED).toBe(5)
    expect(by.REQUESTED).toBeUndefined()
  })

  it('el barrido respeta el orden FIFO de vencimiento', async () => {
    await rawQuery(
      `INSERT INTO "PlanParticipant" ("planId", "userId", role, status, "joinedAt")
       VALUES ($1, $2, 'ORGANIZER', 'ACCEPTED', now())`,
      [plan.id, ana.id],
    )
    await rawQuery('UPDATE "Plan" SET capacity = 2 WHERE id = $1', [plan.id])

    const correos = ['primero@example.com', 'segundo@example.com', 'tercero@example.com']
    for (const email of correos) {
      const c = new Client()
      await createUser({
        email,
        name: email,
        passwordHash: await hashPassword(PASSWORD),
        roles: ['USER'],
      })
      await c.login(email, PASSWORD)
      await c.post(`/api/plans/${plan.id}/join`, {})
    }
    // Cada uno vence un minuto después que el anterior: el último en pedir es el
    // último en la fila del barrido y es al que le queda menos chances de cupo.
    // `row_number()` no se puede usar dentro de un UPDATE, así que se resuelve con
    // un `CASE` sobre el orden de llegada.
    await rawQuery(
      `UPDATE "PlanParticipant" pp
          SET "expiresAt" = now() - interval '3 hours' +
              (CASE u.email
                 WHEN $2 THEN interval '0 minutes'
                 WHEN $3 THEN interval '1 minute'
                 ELSE interval '2 minutes'
               END)
         FROM "User" u
        WHERE u.id = pp."userId"
          AND pp."planId" = $1
          AND u.email = ANY($4)`,
      [plan.id, correos[0], correos[1], correos],
    )

    await (await anaClient()).get(`/api/plans/${plan.id}/requests`)

    const rows = await rawQuery<{ email: string; status: string }>(
      `SELECT u.email, pp.status FROM "PlanParticipant" pp
         JOIN "User" u ON u.id = pp."userId"
        WHERE pp."planId" = $1 AND u.email = ANY($2)`,
      [plan.id, correos],
    )
    const status = Object.fromEntries(rows.map((r) => [r.email, r.status]))
    expect(status['primero@example.com']).toBe('ACCEPTED')
    expect(status['tercero@example.com']).toBe('DECLINED')
  })

  it('el barrido conserva expiresAt como evidencia', async () => {
    await requestThenExpire(beto.email, plan.id)
    const antes = await statusOf(plan.id, beto.email)
    expect(antes.expiresAt).not.toBeNull()

    await (await anaClient()).get(`/api/plans/${plan.id}/requests`)

    const row = await statusOf(plan.id, beto.email)
    // El spec dice que expiresAt se conserva despues de resolver.
    expect(row.expiresAt).not.toBeNull()
  })

  it('el barrido es idempotente: correrlo dos veces no cambia nada', async () => {
    await requestThenExpire(beto.email, plan.id)
    await (await anaClient()).get(`/api/plans/${plan.id}/requests`)
    const primera = await statusOf(plan.id, beto.email)

    await (await anaClient()).get(`/api/plans/${plan.id}/requests`)
    const segunda = await statusOf(plan.id, beto.email)

    expect(segunda.status).toBe(primera.status)
    const planRows = await rawQuery<{ acceptedCount: number }>(
      'SELECT "acceptedCount" FROM "Plan" WHERE id = $1',
      [plan.id],
    )
    // El error clasico de un resolvedor sin CAS: corrida doble cuenta doble.
    expect(planRows[0].acceptedCount).toBe(2)
  })
})

describe('POST /api/plans/[planId]/requests', () => {
  async function pendingBy(userEmail: string, planId: string) {
    const c = new Client()
    await c.login(userEmail, PASSWORD)
    expect((await c.post(`/api/plans/${planId}/join`, {})).status).toBe(201)
    return c
  }

  it('sin sesion responde 401', async () => {
    const res = await new Client().post(`/api/plans/${plan.id}/requests`, {
      userId: beto.id,
      decision: 'ACCEPTED',
    })
    expect(res.status).toBe(401)
  })

  it('un participante no puede aprobarse a si mismo', async () => {
    const carmen = await createUser({
      email: 'carmen@example.com',
      name: 'Carmen Diaz',
      passwordHash: await hashPassword(PASSWORD),
      roles: ['USER'],
    })
    const c = new Client()
    await c.login(carmen.email, PASSWORD)

    const res = await c.post(`/api/plans/${plan.id}/requests`, {
      userId: carmen.id,
      decision: 'ACCEPTED',
    })
    // No es el organizador, asi que 403 antes de cualquier otra cosa.
    expect(res.status).toBe(403)
  })

  it('aprobar sube el contador y marca ACCEPTED con respondedAt', async () => {
    await pendingBy(beto.email, plan.id)
    const res = await (await anaClient()).post(`/api/plans/${plan.id}/requests`, {
      userId: beto.id,
      decision: 'ACCEPTED',
    })
    expect(res.status).toBe(200)

    const rows = await rawQuery<{ status: string; expiresAt: Date | null; respondedAt: Date | null }>(
      `SELECT status, "expiresAt", "respondedAt"
         FROM "PlanParticipant"
        WHERE "planId" = $1 AND "userId" = $2`,
      [plan.id, beto.id],
    )
    expect(rows[0].status).toBe('ACCEPTED')
    // El spec conserva `expiresAt` como evidencia de cuando vencio la
    // solicitud. No se limpia al responder.
    expect(rows[0].expiresAt).not.toBeNull()
    expect(rows[0].respondedAt).not.toBeNull()

    const planRows = await rawQuery<{ acceptedCount: number }>(
      'SELECT "acceptedCount" FROM "Plan" WHERE id = $1',
      [plan.id],
    )
    expect(planRows[0].acceptedCount).toBe(2)
  })

  it('rechazar no sube el contador y conserva expiresAt', async () => {
    await pendingBy(beto.email, plan.id)
    const res = await (await anaClient()).post(`/api/plans/${plan.id}/requests`, {
      userId: beto.id,
      decision: 'DECLINED',
    })
    expect(res.status).toBe(200)

    const rows = await rawQuery<{ status: string; expiresAt: Date | null }>(
      'SELECT status, "expiresAt" FROM "PlanParticipant" WHERE "planId" = $1',
      [plan.id],
    )
    expect(rows[0].status).toBe('DECLINED')
    expect(rows[0].expiresAt).not.toBeNull()

    const planRows = await rawQuery<{ acceptedCount: number }>(
      'SELECT "acceptedCount" FROM "Plan" WHERE id = $1',
      [plan.id],
    )
    expect(planRows[0].acceptedCount).toBe(1)
  })

  it('aprobar mas gente que el cupo da 409 y no desborda el contador', async () => {
    // capacidad 2, creador cuenta como 1: entra Beto y queda lleno.
    await pendingBy(beto.email, plan.id)
    const carmen = await createUser({
      email: 'carmen@example.com',
      name: 'Carmen Diaz',
      passwordHash: await hashPassword(PASSWORD),
      roles: ['USER'],
    })
    await pendingBy(carmen.email, plan.id)

    const ana = await anaClient()
    expect(
      (await ana.post(`/api/plans/${plan.id}/requests`, { userId: beto.id, decision: 'ACCEPTED' }))
        .status,
    ).toBe(200)

    const lleno = await ana.post(`/api/plans/${plan.id}/requests`, {
      userId: carmen.id,
      decision: 'ACCEPTED',
    })
    expect(lleno.status).toBe(409)

    // Lo importante: el contador NO se pasa. Un overbooking es un bug de
    // integridad, no un dato raro.
    const planRows = await rawQuery<{ acceptedCount: number }>(
      'SELECT "acceptedCount" FROM "Plan" WHERE id = $1',
      [plan.id],
    )
    expect(planRows[0].acceptedCount).toBe(2)
  })

  it('no se puede aprobar dos veces la misma peticion', async () => {
    await pendingBy(beto.email, plan.id)
    const ana = await anaClient()
    expect(
      (await ana.post(`/api/plans/${plan.id}/requests`, { userId: beto.id, decision: 'ACCEPTED' }))
        .status,
    ).toBe(200)

    const again = await ana.post(`/api/plans/${plan.id}/requests`, {
      userId: beto.id,
      decision: 'ACCEPTED',
    })
    expect(again.status).toBe(409)

    const planRows = await rawQuery<{ acceptedCount: number }>(
      'SELECT "acceptedCount" FROM "Plan" WHERE id = $1',
      [plan.id],
    )
    expect(planRows[0].acceptedCount).toBe(2)
  })

  it('responder una peticion vencida da 409 y aplica la regla del barrido', async () => {
    // Una peticion vencida ya no es del organizador: se resuelve sola con la
    // regla del spec. Aca habia cupo, asi que se AUTO-ACEPTÓ y el contador sube.
    // El 409 sigue siendo correcto (la peticion no estaba viva), pero el efecto
    // no es "no pasa nada".
    await pendingBy(beto.email, plan.id)
    await rawQuery(
      `UPDATE "PlanParticipant"
          SET "expiresAt" = now() - interval '1 minute'
        WHERE "planId" = $1`,
      [plan.id],
    )

    const res = await (await anaClient()).post(`/api/plans/${plan.id}/requests`, {
      userId: beto.id,
      decision: 'ACCEPTED',
    })
    expect(res.status).toBe(409)

    const rows = await rawQuery<{ status: string }>(
      'SELECT status FROM "PlanParticipant" WHERE "planId" = $1',
      [plan.id],
    )
    expect(rows[0].status).toBe('ACCEPTED')

    const planRows = await rawQuery<{ acceptedCount: number }>(
      'SELECT "acceptedCount" FROM "Plan" WHERE id = $1',
      [plan.id],
    )
    expect(planRows[0].acceptedCount).toBe(2)
  })

  it('responder una peticion vencida en un plan LLENO la auto-rechaza', async () => {
    await pendingBy(beto.email, plan.id)
    await rawQuery('UPDATE "Plan" SET capacity = 1 WHERE id = $1', [plan.id])
    await rawQuery(
      `UPDATE "PlanParticipant"
          SET "expiresAt" = now() - interval '1 minute'
        WHERE "planId" = $1`,
      [plan.id],
    )

    const res = await (await anaClient()).post(`/api/plans/${plan.id}/requests`, {
      userId: beto.id,
      decision: 'ACCEPTED',
    })
    expect(res.status).toBe(409)

    const rows = await rawQuery<{ status: string }>(
      'SELECT status FROM "PlanParticipant" WHERE "planId" = $1',
      [plan.id],
    )
    expect(rows[0].status).toBe('DECLINED')

    const planRows = await rawQuery<{ acceptedCount: number }>(
      'SELECT "acceptedCount" FROM "Plan" WHERE id = $1',
      [plan.id],
    )
    expect(planRows[0].acceptedCount).toBe(1)
  })

  it('responder sobre alguien que no pidio da 404', async () => {
    const res = await (await anaClient()).post(`/api/plans/${plan.id}/requests`, {
      userId: beto.id,
      decision: 'ACCEPTED',
    })
    expect(res.status).toBe(404)
  })

  it('una decision inventada da 400', async () => {
    await pendingBy(beto.email, plan.id)
    for (const decision of ['QUIZAS', 'ACEPTADO', '', null]) {
      const res = await (await anaClient()).post(`/api/plans/${plan.id}/requests`, {
        userId: beto.id,
        decision,
      })
      expect(res.status, `decision=${decision}`).toBe(400)
    }
  })

  it('el organizador no puede responderse a si mismo', async () => {
    const res = await (await anaClient()).post(`/api/plans/${plan.id}/requests`, {
      userId: ana.id,
      decision: 'ACCEPTED',
    })
    expect(res.status).toBe(400)
  })
})
