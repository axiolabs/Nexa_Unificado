import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { hashPassword } from '../../lib/auth/password'
import { Client } from '../helpers/http'
import { addRole, closeDb, createPlace, createPlan, createUser, rawQuery, resetDb } from '../helpers/db'

/**
 * `/planes/[planId]`: la pantalla de "unirse a un plan".
 *
 * Esta pagina es la primera que se apoya en el `viewer` que se agrego al detalle
 * en §13.6. Sin ese campo, el boton tendria que adivinar el estado del usuario o
 * disparar un POST para averiguarlo; los tests de abajo fijan que la pantalla lo
 * pide al endpoint y no lo infiere.
 *
 * Lo que se verifica aca, y que no se ve en `tsc` ni en el build:
 *
 *   1. El middleware la rechaza sin sesion, escribiendo la URL a mano. `/planes`
 *      esta en `AUTHENTICATED_PREFIXES`, no en `ROUTE_ROLES`: la pagina es de
 *      cualquiera con sesion, no de un rol.
 *   2. Renderiza 200 con sesion, y el HTML trae el cromo del plan.
 *   3. La pantalla PIDE el detalle al endpoint y no lo calcula: en el HTML inicial
 *      no puede haber ni el titulo ni los participantes, porque la pantalla es un
 *      Client Component y el dato llega por `fetch`.
 *
 * Lo que NO se verifica: que el boton funcione. Es el mismo hueco que el del
 * formulario de creacion — no hay DOM en el harness — y la pasada manual de §13.5
 * es lo que cubre ese camino.
 */

const PASSWORD = 'correcto-caballo-grapa-42'

let host: { id: string; email: string }
let ana: { id: string; email: string }
let beto: { id: string; email: string }
let place: { id: string }
let plan: { id: string; startsAt: Date }

beforeEach(async () => {
  await resetDb()
  const passwordHash = await hashPassword(PASSWORD)
  host = await createUser({ email: 'host@example.com', name: 'Hilda Host', passwordHash, roles: ['USER'] })
  await addRole(host.id, 'HOST')
  ana = await createUser({ email: 'ana@example.com', name: 'Ana Ruiz', passwordHash, roles: ['USER'] })
  beto = await createUser({ email: 'beto@example.com', name: 'Beto Diaz', passwordHash, roles: ['USER'] })
  place = await createPlace({ name: 'Cafe Tortuga', lat: -34.6037, lng: -58.3816 })
  plan = await createPlan({
    placeId: place.id,
    creatorId: host.id,
    capacity: 4,
    acceptedCount: 0,
    startsAt: new Date(Date.now() + 86_400_000),
  })
})

afterAll(async () => {
  await closeDb()
})

async function loginAs(email: string): Promise<Client> {
  const c = new Client()
  expect((await c.login(email, PASSWORD)).status).toBe(200)
  return c
}

describe('GET /planes/[planId]', () => {
  it('sin sesion no se renderiza: el middleware rechaza la URL escrita a mano', async () => {
    // `/planes` exige sesion pero NO rol. Este es el unico gate de la pagina: si
    // el middleware no lo tiene, la URL escrita a mano entra.
    const res = await new Client().get(`/planes/${plan.id}`)
    expect(res.status).toBe(401)
  })

  it('un USER sin ningun rol extra llega igual: la pagina no es de un rol', async () => {
    // El detalle lo puede ver cualquiera. Si estuviera en `ROUTE_ROLES` con
    // `['USER']` seria redundante, y cualquier rol nuevo habria que agregarlo a
    // mano para no dejar a nadie afuera.
    const c = await loginAs(ana.email)
    expect((await c.get(`/planes/${plan.id}`)).status).toBe(200)
  })

  it('renderiza 200 con sesion', async () => {
    const c = await loginAs(ana.email)
    const res = await c.get(`/planes/${plan.id}`)
    expect(res.status).toBe(200)
  })

  it('el HTML inicial NO trae los datos del plan: se piden al endpoint', async () => {
    // La pantalla es un Client Component. El titulo, el lugar y los participantes
    // llegan por `fetch`, asi que en el HTML inicial no pueden estar. Si
    // aparecieran, significaria que el Server Component esta consultando la base
    // por su cuenta: una SEGUNDA copia de la regla de visibilidad de §13.6, que
    // es exactamente el bug que esa seccion arreglo.
    const c = await loginAs(ana.email)
    const { text } = await c.get(`/planes/${plan.id}`)
    expect(text).not.toContain('Plan de prueba')
    expect(text).not.toContain('Cafe Tortuga')
    expect(text).not.toContain('Hilda Host')
  })

  it('el link de vuelta al mapa vive en el chunk, no en el HTML', async () => {
    // Lo mismo que el `fetch`: la pantalla es un Client Component, asi que el
    // `Link` no aparece en el HTML inicial. La version anterior de este test
    // afirmaba `/explore` en el HTML y daba verde solo por accidente: el link
    // nunca estuvo ahi. Se busca en el chunk, que es donde vive de verdad.
    const c = await loginAs(ana.email)
    const { text } = await c.get(`/planes/${plan.id}`)
    const chunks = [
      ...new Set(
        [...text.matchAll(/\/_next\/static\/chunks\/[a-zA-Z0-9_.-]+\.js/g)].map((m) => m[0]),
      ),
    ]
    const fuentes = await Promise.all(
      chunks.map((p) => c.get(p).then((r) => r.text as string)),
    )
    expect(fuentes.join('\n')).toContain('/explore')
  })

  it('el client pide el detalle al endpoint, y no inventa la URL', async () => {
    // Como los datos no estan en el HTML, el `fetch` vive en el chunk. Un test
    // que buscara la URL en el HTML daria verde siempre.
    const c = await loginAs(ana.email)
    const { text } = await c.get(`/planes/${plan.id}`)
    const chunks = [
      ...new Set(
        [...text.matchAll(/\/_next\/static\/chunks\/[a-zA-Z0-9_.-]+\.js/g)].map((m) => m[0]),
      ),
    ]
    expect(chunks.length).toBeGreaterThan(0)

    const fuentes = await Promise.all(
      chunks.map((p) => c.get(p).then((r) => r.text as string)),
    )
    const joined = fuentes.join('\n')
    // El endpoint del detalle: sin esto, la pantalla no tendria de donde sacar el
    // `viewer` que decide el estado del boton.
    expect(joined).toContain('/api/plans/')
    // Y el de unirse.
    expect(joined).toContain('/join')
  })

  it('un plan inexistente tambien da 401 sin sesion: el orden de los cortes importa', async () => {
    // Si el inexistente*diera* 404 y el existente 401, el status confirmaria que
    // el plan existe. El middleware corta antes que cualquier consulta.
    const res = await new Client().get('/planes/no-existe-este-id')
    expect(res.status).toBe(401)
  })

  it('suspender la cuenta corta la pagina, no solo la API', async () => {
    const c = await loginAs(ana.email)
    expect((await c.get(`/planes/${plan.id}`)).status).toBe(200)
    await rawQuery('UPDATE "User" SET "suspendedAt" = now() WHERE id = $1', [ana.id])
    expect((await c.get(`/planes/${plan.id}`)).status).toBe(403)
  })
})

/**
 * El endpoint que la pantalla consume. Ya tiene 85 tests en `plans-api.test.ts`;
 * aca se fijan los TRES que la pantalla necesita para pintar su boton, y que son
 * los que justifican que exista `viewer`.
 */
describe('lo que la pantalla necesita del endpoint', () => {
  it('un tercero ve viewer.participation null, o sea puede pedir', async () => {
    const c = await loginAs(ana.email)
    const res = await c.get(`/api/plans/${plan.id}`)
    expect(res.status).toBe(200)
    const body = res.body as {
      plan: {
        title: string
        place: { name: string }
        creator: { name: string }
        participants: unknown[]
        viewer: { isCreator: boolean; participation: null }
        remainingSpots: number
        isFull: boolean
      }
    }
    expect(body.plan.title).toBe('Plan de prueba')
    expect(body.plan.place.name).toBe('Cafe Tortuga')
    expect(body.plan.creator.name).toBe('Hilda Host')
    expect(body.plan.participants).toEqual([])
    expect(body.plan.viewer).toEqual({ isCreator: false, participation: null })
    expect(body.plan.remainingSpots).toBe(4)
    expect(body.plan.isFull).toBe(false)
  })

  it('el organizador ve isCreator, y la pantalla no le ofrece "unirme"', async () => {
    const c = await loginAs(host.email)
    const res = await c.get(`/api/plans/${plan.id}`)
    const body = res.body as { plan: { viewer: { isCreator: boolean } } }
    expect(body.plan.viewer.isCreator).toBe(true)
  })

  it('quien ya pidio ve su propio estado: la pantalla pinta "esperando"', async () => {
    // Este es el estado que, sin `viewer`, solo se podia obtener haciendo un POST
    // con efecto secundario. Es el caso que justifico el endpoint completo.
    const c = await loginAs(ana.email)
    expect((await c.post(`/api/plans/${plan.id}/join`, {})).status).toBe(201)

    const res = await c.get(`/api/plans/${plan.id}`)
    const body = res.body as { plan: { viewer: { participation: { status: string } | null } } }
    expect(body.plan.viewer.participation?.status).toBe('REQUESTED')
  })

  it('el detalle no expone reliability ni emails, aunque los haya', async () => {
    // La pantalla es de cualquiera con sesion. La reliability de terceros vive en
    // `/requests`, que exige ser el organizador: ponerla aca seria filtrar el
    // historial de plantones a todo el mundo.
    const c = await loginAs(ana.email)
    await c.post(`/api/plans/${plan.id}/join`, {})
    const res = await c.get(`/api/plans/${plan.id}`)
    expect(res.text).not.toContain('showUpRate')
    expect(res.text).not.toContain('reliability')
    expect(res.text).not.toContain(ana.email)
  })

  it('un plan lleno llega con isFull, para que la pantalla avise sin adivinar', async () => {
    await rawQuery('UPDATE "Plan" SET "acceptedCount" = 4 WHERE id = $1', [plan.id])
    const c = await loginAs(ana.email)
    const res = await c.get(`/api/plans/${plan.id}`)
    const body = res.body as { plan: { isFull: boolean; remainingSpots: number } }
    expect(body.plan.isFull).toBe(true)
    expect(body.plan.remainingSpots).toBe(0)
  })
})

/**
 * El chat vive en el detalle del plan, asi que su montaje se decide aca.
 *
 * El chat se monta solo si `viewer.participation.status === 'ACCEPTED'`, que es
 * el filtro del endpoint de mensajes. Montarlo para un `REQUESTED` dejaria una
 * caja de texto que responde 403.
 *
 * Lo que se puede verificar sin DOM es poco: la pantalla es un Client Component,
 * asi que la condicion no aparece en el HTML. Lo que SI se verifica es que el
 * chunk del detalle trae la llamada al endpoint de mensajes, y que el endpoint
 * se comporta como la condicion que la pantalla asume. El resto lo cubre la
 * pasada manual.
 */
describe('el chat vive en el detalle', () => {
  it('el chunk del detalle llama al endpoint de mensajes', async () => {
    const c = await loginAs(ana.email)
    const { text } = await c.get(`/planes/${plan.id}`)
    const chunks = [
      ...new Set(
        [...text.matchAll(/\/_next\/static\/chunks\/[a-zA-Z0-9_.-]+\.js/g)].map((m) => m[0]),
      ),
    ]
    const fuentes = await Promise.all(
      chunks.map((p) => c.get(p).then((r) => r.text as string)),
    )
    // Si el chat no estuviera montado, el chunk no tendria esta URL y la
    // pantalla no tendria de donde leer.
    expect(fuentes.join('\n')).toContain('/messages')
  })

  it('el chat del detalle abre para un ACCEPTED y el endpoint lo confirma', async () => {
    // Las dos mitas del mismo contrato: la pantalla monta si `viewer` dice
    // ACCEPTED, y el endpoint responde 200 a ese mismo estado. Si una de las dos
    // se cambiara sin la otra, el chat apareceria roto o cerraria solo.
    const c = await loginAs(ana.email)
    await c.post(`/api/plans/${plan.id}/join`, {})
    await rawQuery(
      'UPDATE "PlanParticipant" SET "status" = \'ACCEPTED\' WHERE "planId" = $1 AND "userId" = $2',
      [plan.id, ana.id],
    )

    const detalle = await c.get(`/api/plans/${plan.id}`)
    const body = detalle.body as { plan: { viewer: { participation: { status: string } | null } } }
    expect(body.plan.viewer.participation?.status).toBe('ACCEPTED')

    expect((await c.get(`/api/plans/${plan.id}/messages`)).status).toBe(200)
  })

  it('el chat NO abre para un REQUESTED, y el endpoint lo coincide', async () => {
    // La contraparte. `viewer` dice REQUESTED, asi que la pantalla no monta el
    // chat; y si la montara, el endpoint le responderia 403. Fijar las dos
    // mitas es lo que evita el caso de una pantalla con un chat que no anda.
    const c = await loginAs(ana.email)
    await c.post(`/api/plans/${plan.id}/join`, {})

    const detalle = await c.get(`/api/plans/${plan.id}`)
    const body = detalle.body as { plan: { viewer: { participation: { status: string } | null } } }
    expect(body.plan.viewer.participation?.status).toBe('REQUESTED')

    expect((await c.get(`/api/plans/${plan.id}/messages`)).status).toBe(403)
  })

  it.each(['ATTENDED', 'NO_SHOW'] as const)(
    'el chat SIGUE abierto con status %s, y el endpoint lo coincide',
    async (status) => {
      // La decision de producto: el plan termino pero el canal no (§15.1 de
      // `docs/decisiones-auth.md`). Las dos mitas del contrato se comprueban
      // juntas otra vez, porque el riesgo real de este cambio no es que el
      // endpoint se cierre: es que la pantalla deje de montar el chat y el
      // endpoint siga respondiendo 200, que es un chat invisible con todo andando
      // y ningun error en ninguna parte.
      const c = await loginAs(ana.email)
      await c.post(`/api/plans/${plan.id}/join`, {})
      await rawQuery('UPDATE "PlanParticipant" SET "status" = $2 WHERE "planId" = $1 AND "userId" = $3', [
        plan.id,
        status,
        ana.id,
      ])

      const detalle = await c.get(`/api/plans/${plan.id}`)
      const body = detalle.body as { plan: { viewer: { participation: { status: string } | null } } }
      // El `viewer` tiene que decir el estado nuevo: es lo que la pantalla mira
      // para decidir el montaje, asi que si el API lo normalizara a `ACCEPTED`
      // el chat abriria por la razon equivocada.
      expect(body.plan.viewer.participation?.status).toBe(status)

      // Y el endpoint tiene que confirmar que ese estado puede usar el chat.
      expect((await c.get(`/api/plans/${plan.id}/messages`)).status).toBe(200)
    },
  )

  it('el organizador tiene el chat, porque su fila es ACCEPTED', async () => {
    // El caso que se puede olvidar: el organizador organiza, pero el chat no lo
    // abre `isCreator`, lo abre el estado de la fila de `PlanParticipant`. Si esa
    // fila no fuera `ACCEPTED`, el organizador veria el plan entero pero sin
    // chat, y el endpoint le responderia 403 a el mismo.
    //
    // La fila se inserta a mano porque el `createPlan` del helper es SQL crudo y
    // no la crea; la crea `POST /api/plans`, que ya tiene su propio test en
    // `plans-api.test.ts` (`viewer.participation` = ACCEPTED/ORGANIZER). Acua se
    // reproduce la fila que esa ruta dejaria.
    await rawQuery(
      `INSERT INTO "PlanParticipant" ("planId", "userId", role, status, "joinedAt")
       VALUES ($1, $2, 'ORGANIZER', 'ACCEPTED', now())`,
      [plan.id, host.id],
    )
    const c = await loginAs(host.email)
    const detalle = await c.get(`/api/plans/${plan.id}`)
    const body = detalle.body as { plan: { viewer: { isCreator: boolean; participation: { status: string } | null } } }
    expect(body.plan.viewer.isCreator).toBe(true)
    expect(body.plan.viewer.participation?.status).toBe('ACCEPTED')

    // Y el endpoint, que es la otra mitad del contrato.
    expect((await c.get(`/api/plans/${plan.id}/messages`)).status).toBe(200)
  })
})

/**
 * Los dos caminos que entran a esta pantalla. Un detalle al que no se llega desde
 * ningun lado es una pagina que no existe para el usuario, por mucho que responda
 * 200: el mapa tiene que ofrecer un link, y el exito de crear tambien.
 */
describe('se puede llegar al detalle', () => {
  it('el listado del mapa ofrece un enlace por plan', async () => {
    const c = await loginAs(ana.email)
    const { text } = await c.get('/explore')
    // El listado es un Client Component, asi que los enlaces de los planes viven
    // en el chunk, no en el HTML. Buscarlos en el HTML daria verde por siempre.
    const chunks = [
      ...new Set(
        [...text.matchAll(/\/_next\/static\/chunks\/[a-zA-Z0-9_.-]+\.js/g)].map((m) => m[0]),
      ),
    ]
    const fuentes = await Promise.all(
      chunks.map((p) => c.get(p).then((r) => r.text as string)),
    )
    const joined = fuentes.join('\n')
    expect(joined).toContain('/planes/')
  })

  it('el enlace del listado apunta al id del plan, no a una pagina fija', async () => {
    const c = await loginAs(ana.email)
    const { text } = await c.get('/explore')
    const chunks = [
      ...new Set(
        [...text.matchAll(/\/_next\/static\/chunks\/[a-zA-Z0-9_.-]+\.js/g)].map((m) => m[0]),
      ),
    ]
    const fuentes = await Promise.all(
      chunks.map((p) => c.get(p).then((r) => r.text as string)),
    )
    // La plantilla del enlace tiene que interpolar el id. Un `/planes/` a secas
    // compila y lleva a un 404, y ningun test lo veria.
    expect(fuentes.join('\n')).toMatch(/\/planes\/\$\{|concat\("\/planes\/"/)
  })

  it('el exito de crear el plan lleva al detalle, no a un texto sin salida', async () => {
    const c = await loginAs(host.email)
    const res = await c.post('/api/plans', {
      title: 'Plan recien creado',
      placeId: place.id,
      startsAt: new Date(Date.now() + 86_400_000).toISOString(),
      capacity: 4,
    })
    expect(res.status).toBe(201)
    const body = res.body as { plan: { id: string } }

    // Ese id tiene que abrir el detalle. Antes de que la pantalla existiera, el
    // exito decia "no hay pagina de detalle todavia" y el host se quedaba con un
    // plan recien creado al que no podia llegar.
    expect((await c.get(`/planes/${body.plan.id}`)).status).toBe(200)
  })
})
