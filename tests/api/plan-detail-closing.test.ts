import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { hashPassword } from '../../lib/auth/password'
import { getPrisma } from '../../lib/db'
import { Client } from '../helpers/http'
import { closeDb, createPlace, createPlan, createUser, joinPlan, resetDb } from '../helpers/db'

/**
 * Que publica `GET /api/plans/[planId]` de un plan ya terminado.
 *
 * El endpoint trae del `select` mas cosas que antes mostraba: la asistencia
 * necesita el estado de cada uno y la calificacion necesita los votos. Traer y
 * publicar son cosas distintas, y este archivo es sobre la segunda.
 *
 * Las dos reglas, en una linea cada una:
 *
 *   1. **Quien no vino es del organizador.** A los demas no se les publica ni el
 *      `status` ni la persona: un `NO_SHOW` desaparece de la lista entera para el
 *      resto. "Ana no vino" en la pantalla del plan es el juicio social entre
 *      personas que el producto existe para eliminar.
 *   2. **Los votos con nombre son del organizador.** El conteo y el promedio son
 *      de todos — son la senal de si valio la pena, sin decir quien opto por
 *      que — y el comentario con nombre, no.
 */

const PASSWORD = 'correcto-caballo-grapa-42'
const HACE_UN_RATO = () => new Date(Date.now() - 3_600_000)

let hilda: { id: string; email: string }
let ana: { id: string; email: string }
let beto: { id: string; email: string }
let ciro: { id: string; email: string }
let nora: { id: string; email: string }
let place: { id: string }
let plan: { id: string }

type Detalle = {
  participants: { user: { id: string; name: string }; role: string; status: string | null }[]
  ratings: {
    count: number
    average: number | null
    mine: { rating: number; tags: string[] } | null
    detail: { user: { id: string; name: string }; rating: number; tags: string[] }[] | null
    tags: { id: string; count: number }[]
  }
  viewer: { isCreator: boolean; participation: { status: string } | null }
}

beforeEach(async () => {
  await resetDb()
  const passwordHash = await hashPassword(PASSWORD)
  hilda = await createUser({ email: 'hilda@example.com', name: 'Hilda Host', passwordHash })
  ana = await createUser({ email: 'ana@example.com', name: 'Ana Ruiz', passwordHash })
  beto = await createUser({ email: 'beto@example.com', name: 'Beto Diaz', passwordHash })
  ciro = await createUser({ email: 'ciro@example.com', name: 'Ciro Ruiz', passwordHash })
  nora = await createUser({ email: 'nora@example.com', name: 'Nora Paz', passwordHash })
  place = await createPlace({ name: 'Cafe Tortuga', lat: -34.6037, lng: -58.3816 })
  plan = await createPlan({
    placeId: place.id,
    creatorId: hilda.id,
    startsAt: HACE_UN_RATO(),
    capacity: 6,
  })

  // Hilda organiza y asiste, Ana asiste, Beto no vino, Ciro sigue sin resolver y
  // Nora se dio de baja: los cuatro estados que la lista tiene que distinguir.
  await joinPlan({ planId: plan.id, userId: hilda.id, status: 'ATTENDED', role: 'ORGANIZER' })
  await joinPlan({ planId: plan.id, userId: ana.id, status: 'ATTENDED' })
  await joinPlan({ planId: plan.id, userId: beto.id, status: 'NO_SHOW' })
  await joinPlan({ planId: plan.id, userId: ciro.id, status: 'ACCEPTED' })
  await joinPlan({ planId: plan.id, userId: nora.id, status: 'DECLINED' })
})

afterAll(async () => {
  await closeDb()
})

async function detalleDe(email: string): Promise<Detalle> {
  const c = new Client()
  expect((await c.login(email, PASSWORD)).status).toBe(200)
  const res = await c.get(`/api/plans/${plan.id}`)
  expect(res.status).toBe(200)
  return (res.body as { plan: Detalle }).plan
}

/** Los ids de la lista, ordenados: los fixtures usan UUID aleatorio. */
function ids(d: Detalle): string[] {
  return d.participants.map((p) => p.user.id).sort()
}

describe('la lista de participantes', () => {
  it('el organizador ve el estado de cada uno, y ve tambien al que no vino', async () => {
    const d = await detalleDe(hilda.email)

    expect(d.viewer.isCreator).toBe(true)
    expect(ids(d)).toEqual([hilda.id, ana.id, beto.id, ciro.id].sort())
    const porId = new Map(d.participants.map((p) => [p.user.id, p.status]))
    expect(porId.get(hilda.id)).toBe('ATTENDED')
    expect(porId.get(ana.id)).toBe('ATTENDED')
    expect(porId.get(beto.id)).toBe('NO_SHOW')
    // El `ACCEPTED` sin marcar tambien se ve: es el que le falta marcar.
    expect(porId.get(ciro.id)).toBe('ACCEPTED')
  })

  it('el organizador no ve al que se declines', async () => {
    // La regla vieja sigue vigente con la lista nueva: `DECLINED` no va a ESTE
    // plan, sigue siendo usuario del lugar y nada mas.
    const d = await detalleDe(hilda.email)
    expect(ids(d)).not.toContain(nora.id)
  })

  it('a quien no organiza no le sale el status de nadie, ni el suyo', async () => {
    const d = await detalleDe(ana.email)

    // Ni el propio: eso sale de `viewer.participation`, que es el unico lugar
    // con el estado propio. Duplicarlo aca seria una segunda fuente de verdad.
    expect(d.viewer.isCreator).toBe(false)
    expect(d.viewer.participation).toMatchObject({ status: 'ATTENDED' })
    expect(d.participants.every((p) => p.status === null)).toBe(true)
  })

  it('a quien no organiza no le aparece siquiera la persona que no vino', async () => {
    // La parte fuerte de la regla, y la que un `map` sin `filter` arruinaria:
    // con el status en `null` pero la fila presente, el nombre igual queda en el
    // JSON y el boton se puede pintar.
    const d = await detalleDe(ana.email)

    expect(ids(d)).toEqual([hilda.id, ana.id, ciro.id].sort())
    expect(d.participants.some((p) => p.user.id === beto.id)).toBe(false)
  })

  it('tampoco para un NO_SHOW: la regla es del organizador, no de los demas', async () => {
    const d = await detalleDe(beto.email)

    expect(d.participants.every((p) => p.status === null)).toBe(true)
    expect(ids(d)).not.toContain(beto.id)
    // Su propio estado si se lo dice, porque es dato propio.
    expect(d.viewer.participation).toMatchObject({ status: 'NO_SHOW' })
  })
})

describe('las calificaciones que publica el detalle', () => {
  beforeEach(async () => {
    // Cada uno con un juego de etiquetas distinto, para poder afirmar sobre las
    // del otro y no sobre las propias (que si tienen que estar, en `mine`).
    // Tags distintas y no texto: el texto libre se elimino en §16.10, asi que lo
    // que se afirma aca es que las etiquetas del otro tampoco se publican.
    await getPrisma().rating.create({
      data: { planId: plan.id, authorId: ana.id, rating: 5, tags: ['vale_la_pena', 'volveria'] },
    })
    await getPrisma().rating.create({
      data: { planId: plan.id, authorId: hilda.id, rating: 3, tags: ['faltaron_espacios'] },
    })
  })

  it('el organizador ve la lista con nombre y etiquetas', async () => {
    const d = await detalleDe(hilda.email)

    expect(d.ratings.count).toBe(2)
    expect(d.ratings.detail).toHaveLength(2)
    const porQuien = new Map(d.ratings.detail!.map((r) => [r.user.id, r]))
    expect(porQuien.get(ana.id)).toMatchObject({ rating: 5, tags: ['vale_la_pena', 'volveria'] })
    expect(porQuien.get(hilda.id)).toMatchObject({ rating: 3, tags: ['faltaron_espacios'] })
  })

  it('el conteo de etiquetas es anonimo y va para todos', async () => {
    // Mismo criterio que el promedio: "el 80% dice buena comida" le sirve al
    // siguiente que va sin exponer a quien marco que. Y el orden no depende de
    // quien mira, asi que el mismo plan se lee igual en cualquier sesion.
    const paraTodos = [
      await detalleDe(ana.email),
      await detalleDe(hilda.email),
      await detalleDe(beto.email),
    ]
    for (const d of paraTodos) {
      // Cada etiqueta aparece una vez, asi que el desempate es por id y el
      // orden es alfabetico. Si el orden hubiera dependido del viewer, este bucle
      // fallaria en la segunda sesion.
      expect(d.ratings.tags).toEqual([
        { id: 'faltaron_espacios', count: 1 },
        { id: 'vale_la_pena', count: 1 },
        { id: 'volveria', count: 1 },
      ])
    }
    // Y el conteo no dice de quien: el item es `{ id, count }` y nada mas. Que
    // no lleve un id de persona es la mitad de por que se puede publicar.
    expect(Object.keys(paraTodos[0].ratings.tags[0]).sort()).toEqual(['count', 'id'])
  })

  it('quien no organiza recibe el promedio pero no la lista', async () => {
    const d = await detalleDe(ana.email)

    // El promedio si: es la senal anonima de si valo la pena, y quien acaba de
    // calificar quiere ver que su voto conto.
    expect(d.ratings.count).toBe(2)
    expect(d.ratings.average).toBe(4)
    expect(d.ratings.detail).toBeNull()
    // **La etiqueta de Hildas si aparece, y tiene que aparecer.** El set es de
    // ocho valores, as que el conteo agregado no puede revelar de mas: no hay
    // nada secreto en el texto. Lo privado es la atribucion, no el contenido.
    // Por eso la afirmacion no es "no aparece `faltaron_espacios`" —eso seria
    // falso y ademasografia el promedio en anonimo— sino "no aparece con nombre
    // de quien lo marco".
    expect(d.ratings.tags).toContainEqual({ id: 'faltaron_espacios', count: 1 })
    // Y las propias si, en `mine`: es informacion propia y hace falta para
    // precargar el formulario si se quiere corregir.
    expect(d.ratings.mine).toMatchObject({ tags: ['vale_la_pena', 'volveria'] })
  })

  it('la lista con nombre es la unica que atribuye, y solo la ve quien organiza', async () => {
    // El atributo de "quien dijo que" vive en un solo lugar de la respuesta, y ese
    // lugar es `detail`, que es `null` para todos menos el organizador. Si
    // aparezca un `userId` al lado de un tag del conteo, la attribucion se
    // habria duplicado y con ella el problema.
    const paraAna = await detalleDe(ana.email)
    const paraHilda = await detalleDe(hilda.email)

    // El conteo es identico byte a byte para las dos: mismo plan, mismo dato.
    expect(JSON.stringify(paraAna.ratings.tags)).toBe(JSON.stringify(paraHilda.ratings.tags))
    expect(paraHilda.ratings.detail).not.toBeNull()
    // Y el `detail` del organizador es el unico lugar de la respuesta que tiene
    // un tag junto a un nombre de persona.
    const conNombre = paraHilda.ratings.detail!.filter((r) => r.tags.includes('faltaron_espacios'))
    expect(conNombre).toHaveLength(1)
    expect(conNombre[0].user.name).toBeTruthy()
  })

  it('un NO_SHOW recibe el promedio y tampoco la lista', async () => {
    const d = await detalleDe(beto.email)

    expect(d.ratings.average).toBe(4)
    expect(d.ratings.detail).toBeNull()
    expect(d.ratings.mine).toBeNull()
  })

  it('mine es el voto propio y nada mas', async () => {
    // El bug clasico es mandar el detalle entero y que el cliente filtre por
    // `authorId`. Acá el filtro viene hecho, y esto lo dice.
    expect((await detalleDe(ana.email)).ratings.mine).toMatchObject({
      rating: 5,
      tags: ['vale_la_pena', 'volveria'],
    })
    expect((await detalleDe(hilda.email)).ratings.mine).toMatchObject({
      rating: 3,
      tags: ['faltaron_espacios'],
    })
  })

  it('un ACCEPTED ve el promedio pero tiene mine en null', async () => {
    // Ciro no califico todavia: ve el promedio del plan (lo que le diria "aca se
    // viene bien") y no tiene voto propio.
    const d = await detalleDe(ciro.email)
    expect(d.ratings.mine).toBeNull()
    expect(d.ratings.average).toBe(4)
    expect(d.ratings.detail).toBeNull()
  })
})

describe('sin ninguna calificacion', () => {
  it('el promedio es null y no cero, y el conteo es 0', async () => {
    const d = await detalleDe(ana.email)

    // `null` y no 0: cero estrellas es una opinion, "nadie califico todavia" no
    // lo es. La pantalla tiene que poder distinguir las dos.
    expect(d.ratings.count).toBe(0)
    expect(d.ratings.average).toBeNull()
    expect(d.ratings.mine).toBeNull()
  })

  it('el organizador recibe una lista vacia, y no null', async () => {
    // `null` significa "no te toca ver la lista" y `[]` significa "la podes ver y
    // no hay nada". El organizador esta en el primer caso nunca, asi que su
    // seccion puede pintar "todavia no califico nadie" sin preguntar nada.
    const d = await detalleDe(hilda.email)
    expect(d.ratings.detail).toEqual([])
  })
})
