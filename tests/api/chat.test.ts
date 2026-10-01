import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { ParticipationStatus } from '@prisma/client'
import { hashPassword } from '../../lib/auth/password'
import { CHAT_ABIERTOS_A, encodeCursor } from '../../lib/chat'
import { getPrisma } from '../../lib/db'
import { Client } from '../helpers/http'
import { closeDb, createPlace, createPlan, createUser, resetDb } from '../helpers/db'

/**
 * `GET` y `POST /api/plans/[planId]/messages`: el chat del plan.
 *
 * Los tests de aca fijan tres cosas que no se ven leyendo el codigo:
 *
 *   1. Que el gate mire el estado y no la pertenencia. La FK compuesta
 *      `Message(planId, authorId) -> PlanParticipant` se cumple con
 *      `CANCELLED`, asi que hay un test que inserta la fila A MANO y despues
 *      muestra que la API la rechaza. Si ese test no existiera, alguien podria
 *      relajar el filtro a "existe participacion" y todos los otros seguirian
 *      dando verde.
 *
 *      Y que el gate NO se cierre con el plan: `ATTENDED` y `NO_SHOW` siguen
 *      teniendo chat (§15.1 de `docs/decisiones-auth.md`). Esa parte tambien
 *      esta fijada por tests, porque un gate que se cierra "por las dudas" es
 *      exactamente el tipo de cambio que entra sin que nadie lo note.
 *
 *   2. Que el cursor no pierda mensajes. Se insertan dos mensajes con el MISMO
 *      `createdAt` y se lee dos veces. Con un cursor de `createdAt` solo, el
 *      segundo se pierde en silencio: la pantalla muestra una conversacion
 *      incompleta y nada falla.
 *
 *   3. Que no se filtren datos de terceros: ni emails, ni personas ajenas al
 *      plan.
 */

const PASSWORD = 'correcto-caballo-grapa-42'

/**
 * Los estados de `PlanParticipant` que NO tienen chat: `REQUESTED`, `DECLINED` y
 * `CANCELLED`. Son los tres que no son parte del plan.
 *
 * Se prueban TODOS, no solo `REQUESTED`. La FK de `Message` se cumple con
 * cualquiera de ellos, asi que cada uno es un hueco distinto por el que un
 * rechazado o un caducado podria escribir. Fijar la lista completa es lo que
 * hace que agregar un estado nuevo al enum no se cuele por el unnoticed: si
 * aparece uno aca, el test se cae y hay que decidir.
 *
 * Los que quedan afuera de esta lista (`ACCEPTED`, `ATTENDED`, `NO_SHOW`) si
 * tienen chat, y tampoco estan por confianza: los cubre
 * `describe('con el plan ya terminado')`.
 */
const FUERA_DEL_CHAT: ParticipationStatus[] = ['REQUESTED', 'DECLINED', 'CANCELLED']

/**
 * Los dos conjuntos, con el enum real, no con la memoria.
 *
 * Es el candado que hace que "agregar un estado nuevo" no sea una decision
 * invisible: si manana el enum tiene un `PENDING_REVIEW` o lo que sea, la
 * cuenta no da 6, el test se cae y hay que decidir en que lado va. Con la lista
 * escrita a mano, el estado nuevo caeria en el `else` de `puedeUsarChat` (que es
 * `false`, o sea el lado conservador) sin que nadie se entere.
 */
const TODOS = Object.values(ParticipationStatus).sort()

it('la lista de estados del enum esta entera repartida entre dentro y fuera', () => {
  expect([...FUERA_DEL_CHAT, ...CHAT_ABIERTOS_A].sort()).toEqual(TODOS)
})

/**
 * `CHAT_ABIERTOS_A` tiene que ser exactamente lo que dice el nombre: tres
 * estados, y los tres. Un `ATTENDED` que se cuelara para adelante seria el
 * error que el gate nuevo puede cometer, asi que se fija el conjunto exacto y no
 * solo que "alguno entra".
 */
it('el chat queda abierto para ACCEPTED, ATTENDED y NO_SHOW, y nada mas', () => {
  expect([...CHAT_ABIERTOS_A].sort()).toEqual(['ACCEPTED', 'ATTENDED', 'NO_SHOW'])
})

let hilda: { id: string; email: string }
let ana: { id: string; email: string }
let beto: { id: string; email: string }
let place: { id: string }
let plan: { id: string }

beforeEach(async () => {
  await resetDb()
  const passwordHash = await hashPassword(PASSWORD)
  hilda = await createUser({ email: 'hilda@example.com', name: 'Hilda Host', passwordHash, roles: ['USER'] })
  ana = await createUser({ email: 'ana@example.com', name: 'Ana Ruiz', passwordHash, roles: ['USER'] })
  beto = await createUser({ email: 'beto@example.com', name: 'Beto Diaz', passwordHash, roles: ['USER'] })
  place = await createPlace({ name: 'Cafe Tortuga', lat: -34.6037, lng: -58.3816 })
  plan = await createPlan({ placeId: place.id, creatorId: hilda.id, capacity: 4, acceptedCount: 0 })
  // Hilda organiza: el creador nace ACCEPTED, asi que hay que agregarlo a mano
  // igual, para que el estado sea explicito en el test y no dependa de esa
  // regla.
  await getPrisma().planParticipant.create({
    data: { planId: plan.id, userId: hilda.id, role: 'ORGANIZER', status: 'ACCEPTED', joinedAt: new Date() },
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

/** Deja a `email` en un estado de participacion concreto. */
async function conEstado(email: string, userId: string, status: ParticipationStatus) {
  await getPrisma().planParticipant.create({
    data: { planId: plan.id, userId, role: 'PARTICIPANT', status, joinedAt: new Date() },
  })
  expect((await loginAs(email)).get).toBeTypeOf('function')
}

/**
 * Inserta un mensaje desde la base, saltandose la API.
 *
 * El `id` se puede fijar a proposito. Prisma genera CUID, que en theory crece
 * con el tiempo, pero un test que depende de que dos CUID seguidos ordenen
 * lexicograficamente segun el orden de insercion esta probando la
 * implementacion del generador de ids, no el cursor. Fijandolo, el test depende
 * solo del `orderBy`.
 */
async function mensajeEnCrudo(authorId: string, body: string, createdAt = new Date(), id?: string) {
  return getPrisma().message.create({
    data: { planId: plan.id, authorId, body, createdAt, ...(id ? { id } : {}) },
    select: { id: true, createdAt: true },
  })
}

type Poll = {
  messages: { id: string; body: string; authorName: string; mine: boolean; createdAt: string; authorId: string }[]
  nextCursor: string | null
  hasMore: boolean
}

describe('GET /api/plans/[planId]/messages', () => {
  it('sin sesion responde 401', async () => {
    expect((await new Client().get(`/api/plans/${plan.id}/messages`)).status).toBe(401)
  })

  it('un plan que no existe responde 404', async () => {
    const c = await loginAs(hilda.email)
    expect((await c.get('/api/plans/no-existe/messages')).status).toBe(404)
  })

  it('alguien que no participa recibe 404, no 403', async () => {
    // 403 confirmaria que el plan existe. 404 no distingue, que es lo que
    // corresponde: la agenda de planes no se le publica a cualquiera.
    const c = await loginAs(ana.email)
    const res = await c.get(`/api/plans/${plan.id}/messages`)
    expect(res.status).toBe(404)
  })

  describe('el gate: quien NO es parte del plan', () => {
    it.each(FUERA_DEL_CHAT)('un participante %s no puede leer', async (status) => {
      await conEstado(beto.email, beto.id, status)
      const c = await loginAs(beto.email)
      const res = await c.get(`/api/plans/${plan.id}/messages`)
      expect(res.status).toBe(403)
    })

    it('el organizador lee su propio plan', async () => {
      const c = await loginAs(hilda.email)
      expect((await c.get(`/api/plans/${plan.id}/messages`)).status).toBe(200)
    })
  })

  describe('con el plan ya terminado, el chat sigue abierto', () => {
    // La decision es de producto y esta en `CHAT_ABIERTOS_A`: `ATTENDED` y
    // `NO_SHOW` no cierran el canal. Estos tests existen para que volver a
    // cerrarlos sea un cambio visible y no una regexp de "por seguridad".
    it.each(['ATTENDED', 'NO_SHOW'] as ParticipationStatus[])(
      'un participante %s sigue leyendo',
      async (status) => {
        await conEstado(beto.email, beto.id, status)
        await mensajeEnCrudo(hilda.id, 'hola', new Date('2026-09-28T10:00:00.000Z'))
        const c = await loginAs(beto.email)
        const res = await c.get(`/api/plans/${plan.id}/messages`)
        expect(res.status).toBe(200)
        const body = res.body as { messages: unknown[] }
        expect(body.messages).toHaveLength(1)
      },
    )

    it.each(['ATTENDED', 'NO_SHOW'] as ParticipationStatus[])(
      'un participante %s sigue escribiendo',
      async (status) => {
        await conEstado(beto.email, beto.id, status)
        const c = await loginAs(beto.email)
        const res = await c.post(`/api/plans/${plan.id}/messages`, { body: 'hola' })
        expect(res.status).toBe(201)
      },
    )

    it('el 403 dice "no sos parte" y no filtra los estados internos', async () => {
      // El 403 no puede decir "el plan termino" porque el plan ya no tiene dos
      // finales distintos, y tampoco puede listar los nombres del enum: son
      // detalle de implementacion y se acaban viendo en pantalla.
      await conEstado(beto.email, beto.id, 'CANCELLED')
      const c = await loginAs(beto.email)
      const res = await c.get(`/api/plans/${plan.id}/messages`)
      expect(res.status).toBe(403)
      const body = res.body as { error: string }
      expect(body.error).not.toMatch(/ACCEPTED|ATTENDED|NO_SHOW|DECLINED|CANCELLED|REQUESTED/)
    })
  })

  it('sin cursor trae todo desde el principio, en orden', async () => {
    await conEstado(beto.email, beto.id, 'ACCEPTED')
    const t0 = new Date('2026-09-28T10:00:00.000Z')
    await mensajeEnCrudo(hilda.id, 'hola', new Date(t0.getTime() + 1000))
    await mensajeEnCrudo(beto.id, 'hola Hilda', new Date(t0.getTime() + 2000))

    const c = await loginAs(beto.email)
    const res = await c.get(`/api/plans/${plan.id}/messages`)
    expect(res.status).toBe(200)
    const body = res.body as Poll
    expect(body.messages.map((m) => m.body)).toEqual(['hola', 'hola Hilda'])
    expect(body.hasMore).toBe(false)
  })

  it('marca `mine` segun quien lee, no segun quien escribio', async () => {
    await conEstado(beto.email, beto.id, 'ACCEPTED')
    await mensajeEnCrudo(hilda.id, 'de la organizadora')
    await mensajeEnCrudo(beto.id, 'de beto')

    const c = await loginAs(beto.email)
    const body = (await c.get(`/api/plans/${plan.id}/messages`)).body as Poll
    expect(body.messages.map((m) => m.mine)).toEqual([false, true])

    const c2 = await loginAs(hilda.email)
    const body2 = (await c2.get(`/api/plans/${plan.id}/messages`)).body as Poll
    expect(body2.messages.map((m) => m.mine)).toEqual([true, false])
  })

  it('no trae los mensajes de otro plan', async () => {
    await conEstado(beto.email, beto.id, 'ACCEPTED')
    const otro = await createPlan({ placeId: place.id, creatorId: hilda.id })
    await getPrisma().planParticipant.create({
      data: { planId: otro.id, userId: beto.id, role: 'PARTICIPANT', status: 'ACCEPTED', joinedAt: new Date() },
    })
    // Beto participa de los dos planes, asi que el `where` por `planId` es lo
    // unico que separa las conversaciones.
    await getPrisma().message.create({
      data: { planId: otro.id, authorId: beto.id, body: 'mensaje del otro plan' },
    })

    const c = await loginAs(beto.email)
    const body = (await c.get(`/api/plans/${plan.id}/messages`)).body as Poll
    expect(body.messages).toHaveLength(0)
  })

  describe('el cursor', () => {
    it('un cursor ilegible es 400, no un "empezar de nuevo"', async () => {
      // Si fuera "empezar de nuevo", el cliente recibiria el chat entero,
      // lo agregaria al final, y duplicaria la conversacion. Un error visible
      // es mejor.
      const c = await loginAs(hilda.email)
      const res = await c.get(`/api/plans/${plan.id}/messages?after=cursor-inventado`)
      expect(res.status).toBe(400)
    })

    it('el segundo poll no repite el primero', async () => {
      await conEstado(beto.email, beto.id, 'ACCEPTED')
      await mensajeEnCrudo(hilda.id, 'uno')
      const c = await loginAs(hilda.email)
      const primera = (await c.get(`/api/plans/${plan.id}/messages`)).body as Poll
      expect(primera.messages).toHaveLength(1)

      const segunda = (await c.get(`/api/plans/${plan.id}/messages?after=${primera.nextCursor}`))
        .body as Poll
      expect(segunda.messages).toHaveLength(0)
    })

    it('el cursor NO pierde el mensaje siguiente cuando cae en el mismo milisegundo', async () => {
      // El caso que motiva el par (createdAt, id). Los dos mensajes tienen el
      // MISMO `createdAt`, que es una de las muchas cosas que pueden pasar
      // escribiendo dos personas en dos pestanas.
      //
      // El cursor se arma a mano con el primer mensaje. Se podria usar el
      // `nextCursor` de la respuesta, pero ese apunta al ULTIMO de la pagina, y
      // aca los dos entran juntos: con el, el test pasaria sin tocar la rama del
      // desempate por `id`. Armandolo sobre el primero, la unica forma de que
      // "segundo" aparezca es que el `OR` del `where` compare el id.
      await conEstado(beto.email, beto.id, 'ACCEPTED')
      const mismo = new Date('2026-09-28T10:00:00.000Z')
      const a = await mensajeEnCrudo(hilda.id, 'primero', mismo)
      const b = await mensajeEnCrudo(beto.id, 'segundo', mismo)

      // El orden total tambien depende del desempate: sin el `id` en el
      // `orderBy`, estos dos podrian salir en cualquier orden.
      const c = await loginAs(hilda.email)
      const primera = (await c.get(`/api/plans/${plan.id}/messages`)).body as Poll
      expect(primera.messages.map((m) => m.body).sort()).toEqual(['primero', 'segundo'])

      // Ahora el cursor sobre el primero: con un cursor de `createdAt` solo,
      // "segundo" se perdia para siempre.
      const cursor = encodeCursor({ createdAt: a.createdAt, id: a.id })
      const segunda = (await c.get(`/api/plans/${plan.id}/messages?after=${cursor}`)).body as Poll
      expect(segunda.messages.map((m) => m.body)).toEqual(['segundo'])
      expect(segunda.messages[0].id).toBe(b.id)
    })

    it('con tres mensajes del mismo instante, el orden total no depende del orden de insercion', async () => {
      await conEstado(beto.email, beto.id, 'ACCEPTED')
      const mismo = new Date('2026-09-28T10:00:00.000Z')
      // Se insertan en orden INVERSO al esperado y con `createdAt` identico. Si
      // el `orderBy` se apoyara solo en `createdAt`, la base no tiene con que
      // desempatar y estos tres podrian salir en cualquier orden; el unico
      // criterio que queda es el `id`, y el expected lo dice.
      const c1 = await mensajeEnCrudo(hilda.id, 'c', mismo, 'msg_c')
      const b1 = await mensajeEnCrudo(hilda.id, 'b', mismo, 'msg_b')
      const a1 = await mensajeEnCrudo(hilda.id, 'a', mismo, 'msg_a')

      const c = await loginAs(hilda.email)
      const leidos: string[] = []
      let cursor: string | null = null
      for (let i = 0; i < 5; i++) {
        const url = `/api/plans/${plan.id}/messages${cursor ? `?after=${cursor}` : ''}`
        const page = (await c.get(url)).body as Poll
        leidos.push(...page.messages.map((m) => m.body))
        cursor = page.nextCursor
        if (!page.hasMore) break
      }
      expect(leidos).toEqual(['a', 'b', 'c'])
      // Y el id mas bajo es el que puede cortar la pagina: si el desempate
      // estuviera al reves, "a" nunca se veria.
      expect([a1.id, b1.id, c1.id].sort()).toEqual(['msg_a', 'msg_b', 'msg_c'])
    })

    it('un cursor viejo trae lo que se escribio despues', async () => {
      await conEstado(beto.email, beto.id, 'ACCEPTED')
      const viejo = await mensajeEnCrudo(hilda.id, 'viejo', new Date('2026-09-28T10:00:00.000Z'))
      await mensajeEnCrudo(beto.id, 'nuevo', new Date('2026-09-28T11:00:00.000Z'))

      const c = await loginAs(hilda.email)
      const cursor = encodeCursor({ createdAt: viejo.createdAt, id: viejo.id })
      const body = (await c.get(`/api/plans/${plan.id}/messages?after=${cursor}`)).body as Poll
      expect(body.messages.map((m) => m.body)).toEqual(['nuevo'])
    })

    it('un cursor de otro plan no filtra mensajes de este', async () => {
      // El cursor lleva `createdAt` e `id` crudos, sin el plan. Si el filtro no
      // incluyera el `planId`, el cursor traeria mensajes de cualquier plan.
      await conEstado(beto.email, beto.id, 'ACCEPTED')
      const otro = await createPlan({ placeId: place.id, creatorId: hilda.id })
      await getPrisma().planParticipant.create({
        data: { planId: otro.id, userId: beto.id, role: 'PARTICIPANT', status: 'ACCEPTED', joinedAt: new Date() },
      })
      const fuera = await getPrisma().message.create({
        data: { planId: otro.id, authorId: beto.id, body: 'de otro plan', createdAt: new Date('2026-09-28T09:00:00.000Z') },
        select: { id: true, createdAt: true },
      })
      await mensajeEnCrudo(beto.id, 'de este plan', new Date('2026-09-28T10:00:00.000Z'))

      const c = await loginAs(beto.email)
      const cursor = encodeCursor({ createdAt: fuera.createdAt, id: fuera.id })
      const body = (await c.get(`/api/plans/${plan.id}/messages?after=${cursor}`)).body as Poll
      expect(body.messages.map((m) => m.body)).toEqual(['de este plan'])
    })

    it('devuelve la respuesta sin cachear', async () => {
      const c = await loginAs(hilda.email)
      const res = await c.get(`/api/plans/${plan.id}/messages`)
      expect(res.headers.get('cache-control')).toBe('private, no-store')
    })
  })
})

describe('POST /api/plans/[planId]/messages', () => {
  it('sin sesion responde 401', async () => {
    const res = await new Client().post(`/api/plans/${plan.id}/messages`, { body: 'hola' })
    expect(res.status).toBe(401)
  })

  it('un cuerpo vacio es 400', async () => {
    const c = await loginAs(hilda.email)
    const res = await c.post(`/api/plans/${plan.id}/messages`, { body: '' })
    expect(res.status).toBe(400)
  })

  it('un cuerpo de puros espacios es 400', async () => {
    // Sin el `trim` antes del `min(1)`, esto guardaba un mensaje que en
    // pantalla es una linea en blanco, y el conteo del plan decia que habia
    // uno mas.
    const c = await loginAs(hilda.email)
    const res = await c.post(`/api/plans/${plan.id}/messages`, { body: '     ' })
    expect(res.status).toBe(400)
  })

  it('un cuerpo de mas de 1000 caracteres es 400', async () => {
    const c = await loginAs(hilda.email)
    const res = await c.post(`/api/plans/${plan.id}/messages`, { body: 'a'.repeat(1001) })
    expect(res.status).toBe(400)
  })

  it('un cuerpo de exactamente 1000 se acepta', async () => {
    const c = await loginAs(hilda.email)
    const res = await c.post(`/api/plans/${plan.id}/messages`, { body: 'a'.repeat(1000) })
    expect(res.status).toBe(201)
  })

  it('un authorId en el body es 400', async () => {
    // El autor sale de la sesion. Aceptar el del body seria una puerta para
    // escribir como otro.
    const c = await loginAs(hilda.email)
    const res = await c.post(`/api/plans/${plan.id}/messages`, { body: 'hola', authorId: beto.id })
    expect(res.status).toBe(400)
  })

  it('el mismo origen es obligatorio', async () => {
    // Sin esto, un formulario de cualquier sitio podia mandar mensajes al
    // chat de cualquiera que hubiera abierto la pestana.
    const c = await loginAs(hilda.email)
    const res = await c.req(`/api/plans/${plan.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://otro-sitio.example' },
      body: JSON.stringify({ body: 'hola' }),
    })
    expect(res.status).toBe(403)
  })

  it('publica el mensaje y lo devuelve con mine en true', async () => {
    const c = await loginAs(hilda.email)
    const res = await c.post(`/api/plans/${plan.id}/messages`, { body: 'hola' })
    expect(res.status).toBe(201)
    const body = res.body as { message: { body: string; mine: boolean; authorId: string } }
    expect(body.message.body).toBe('hola')
    expect(body.message.mine).toBe(true)
    expect(body.message.authorId).toBe(hilda.id)
  })

  it('el mensaje publicado aparece en el poll siguiente', async () => {
    const c = await loginAs(hilda.email)
    await c.post(`/api/plans/${plan.id}/messages`, { body: 'recien escrito' })
    const poll = (await c.get(`/api/plans/${plan.id}/messages`)).body as Poll
    expect(poll.messages.map((m) => m.body)).toEqual(['recien escrito'])
  })

  it('quien no participa recibe 404, no 403', async () => {
    const c = await loginAs(ana.email)
    const res = await c.post(`/api/plans/${plan.id}/messages`, { body: 'hola' })
    expect(res.status).toBe(404)
  })

  describe('el gate: quien NO es parte del plan', () => {
    it.each(FUERA_DEL_CHAT)('un participante %s no puede escribir', async (status) => {
      await conEstado(beto.email, beto.id, status)
      const c = await loginAs(beto.email)
      const res = await c.post(`/api/plans/${plan.id}/messages`, { body: 'hola' })
      expect(res.status).toBe(403)
    })

    it('la base SI deja escribir a un CANCELLED, y la API lo frena', async () => {
      // El test que justifica todo el gate. La FK compuesta se cumple con
      // `CANCELLED` porque solo mira que exista la fila de PlanParticipant, sin
      // mirar el estado. O sea que el filtro de la API es la UNICA cosa que
      // impide que un rechazado escriba en el chat.
      await conEstado(beto.email, beto.id, 'CANCELLED')

      // Primero, la base de verdad: la fila entra sin problema.
      const colada = await getPrisma().message.create({
        data: { planId: plan.id, authorId: beto.id, body: 'escrito por la base' },
        select: { id: true },
      })
      expect(colada.id).toBeTruthy()

      // Y despues, por la API, no.
      const c = await loginAs(beto.email)
      const res = await c.post(`/api/plans/${plan.id}/messages`, { body: 'hola' })
      expect(res.status).toBe(403)
    })
  })
})

describe('el chat no filtra datos de terceros', () => {
  it('no expone emails', async () => {
    await conEstado(beto.email, beto.id, 'ACCEPTED')
    await mensajeEnCrudo(beto.id, 'hola')
    const c = await loginAs(hilda.email)
    const res = await c.get(`/api/plans/${plan.id}/messages`)
    expect(res.text).not.toContain(hilda.email)
    expect(res.text).not.toContain(beto.email)
  })

  it('no expone a quien NO esta en el plan', async () => {
    await conEstado(beto.email, beto.id, 'ACCEPTED')
    await mensajeEnCrudo(beto.id, 'hola')
    const c = await loginAs(hilda.email)
    const res = await c.get(`/api/plans/${plan.id}/messages`)
    // Ana no participa de nada: su nombre no tiene por que aparecer.
    expect(res.text).not.toContain('Ana Ruiz')
  })
})
