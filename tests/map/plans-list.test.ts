import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { hashPassword } from '../../lib/auth/password'
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
 * El mapa es publico, los lugares son publicos, y el LISTADO DE PLANES NO.
 *
 * La razon no es que el plan sea secreto: es que un plan es un compromiso con
 * fecha, hora y personas. El lugar donde pasa puede ser publico, la cita no.
 *
 * Por eso estos tests tienen tres frentes:
 *   1. Sin sesion, 401. Y ni el status ni el cuerpo distinguen "existe" de
 *      "no existe".
 *   2. Con sesion, la caja y los filtros acotan de verdad.
 *   3. Con sesion, la respuesta NO trae datos de terceros: ni la lista de
 *      participantes, ni sus emails, ni el reliability de otra gente. Trae el
 *      estado del viewer, que es lo unico legitimo.
 */

const PASSWORD = 'correcto-caballo-grapa-42'
/** Recoleta. */
const BA = '-58.50,-34.65,-58.30,-34.55'
/** Una caja a mitad de camino de Atlantico, sin nada nuestro. */
const MAR = '-30.00,30.00,-10.00,40.00'

let ana: { id: string; email: string }
let beto: { id: string; email: string }
let place: { id: string }
let plan: { id: string }

beforeEach(async () => {
  await resetDb()
  const passwordHash = await hashPassword(PASSWORD)
  ana = await createUser({ email: 'ana@example.com', name: 'Ana Ruiz', passwordHash, roles: ['USER'] })
  beto = await createUser({ email: 'beto@example.com', name: 'Beto Diaz', passwordHash, roles: ['USER'] })
  place = await createPlace({ name: 'Cafe Tortuga', lat: -34.6037, lng: -58.3816 })
  plan = await createPlan({ placeId: place.id, creatorId: ana.id, capacity: 4, acceptedCount: 1 })
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

type PlanSummary = {
  id: string
  title: string
  capacity: number
  acceptedCount: number
  remainingSpots: number
  isFull: boolean
  place: { id: string; name: string; latitude: number; longitude: number }
  creator: { id: string; name: string }
  viewer: { isCreator: boolean; participation: null | { status: string; role: string } }
}

describe('GET /api/plans?bbox=', () => {
  it('sin sesion responde 401, ni el plan ni el lugar', async () => {
    const res = await new Client().get(`/api/plans?bbox=${BA}`)
    expect(res.status).toBe(401)
    expect(res.text).not.toContain('Plan de prueba')
    expect(res.text).not.toContain('Cafe Tortuga')
  })

  it('sin sesion responde 401 aunque la caja no tenga nada', async () => {
    // El orden importa: si la caja vacia devolviera 200 o 404 sin sesion, el
    // status confirmaria que el endpoint existe y el atacante puede mapear.
    const res = await new Client().get(`/api/plans?bbox=${MAR}`)
    expect(res.status).toBe(401)
  })

  it('con sesion devuelve el plan de la caja', async () => {
    const res = await (await anaClient()).get(`/api/plans?bbox=${BA}`)
    expect(res.status).toBe(200)
    const body = res.body as { plans: PlanSummary[] }
    expect(body.plans).toHaveLength(1)
    expect(body.plans[0].id).toBe(plan.id)
    expect(body.plans[0].place.name).toBe('Cafe Tortuga')
  })

  it('acota por caja: un plan fuera de la vista no aparece', async () => {
    const res = await (await anaClient()).get(`/api/plans?bbox=${MAR}`)
    expect(res.status).toBe(200)
    expect((res.body as { plans: PlanSummary[] }).plans).toHaveLength(0)
  })

  it('bbox invalido responde 400 con el motivo', async () => {
    const c = await anaClient()
    for (const bad of ['', '1,2,3', 'a,b,c,d', '10,-200,10,10', '1,1,1', '1,2,3,4,5']) {
      const res = await c.get(`/api/plans?bbox=${encodeURIComponent(bad)}`)
      expect(res.status, `bbox=${bad}`).toBe(400)
    }
  })

  it('bbox ausente responde 400: es la caja que se mira, no un listado global', async () => {
    const res = await (await anaClient()).get('/api/plans')
    expect(res.status).toBe(400)
  })

  it('no trae planes pasados, cancelados ni borrados', async () => {
    const pasado = await createPlan({
      placeId: place.id,
      creatorId: ana.id,
      startsAt: new Date(Date.now() - 3_600_000),
    })
    const cancelado = await createPlan({ placeId: place.id, creatorId: ana.id, status: 'CANCELLED' })
    const borrado = await createPlan({ placeId: place.id, creatorId: ana.id, deleted: true })

    const res = await (await anaClient()).get(`/api/plans?bbox=${BA}`)
    const ids = (res.body as { plans: PlanSummary[] }).plans.map((p) => p.id)
    expect(ids).toContain(plan.id)
    expect(ids).not.toContain(pasado.id)
    expect(ids).not.toContain(cancelado.id)
    expect(ids).not.toContain(borrado.id)
  })

  it('no expone planes de un lugar PENDING a un usuario normal', async () => {
    // Un lugar PENDING es una propuesta sin revisar. Publicarla en el listado de
    // planes la convierte en un lugar, que es exactamente lo que la curaduria
    // evita.
    const pending = await createPlace({ name: 'Bar Sin Revisar', lat: -34.6, lng: -58.38 })
    await rawQuery(`UPDATE "Place" SET "verificationStatus" = 'PENDING' WHERE id = $1`, [pending.id])
    const oculto = await createPlan({ placeId: pending.id, creatorId: ana.id })

    const c = await anaClient()
    const normal = await c.get(`/api/plans?bbox=${BA}`)
    const ids = (normal.body as { plans: PlanSummary[] }).plans.map((p) => p.id)
    expect(ids).not.toContain(oculto.id)

    // Y un curador si lo ve: la regla de visibilidad es la misma del mapa.
    await addRole(ana.id, 'CURATOR')
    const curador = await anaClient()
    const conCurador = await curador.get(`/api/plans?bbox=${BA}`)
    expect((conCurador.body as { plans: PlanSummary[] }).plans.map((p) => p.id)).toContain(oculto.id)
  })
})

describe('GET /api/plans - lo que NO puede filtrar', () => {
  it('no trae la lista de participantes ni sus emails', async () => {
    // Beto esta ACCEPTED en el plan de Ana. Ana tiene sesion y puede ver el
    // detalle (que si lista participantes), pero el LISTADO no: son 20 planes en
    // pantalla, no 20 listas de gente.
    // `PlanParticipant` tiene PK compuesta `[planId, userId]`: no hay columna
    // `id` que inventar, ni `createdAt`/`updatedAt`.
    await rawQuery(
      `INSERT INTO "PlanParticipant" ("planId", "userId", role, status, "joinedAt")
       VALUES ($1, $2, 'PARTICIPANT', 'ACCEPTED', now())`,
      [plan.id, beto.id],
    )
    await rawQuery(`UPDATE "Plan" SET "acceptedCount" = 2 WHERE id = $1`, [plan.id])

    const res = await (await anaClient()).get(`/api/plans?bbox=${BA}`)
    expect(res.status).toBe(200)
    expect(res.text).not.toContain(beto.email)
    expect(res.text).not.toContain(beto.id)
    // Tampoco la palabra, por si el shape cambiara y quedara un array vacio.
    expect(res.text).not.toMatch(/participants/i)
  })

  it('no incluye reliability de terceros', async () => {
    // Beto fue NO_SHOW tres veces en un plan pasado de Ana. Esa informacion es
    // del organizador y vive en /api/plans/[id]/requests.
    await rawQuery(
      `INSERT INTO "Plan" (id, title, "placeId", "creatorId", "startsAt", capacity, "acceptedCount", status, "createdAt", "updatedAt")
       VALUES (gen_random_uuid()::text, 'Plan pasado', $1, $2, now() - interval '1 day', 4, 1, 'COMPLETED', now(), now())`,
      [place.id, ana.id],
    )
    const res = await (await anaClient()).get(`/api/plans?bbox=${BA}`)
    expect(res.text).not.toMatch(/reliab|attend|no_show|noshow/i)
  })

  it('no incluye el email de nadie, ni del creador', async () => {
    const res = await (await anaClient()).get(`/api/plans?bbox=${BA}`)
    expect(res.text).not.toContain(ana.email)
    expect(res.text).not.toMatch(/email/i)
  })
})

describe('GET /api/plans - estado del viewer', () => {
  it('el creador ve que es suyo y que ya esta confirmado', async () => {
    await rawQuery(
      `INSERT INTO "PlanParticipant" ("planId", "userId", role, status, "joinedAt")
       VALUES ($1, $2, 'ORGANIZER', 'ACCEPTED', now())`,
      [plan.id, ana.id],
    )
    const res = await (await anaClient()).get(`/api/plans?bbox=${BA}`)
    const first = (res.body as { plans: PlanSummary[] }).plans[0]
    expect(first.viewer.isCreator).toBe(true)
    expect(first.viewer.participation).toEqual({ status: 'ACCEPTED', role: 'ORGANIZER' })
  })

  it('un tercero ve que no participa, aunque otra gente si', async () => {
    // Ana organiza y esta ACCEPTED. Beto no pidio nada. La respuesta de Beto
    // tiene que decir eso, y no la participacion de Ana.
    await rawQuery(
      `INSERT INTO "PlanParticipant" ("planId", "userId", role, status, "joinedAt")
       VALUES ($1, $2, 'ORGANIZER', 'ACCEPTED', now())`,
      [plan.id, ana.id],
    )
    const res = await (await betoClient()).get(`/api/plans?bbox=${BA}`)
    const first = (res.body as { plans: PlanSummary[] }).plans[0]
    expect(first.viewer.isCreator).toBe(false)
    expect(first.viewer.participation).toBeNull()
  })

  it('el estado del viewer es el suyo, no el del primero de la lista', async () => {
    // Este es el test que mata la consulta sin filtro: si `participants` no
    // estuviera filtrado por `userId`, Beto veria la fila de Ana.
    await rawQuery(
      `INSERT INTO "PlanParticipant" ("planId", "userId", role, status, "joinedAt")
       VALUES ($1, $2, 'ORGANIZER', 'ACCEPTED', now())`,
      [plan.id, ana.id],
    )
    const res = await (await betoClient()).get(`/api/plans?bbox=${BA}`)
    const first = (res.body as { plans: PlanSummary[] }).plans[0]
    expect(first.viewer.participation).toBeNull()
  })

  it('el viewer ve SU propia solicitud pendiente', async () => {
    await rawQuery(
      `INSERT INTO "PlanParticipant" ("planId", "userId", role, status, "joinedAt")
       VALUES ($1, $2, 'PARTICIPANT', 'REQUESTED', now())`,
      [plan.id, beto.id],
    )
    const res = await (await betoClient()).get(`/api/plans?bbox=${BA}`)
    const first = (res.body as { plans: PlanSummary[] }).plans[0]
    expect(first.viewer.participation).toEqual({ status: 'REQUESTED', role: 'PARTICIPANT' })
  })
})

describe('GET /api/plans - cupo', () => {
  it('remainingSpots descuenta y avisa cuando esta lleno', async () => {
    const lleno = await createPlan({
      placeId: place.id,
      creatorId: ana.id,
      capacity: 3,
      acceptedCount: 3,
    })
    const res = await (await anaClient()).get(`/api/plans?bbox=${BA}`)
    const found = (res.body as { plans: PlanSummary[] }).plans.find((p) => p.id === lleno.id)!
    expect(found.remainingSpots).toBe(0)
    expect(found.isFull).toBe(true)
  })

  it('remainingSpots nunca es negativo si el contador se pasa', async () => {
    const pasado = await createPlan({
      placeId: place.id,
      creatorId: ana.id,
      capacity: 2,
      acceptedCount: 5,
    })
    const res = await (await anaClient()).get(`/api/plans?bbox=${BA}`)
    const found = (res.body as { plans: PlanSummary[] }).plans.find((p) => p.id === pasado.id)!
    // Un contador inflado es un bug de datos. La API no lo propaga como si fuera
    // real: muestra 0 y `isFull`, que es lo que puede mostrarse sin mentir.
    expect(found.remainingSpots).toBe(0)
    expect(found.isFull).toBe(true)
  })

  it('un plan con cupo libre no esta lleno', async () => {
    const res = await (await anaClient()).get(`/api/plans?bbox=${BA}`)
    const first = (res.body as { plans: PlanSummary[] }).plans[0]
    expect(first.remainingSpots).toBe(3)
    expect(first.isFull).toBe(false)
  })
})

describe('GET /api/plans - cache y orden', () => {
  it('no se cachea: la respuesta depende de quien pregunta', async () => {
    const res = await (await anaClient()).get(`/api/plans?bbox=${BA}`)
    // Sin esto, un CDN compartido entre usuarios serviria la participacion de
    // uno a otro, que es un leak de sesion.
    expect(res.headers.get('cache-control')).toContain('no-store')
  })

  it('ordena por fecha de inicio, no por el orden de insercion', async () => {
    const lejano = await createPlan({
      placeId: place.id,
      creatorId: ana.id,
      startsAt: new Date(Date.now() + 7 * 86_400_000),
    })
    const cercano = await createPlan({
      placeId: place.id,
      creatorId: ana.id,
      startsAt: new Date(Date.now() + 3_600_000),
    })
    const res = await (await anaClient()).get(`/api/plans?bbox=${BA}`)
    const ids = (res.body as { plans: PlanSummary[] }).plans.map((p) => p.id)
    // `plan` arranca a +24h, `cercano` a +1h: el orden de insercion los deja al
    // reves del que se espera en una pantalla.
    expect(ids.indexOf(cercano.id)).toBeLessThan(ids.indexOf(plan.id))
    expect(ids.indexOf(plan.id)).toBeLessThan(ids.indexOf(lejano.id))
  })
})

describe('GET /api/plans - antimeridiano', () => {
  it('una caja que cruza el meridiano 180 trae los dos lados', async () => {
    // Fiji: un lugar al este del 180 y otro al oeste, a 2 grados de distancia.
    // `minLng > maxLng`, que un `BETWEEN` simple devolveria vacio.
    const este = await createPlace({ name: 'Este', lat: -17.7, lng: 179.9 })
    const oeste = await createPlace({ name: 'Oeste', lat: -17.7, lng: -179.9 })
    await createPlan({ placeId: este.id, creatorId: ana.id })
    await createPlan({ placeId: oeste.id, creatorId: ana.id })

    const res = await (await anaClient()).get('/api/plans?bbox=179.0,-18.0,-179.0,-17.0')
    expect(res.status).toBe(200)
    expect((res.body as { plans: PlanSummary[] }).plans).toHaveLength(2)
  })
})

describe('GET /api/plans - sesion invalida', () => {
  it('una cuenta suspendida no lista planes', async () => {
    // El reread de `requireUser` es lo que hace que esto valga: una cookie
    // stateless dejaria operar a la cuenta suspendida hasta que expirara, que
    // son 30 dias.
    //
    // Login PRIMERO y suspension despues, al reves: loguearse con la cuenta ya
    // suspendida daria 403 en el login y no probaria nada sobre el endpoint.
    const c = await anaClient()
    await rawQuery(`UPDATE "User" SET "suspendedAt" = now() WHERE id = $1`, [ana.id])
    const res = await c.get(`/api/plans?bbox=${BA}`)
    expect(res.status).toBe(403)
  })

  it('una cuenta desactivada no lista planes', async () => {
    const c = await anaClient()
    await rawQuery(`UPDATE "User" SET "isActive" = false WHERE id = $1`, [ana.id])
    const res = await c.get(`/api/plans?bbox=${BA}`)
    expect(res.status).toBe(403)
  })

  it('una cookie inválida no lista planes', async () => {
    const c = new Client()
    c.setCookie('nexa_session', 'esto-no-es-un-token')
    const res = await c.get(`/api/plans?bbox=${BA}`)
    expect(res.status).toBe(401)
  })
})
