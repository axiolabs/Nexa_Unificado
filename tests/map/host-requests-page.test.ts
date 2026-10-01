import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { hashPassword } from '../../lib/auth/password'
import { getPrisma } from '../../lib/db'
import { Client } from '../helpers/http'
import { addRole, closeDb, createPlace, createPlan, createUser, resetDb } from '../helpers/db'

/**
 * `/host/requests`: la pantalla de aprobacion de solicitudes.
 *
 * Antes de esta pantalla, `GET` y `POST /api/plans/[id]/requests` existian y no
 * tenian ninguna pagina. O sea que el flujo de unirse a un plan no cerraba: el
 * postulante pedia, esperaba 24 horas y se auto-resolvia solo.
 *
 * Lo que se verifica aca:
 *
 *   1. El middleware la cierra por rol, y escribir la URL a mano no la abre.
 *   2. Renderiza 200 para un HOST.
 *   3. Los datos NO estan en el HTML inicial: la pantalla los pide por
 *      `fetch`, igual que el detalle del plan. Si aparecieran, el Server
 *      Component estaria consultando la base por su cuenta, con una segunda
 *      copia de la regla de visibilidad.
 *   4. El chunk pide los dos endpoints que necesita y trae los textos que
 *      distinguen "no hay dato" de "el dato dio cero".
 *
 * Lo que NO se verifica: que los botones acepten y rechijen. No hay DOM en el
 * harness. La pasada manual con dos navegadores es lo que cubre ese camino, y
 * hasta que exista, este archivo es la mitad de la cobertura y conviene que
 * lo diga.
 */

const PASSWORD = 'correcto-caballo-grapa-42'

let hilda: { id: string; email: string }
let ana: { id: string; email: string }
let beto: { id: string; email: string }
let place: { id: string }
let plan: { id: string }

beforeEach(async () => {
  await resetDb()
  const passwordHash = await hashPassword(PASSWORD)
  hilda = await createUser({ email: 'hilda@example.com', name: 'Hilda Host', passwordHash, roles: ['USER'] })
  await addRole(hilda.id, 'HOST')
  ana = await createUser({ email: 'ana@example.com', name: 'Ana Ruiz', passwordHash, roles: ['USER'] })
  beto = await createUser({ email: 'beto@example.com', name: 'Beto Diaz', passwordHash, roles: ['USER'] })
  place = await createPlace({ name: 'Cafe Tortuga', lat: -34.6037, lng: -58.3816 })
  plan = await createPlan({ placeId: place.id, creatorId: hilda.id, capacity: 4, acceptedCount: 0 })
})

afterAll(async () => {
  await closeDb()
})

async function loginAs(email: string): Promise<Client> {
  const c = new Client()
  expect((await c.login(email, PASSWORD)).status).toBe(200)
  return c
}

/** Los fuentes de los chunks que carga la pagina. */
async function fuentesDe(c: Client, ruta: string): Promise<string> {
  const { text } = await c.get(ruta)
  const chunks = [
    ...new Set([...text.matchAll(/\/_next\/static\/chunks\/[a-zA-Z0-9_.-]+\.js/g)].map((m) => m[0])),
  ]
  expect(chunks.length).toBeGreaterThan(0)
  const fuentes = await Promise.all(chunks.map((p) => c.get(p).then((r) => r.text as string)))
  return fuentes.join('\n')
}

describe('/host/requests', () => {
  it('sin sesion no se renderiza', async () => {
    const res = await new Client().get('/host/requests')
    expect(res.status).toBe(401)
  })

  it('un USER sin rol HOST recibe 403, con la URL escrita a mano', async () => {
    const c = await loginAs(ana.email)
    const res = await c.get('/host/requests')
    expect(res.status).toBe(403)
  })

  it('un HOST la ve', async () => {
    const c = await loginAs(hilda.email)
    expect((await c.get('/host/requests')).status).toBe(200)
  })

  it('un ADMIN la ve, aunque no organice nada', async () => {
    await addRole(ana.id, 'ADMIN')
    const c = await loginAs(ana.email)
    expect((await c.get('/host/requests')).status).toBe(200)
  })

  it('con ?plan= sigue respondiendo 200', async () => {
    // El plan elegido viaja en la URL para sobrevivir al F5. Un `?plan=` de mas
    // no puede romper la pagina: si la validacion se colgara de el, un link
    // viejo con el id borrado dejaria al organizador sin pantalla.
    const c = await loginAs(hilda.email)
    expect((await c.get(`/host/requests?plan=${plan.id}`)).status).toBe(200)
  })

  it('con un ?plan= que no existe tampoco rompe el render', async () => {
    const c = await loginAs(hilda.email)
    expect((await c.get('/host/requests?plan=no-existe')).status).toBe(200)
  })

  it('el HTML inicial NO trae las solicitudes ni los planes', async () => {
    // La pantalla es un Client Component. Si aca apareciera el nombre de
    // alguien que pidio unirse, el Server Component estaria leyendo la base por
    // su cuenta, con su propia copia de la regla de "solo el organizador ve
    // esto".
    const c = await loginAs(hilda.email)
    await getPrisma().planParticipant.create({
      data: {
        planId: plan.id,
        userId: beto.id,
        role: 'PARTICIPANT',
        status: 'REQUESTED',
        joinedAt: new Date(),
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    })
    const { text } = await c.get('/host/requests')
    expect(text).not.toContain('Beto Diaz')
    expect(text).not.toContain('Cafe Tortuga')
  })

  it('el chunk pide el selector de planes y las solicitudes del plan', async () => {
    const c = await loginAs(hilda.email)
    const fuentes = await fuentesDe(c, '/host/requests')
    expect(fuentes).toContain('/api/host/plans')
    expect(fuentes).toContain('/requests')
  })

  it('el chunk trae los dos botones de decision', async () => {
    const c = await loginAs(hilda.email)
    const fuentes = await fuentesDe(c, '/host/requests')
    expect(fuentes).toContain('aceptar')
    expect(fuentes).toContain('rechazar')
  })

  it('el chunk trae el texto de "no hay datos" de la alineacion', async () => {
    // La distincion entre `null` y `0` no puede depender de que el que programa
    // el JSX se acuerde. Si este texto viviera solo en el test unitario de
    // `describirAlineacion` y no llegara a la pantalla, la pantalla volveria
    // a poder mostrar un 0% de relleno.
    const c = await loginAs(hilda.email)
    const fuentes = await fuentesDe(c, '/host/requests')
    expect(fuentes).toContain('Sin comparar')
  })

  it('avisa cuando no quedan lugares, en vez de dejar el boton sin explicacion', async () => {
    const c = await loginAs(hilda.email)
    const fuentes = await fuentesDe(c, '/host/requests')
    expect(fuentes).toContain('No quedan lugares')
  })

  it('el plan lleno se avisa arriba, no se oculta', async () => {
    const c = await loginAs(hilda.email)
    const fuentes = await fuentesDe(c, '/host/requests')
    expect(fuentes).toContain('No hay solicitudes pendientes')
  })
})
