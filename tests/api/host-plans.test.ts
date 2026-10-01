import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { hashPassword } from '../../lib/auth/password'
import { getPrisma } from '../../lib/db'
import { Client } from '../helpers/http'
import { addRole, closeDb, createPlace, createPlan, createUser, resetDb } from '../helpers/db'

/**
 * `GET /api/host/plans`: los planes que organiza la persona con sesion, con
 * cuantas solicitudes hay pendientes.
 *
 * Es el selector de `/host/requests`. Sin el, la pantalla de aprobaciones no
 * tiene por donde arrancar, porque el unico listado de planes del proyecto es
 * la busqueda del mapa, que es por bounding box y no tiene nada que ver con
 * "los mios".
 */

const PASSWORD = 'correcto-caballo-grapa-42'

let ana: { id: string; email: string }
let dario: { id: string; email: string }
let place: { id: string }

beforeEach(async () => {
  await resetDb()
  const passwordHash = await hashPassword(PASSWORD)
  ana = await createUser({ email: 'ana@example.com', name: 'Ana Ruiz', passwordHash, roles: ['USER'] })
  dario = await createUser({ email: 'dario@example.com', name: 'Dario Paz', passwordHash, roles: ['USER'] })
  place = await createPlace({ name: 'Cafe Tortuga', lat: -34.6037, lng: -58.3816 })
})

afterAll(async () => {
  await closeDb()
})

/** Cliente con sesion de Ana. */
async function anaClient() {
  const c = new Client()
  expect((await c.login(ana.email, PASSWORD)).status).toBe(200)
  return c
}

/** Cliente con sesion de Dario. */
async function darioClient() {
  const c = new Client()
  expect((await c.login(dario.email, PASSWORD)).status).toBe(200)
  return c
}

/**
 * Una fila `REQUESTED` con la expiracion que se le pida.
 *
 * Se escribe con Prisma y no con `rawQuery` a proposito. `PlanParticipant` no
 * tiene `id` (la PK es la compuesta), pero `create` funciona porque pide las
 * dos columnas de la clave.
 *
 * La razon de no escribirlo en crudo es la zona horaria: la columna es
 * `timestamp without time zone` y Prisma la lee corrida -5h respecto de lo que
 * ve el SQL crudo. Un `expiresAt` a futuro insertado con `rawQuery` llega a
 * Prisma como un instante en el pasado, y el endpoint lo cuenta como vencido
 * con el filtro puesto, sin error en ningun lado. Los tests que vencen con
 * `now() - interval '1 hour'` no lo detectan porque mover una fecha mas hacia
 * atras tampoco cambia el resultado.
 */
async function request(planId: string, userId: string, expiresAt: Date) {
  await getPrisma().planParticipant.create({
    data: {
      planId,
      userId,
      role: 'PARTICIPANT',
      status: 'REQUESTED',
      joinedAt: new Date(),
      expiresAt,
    },
  })
}

type Res = { plans: { id: string; placeName: string; status: string; pendingCount: number; startsAt: string }[] }

describe('GET /api/host/plans', () => {
  it('sin sesion responde 401', async () => {
    expect((await new Client().get('/api/host/plans')).status).toBe(401)
  })

  it('un usuario comun sin rol HOST responde 403', async () => {
    // Sera `/host` la que lo rebote igual, pero la API no se apoya en el
    // middleware: cada endpoint vuelve a comprobar el rol.
    const res = await (await anaClient()).get('/api/host/plans')
    expect(res.status).toBe(403)
  })

  it('un HOST ve los planes que organiza', async () => {
    await addRole(ana.id, 'HOST')
    const mio = await createPlan({ placeId: place.id, creatorId: ana.id })
    const res = await (await anaClient()).get('/api/host/plans')
    expect(res.status).toBe(200)
    const body = res.body as Res
    expect(body.plans).toHaveLength(1)
    expect(body.plans[0].id).toBe(mio.id)
    expect(body.plans[0].placeName).toBe('Cafe Tortuga')
  })

  it('NO ve los planes de otra persona', async () => {
    await addRole(ana.id, 'HOST')
    const deDario = await createPlan({ placeId: place.id, creatorId: dario.id })
    const body = (await (await anaClient()).get('/api/host/plans')).body as Res
    expect(body.plans.map((p) => p.id)).not.toContain(deDario.id)
    expect(body.plans).toHaveLength(0)
  })

  it('cuenta las solicitudes pendientes de cada plan', async () => {
    await addRole(ana.id, 'HOST')
    const plan = await createPlan({ placeId: place.id, creatorId: ana.id })
    const otro = await createPlan({ placeId: place.id, creatorId: ana.id })
    await request(plan.id, dario.id, new Date(Date.now() + 3_600_000))
    await request(plan.id, ana.id, new Date(Date.now() + 3_600_000))
    await request(otro.id, dario.id, new Date(Date.now() + 3_600_000))

    const body = (await (await anaClient()).get('/api/host/plans')).body as Res
    const porId = new Map(body.plans.map((p) => [p.id, p.pendingCount]))
    expect(porId.get(plan.id)).toBe(2)
    expect(porId.get(otro.id)).toBe(1)
  })

  it('el conteo NO incluye solicitudes ya vencidas', async () => {
    // El numero del selector tiene que coincidir con lo que despues lista
    // `/requests`, que barre lo vencido. Si el selector contara lo vencido,
    // el organizador veria "2 pendientes" y al abrir la pantalla habria 1, sin
    // explicacion de donde se fue el otro.
    await addRole(ana.id, 'HOST')
    const plan = await createPlan({ placeId: place.id, creatorId: ana.id })
    await request(plan.id, dario.id, new Date(Date.now() - 3_600_000))
    await request(plan.id, ana.id, new Date(Date.now() + 3_600_000))

    const body = (await (await anaClient()).get('/api/host/plans')).body as Res
    expect(body.plans[0].pendingCount).toBe(1)
  })

  it('el conteo NO incluye a los ya aceptados ni a los rechazados', async () => {
    // Tres personas distintas porque la PK es [planId, userId]: no se puede
    // tener a la misma en REQUESTED y en ACCEPTED en el mismo plan.
    await addRole(ana.id, 'HOST')
    const eugenia = await createUser({
      email: 'eugenia@example.com',
      name: 'Eugenia Rey',
      passwordHash: await hashPassword(PASSWORD),
      roles: ['USER'],
    })
    const franco = await createUser({
      email: 'franco@example.com',
      name: 'Franco Solo',
      passwordHash: await hashPassword(PASSWORD),
      roles: ['USER'],
    })
    const plan = await createPlan({ placeId: place.id, creatorId: ana.id })
    await request(plan.id, dario.id, new Date(Date.now() + 3_600_000))
    for (const [userId, status] of [
      [eugenia.id, 'ACCEPTED'],
      [franco.id, 'DECLINED'],
    ] as const) {
      await getPrisma().planParticipant.create({
        data: { planId: plan.id, userId, role: 'PARTICIPANT', status, joinedAt: new Date() },
      })
    }
    const body = (await (await anaClient()).get('/api/host/plans')).body as Res
    // Los aceptados cuentan en `acceptedCount`, no en `pendingCount`.
    expect(body.plans[0].pendingCount).toBe(1)
  })

  it('no trae los planes borrados', async () => {
    await addRole(ana.id, 'HOST')
    await createPlan({ placeId: place.id, creatorId: ana.id, deleted: true })
    const body = (await (await anaClient()).get('/api/host/plans')).body as Res
    expect(body.plans).toHaveLength(0)
  })

  it('ordena abiertos antes que cancelados, y por fecha dentro de cada estado', async () => {
    // Este test existe por el comentario del route handler: el `orderBy` sobre
    // el enum depende del orden de declaracion de `PlanStatus` en Postgres. Si
    // una migracion reordena el enum, este test se cae y avisa, en vez de que
    // la pantalla empiece a mezclar planes cancelados con abiertos sin que nadie
    // se entere por que.
    await addRole(ana.id, 'HOST')
    const manana = Date.now() + 86_400_000
    const pasadoManana = await createPlan({
      placeId: place.id,
      creatorId: ana.id,
      startsAt: new Date(manana + 86_400_000),
    })
    const mananaTemprano = await createPlan({
      placeId: place.id,
      creatorId: ana.id,
      startsAt: new Date(manana),
    })
    const cancelado = await createPlan({
      placeId: place.id,
      creatorId: ana.id,
      startsAt: new Date(manana - 86_400_000),
      status: 'CANCELLED',
    })

    const body = (await (await anaClient()).get('/api/host/plans')).body as Res
    expect(body.plans.map((p) => p.id)).toEqual([mananaTemprano.id, pasadoManana.id, cancelado.id])
  })

  it('un ADMIN ve solo los planes propios, no los de los demas', async () => {
    // `/requests` exige `plan.creatorId === gate.user.id`, asi que un ADMIN que
    // organizo nada no tiene ninguna pantalla de solicitudes que abrir. Si el
    // selector le mostrara planes ajenos, lo llevaria a un 403 por cada click.
    await addRole(ana.id, 'ADMIN')
    const deDario = await createPlan({ placeId: place.id, creatorId: dario.id })
    const body = (await (await anaClient()).get('/api/host/plans')).body as Res
    expect(body.plans).toHaveLength(0)
    expect(body.plans.map((p) => p.id)).not.toContain(deDario.id)
  })

  it('no filtra datos de terceros mas alla del conteo', async () => {
    // El nombre del lugar es publico, pero el listado no debe incluir planes
    // ajenos ni sus titulos. Un plan de otra persona no aparece en ninguna
    // forma, ni siquiera con pendingCount 0.
    await addRole(ana.id, 'HOST')
    const deDario = await createPlan({ placeId: place.id, creatorId: dario.id })
    const res = await (await anaClient()).get('/api/host/plans')
    expect(res.text).not.toContain(deDario.id)
  })

  it('el rol se toma de la base en cada peticion, no de la sesion vieja', async () => {
    // Ana arranca sin HOST. Se le da el rol y tiene que empezar a ver sus
    // planes sin volver a iniciar sesion: el token no lleva los roles.
    const antes = await (await anaClient()).get('/api/host/plans')
    expect(antes.status).toBe(403)
    await addRole(ana.id, 'HOST')
    const despues = await (await anaClient()).get('/api/host/plans')
    expect(despues.status).toBe(200)
  })

  it('un HOST sin planes devuelve una lista vacia, no un error', async () => {
    await addRole(ana.id, 'HOST')
    const res = await (await anaClient()).get('/api/host/plans')
    expect(res.status).toBe(200)
    expect((res.body as Res).plans).toEqual([])
  })

  it('Dario con HOST ve su propio plan, distinto al de Ana', async () => {
    await addRole(ana.id, 'HOST')
    await addRole(dario.id, 'HOST')
    const deAna = await createPlan({ placeId: place.id, creatorId: ana.id })
    const deDario = await createPlan({ placeId: place.id, creatorId: dario.id })
    const body = (await (await darioClient()).get('/api/host/plans')).body as Res
    expect(body.plans.map((p) => p.id)).toEqual([deDario.id])
    expect(body.plans.map((p) => p.id)).not.toContain(deAna.id)
  })
})
