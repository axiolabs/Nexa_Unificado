import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { hashPassword } from '../../lib/auth/password'
import { getPrisma } from '../../lib/db'
import { ETIQUETAS_EXPERIENCIA_IDS, RATING_TAGS_MAX } from '../../lib/ratings'
import { Client } from '../helpers/http'
import { closeDb, createPlace, createPlan, createUser, joinPlan, rawQuery, resetDb } from '../helpers/db'

/**
 * `POST /api/plans/[planId]/ratings`: calificar la EXPERIENCIA del plan.
 *
 * Tres cosas que este archivo tiene que fijar, y cada una con su combinacion
 * prohibida:
 *
 *   1. **Solo `ATTENDED`.** No es el mismo gate que el del chat, que si abre a
 *      `NO_SHOW` y a `ACCEPTED`. Un `ACCEPTED` no tiene una experiencia terminada
 *      que juzgar y un `NO_SHOW` no puede calificar la de otros; probarlos los
 *      dos es lo que impide que alguien "unifique" los gates por comodidad.
 *
 *   2. **Solo despues de que el plan termino.** Un plan que empezo pero no
 *      termino, y un plan que no empezo, dan 403 los dos. La combinacion prohibida
 *      es la de un plan en curso.
 *
 *   3. **Editar es un upsert.** Un voto por persona y plan, para siempre, sin
 *      limite de correcciones. La fila se relee de la base en crudo: si el
 *      `upsert` hiciera `create` en vez de `update`, el `unique` lo delataria con
 *      un 500, y la segunda calificacion no se podria hacer.
 */

const PASSWORD = 'correcto-caballo-grapa-42'
const HACE_UN_RATO = () => new Date(Date.now() - 3_600_000)

let hilda: { id: string; email: string }
let ana: { id: string; email: string }
let beto: { id: string; email: string }
let place: { id: string }
/** Terminado, sin `endsAt`. Ana asiste, Beto no. */
let planTerminado: { id: string }
/** No empezo todavia. */
let planFuturo: { id: string }
/** Empezo pero no termino. */
let planEnCurso: { id: string }

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
  planEnCurso = await createPlan({
    placeId: place.id,
    creatorId: hilda.id,
    startsAt: HACE_UN_RATO(),
    endsAt: new Date(Date.now() + 3_600_000),
    capacity: 4,
  })

  for (const plan of [planTerminado, planFuturo, planEnCurso]) {
    await joinPlan({ planId: plan.id, userId: hilda.id, status: 'ATTENDED', role: 'ORGANIZER' })
    await joinPlan({ planId: plan.id, userId: ana.id, status: 'ATTENDED' })
    await joinPlan({ planId: plan.id, userId: beto.id, status: 'NO_SHOW' })
  }
})

afterAll(async () => {
  await closeDb()
})

async function loginAs(email: string): Promise<Client> {
  const c = new Client()
  expect((await c.login(email, PASSWORD)).status).toBe(200)
  return c
}

const calificar = (c: Client, planId: string, body: unknown) =>
  c.post(`/api/plans/${planId}/ratings`, body)

/** Los votos REALES de la base, con los campos que importan. */
async function votosEnBase(planId: string) {
  return rawQuery<{ authorId: string; rating: number; tags: string[] }>(
    `SELECT "authorId", rating, tags FROM "Rating" WHERE "planId" = $1`,
    [planId],
  )
}

describe('POST /api/plans/[planId]/ratings', () => {
  it('guarda el voto en la base', async () => {
    const anaC = await loginAs(ana.email)
    const res = await calificar(anaC, planTerminado.id, { rating: 4, tags: ['buena_comida'] })

    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ rating: 4, tags: ['buena_comida'], creado: true })
    expect(await votosEnBase(planTerminado.id)).toEqual([
      { authorId: ana.id, rating: 4, tags: ['buena_comida'] },
    ])
  })

  it('las etiquetas son opcionales, y no marcar ninguna es una decision', async () => {
    const anaC = await loginAs(ana.email)
    const res = await calificar(anaC, planTerminado.id, { rating: 5 })

    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ rating: 5, tags: [] })
    // Un array vacio de verdad, no `null`: "no marque ninguna" y "no tiene
    // etiquetas guardadas" son el mismo estado, y el `default([])` del schema lo
    // normaliza para que la columna nunca guarde null.
    expect(await votosEnBase(planTerminado.id)).toEqual([{ authorId: ana.id, rating: 5, tags: [] }])
  })

  it('corregir el voto actualiza la MISMA fila, y no crea una segunda', async () => {
    const anaC = await loginAs(ana.email)
    await calificar(anaC, planTerminado.id, { rating: 2, tags: ['faltaron_espacios'] })
    const res = await calificar(anaC, planTerminado.id, { rating: 5, tags: ['vale_la_pena'] })

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ rating: 5, tags: ['vale_la_pena'], creado: false })
    // Una fila. Si el endpoint hiciera `create`, esto seria 2 y el `unique`
    // habria tirado antes.
    expect(await votosEnBase(planTerminado.id)).toEqual([
      { authorId: ana.id, rating: 5, tags: ['vale_la_pena'] },
    ])
  })

  it('se puede corregir quantas veces se quiera, y el ultimo voto gana', async () => {
    const anaC = await loginAs(ana.email)
    // El primero crea (201) y el resto edita (200). El `unique` es lo que hace
    // que esto sea posible sin limite: sin el, la segunda tocada seria un 500.
    const vistas: number[] = []
    for (const rating of [1, 3, 2, 5, 4]) {
      const res = await calificar(anaC, planTerminado.id, { rating })
      vistas.push(res.status)
    }
    expect(vistas).toEqual([201, 200, 200, 200, 200])
    const votos = await votosEnBase(planTerminado.id)
    expect(votos).toHaveLength(1)
    expect(Number(votos[0].rating)).toBe(4)
  })

  it('desmarcar todas las etiquetas las deja vacias', async () => {
    // El equivalente del "lo borre": en vez de mandar un string vacio, se manda
    // el array vacio. No hay transform que hacer porque no hay texto.
    const anaC = await loginAs(ana.email)
    await calificar(anaC, planTerminado.id, { rating: 4, tags: ['vale_la_pena'] })
    const res = await calificar(anaC, planTerminado.id, { rating: 4, tags: [] })

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ tags: [] })
    expect(await votosEnBase(planTerminado.id)).toEqual([{ authorId: ana.id, rating: 4, tags: [] }])
  })

  it('el voto de cada quien es el suyo, y no se pisa con el de otro', async () => {
    // Dos votos, dos filas. El `unique` es por (plan, persona), no por plan.
    const anaC = await loginAs(ana.email)
    const hildaC = await loginAs(hilda.email)
    await calificar(anaC, planTerminado.id, { rating: 1 })
    await calificar(hildaC, planTerminado.id, { rating: 5 })

    const votos = await votosEnBase(planTerminado.id)
    expect(votos).toHaveLength(2)
    const porQuien = new Map(votos.map((v) => [v.authorId, Number(v.rating)]))
    expect(porQuien.get(ana.id)).toBe(1)
    expect(porQuien.get(hilda.id)).toBe(5)
  })

  it('el voto es del plan, no global: dos planes son dos filas', async () => {
    // El `unique` es (plan, persona). La misma persona puede calificar dos
    // planes distintos, y cada voto cuenta una vez en su propio promedio. Si el
    // indice fuera solo por `authorId`, aca seria un 500.
    const otro = await createPlan({
      placeId: place.id,
      creatorId: hilda.id,
      startsAt: HACE_UN_RATO(),
      capacity: 4,
    })
    await joinPlan({ planId: otro.id, userId: ana.id, status: 'ATTENDED' })

    const anaC = await loginAs(ana.email)
    await calificar(anaC, planTerminado.id, { rating: 5 })
    const res = await calificar(anaC, otro.id, { rating: 1 })

    expect(res.status).toBe(201)
    expect(await votosEnBase(planTerminado.id)).toEqual([{ authorId: ana.id, rating: 5, tags: [] }])
    expect(await votosEnBase(otro.id)).toEqual([{ authorId: ana.id, rating: 1, tags: [] }])
  })
})

describe('quien puede calificar', () => {
  it('un NO_SHOW no puede calificar, aunque el plan haya terminado', async () => {
    // Es la diferencia con el chat, y por eso esta fijada: `NO_SHOW` tiene chat
    // (§15.1) pero no califica. Un no-show no puede calificar la de otros, y
    // darle el mismo poder que a quien si estuvo es una decision de reputacion.
    const betoC = await loginAs(beto.email)
    const res = await calificar(betoC, planTerminado.id, { rating: 1 })

    expect(res.status).toBe(403)
    expect(await votosEnBase(planTerminado.id)).toEqual([])
  })

  it('un ACCEPTED no puede calificar: todavia no tiene una experiencia terminada', async () => {
    const nora = await createUser({ email: 'nora@example.com', passwordHash: await hashPassword(PASSWORD) })
    await joinPlan({ planId: planTerminado.id, userId: nora.id, status: 'ACCEPTED' })
    const noraC = await loginAs(nora.email)

    const res = await calificar(noraC, planTerminado.id, { rating: 5 })
    expect(res.status).toBe(403)
    expect(await votosEnBase(planTerminado.id)).toEqual([])
  })

  it('un REQUESTED no puede calificar', async () => {
    const nora = await createUser({ email: 'nora@example.com', passwordHash: await hashPassword(PASSWORD) })
    await joinPlan({ planId: planTerminado.id, userId: nora.id, status: 'REQUESTED' })
    const noraC = await loginAs(nora.email)

    expect((await calificar(noraC, planTerminado.id, { rating: 5 })).status).toBe(403)
  })

  it('alguien de afuera no puede calificar, y no crea fila', async () => {
    const carla = await createUser({ email: 'carla@example.com', passwordHash: await hashPassword(PASSWORD) })
    const carlaC = await loginAs(carla.email)

    expect((await calificar(carlaC, planTerminado.id, { rating: 1 })).status).toBe(404)
    expect(await votosEnBase(planTerminado.id)).toEqual([])
  })
})

describe('cuando se puede calificar', () => {
  it('un plan que no empezo no se puede calificar', async () => {
    const anaC = await loginAs(ana.email)
    const res = await calificar(anaC, planFuturo.id, { rating: 5 })

    expect(res.status).toBe(403)
    expect(await votosEnBase(planFuturo.id)).toEqual([])
  })

  it('un plan que empezo pero no termino no se puede calificar', async () => {
    const anaC = await loginAs(ana.email)
    const res = await calificar(anaC, planEnCurso.id, { rating: 5 })

    expect(res.status).toBe(403)
    expect(await votosEnBase(planEnCurso.id)).toEqual([])
  })

  it('un plan CANCELLED no se puede calificar', async () => {
    const cancelado = await createPlan({
      placeId: place.id,
      creatorId: hilda.id,
      startsAt: HACE_UN_RATO(),
      status: 'CANCELLED',
    })
    await joinPlan({ planId: cancelado.id, userId: ana.id, status: 'ATTENDED' })
    const anaC = await loginAs(ana.email)

    expect((await calificar(anaC, cancelado.id, { rating: 5 })).status).toBe(403)
    expect(await votosEnBase(cancelado.id)).toEqual([])
  })

  it('el mensaje de error no dice si el plan existe', async () => {
    // Primero, el caso de "no existe": el mensaje de plan inexistente y el de
    // "todavia no se puede" son distintos a proposito.
    const anaC = await loginAs(ana.email)
    const inexistente = await calificar(anaC, '11111111-1111-1111-1111-111111111111', { rating: 5 })
    const enCurso = await calificar(anaC, planEnCurso.id, { rating: 5 })

    expect(inexistente.status).toBe(404)
    expect(enCurso.status).toBe(403)
  })
})

describe('el payload', () => {
  it('rechaza lo que esta fuera de la escala y no guarda nada', async () => {
    const anaC = await loginAs(ana.email)
    // `true` y `[5]` estan en la lista a proposito: con `z.coerce.number()` los
    // dos se guardaban, porque `Number(true) === 1` y `Number([5]) === 5`. La
    // estrella de un clic llega como numero; si un endpoint acepta cualquier
    // cosa convertible, no esta validando, esta adivinando.
    for (const rating of [0, 6, -1, 3.5, '4', true, [5], null, undefined, 'mucho']) {
      const res = await calificar(anaC, planTerminado.id, { rating })
      expect(res.status, `rating ${JSON.stringify(rating) ?? 'undefined'}`).toBe(400)
    }
    expect(await votosEnBase(planTerminado.id)).toEqual([])
  })

  it('acepta los dos extremos de la escala', async () => {
    const anaC = await loginAs(ana.email)
    expect((await calificar(anaC, planTerminado.id, { rating: 1 })).status).toBe(201)
    expect((await calificar(anaC, planTerminado.id, { rating: 5 })).status).toBe(200)
    expect(Number((await votosEnBase(planTerminado.id))[0].rating)).toBe(5)
  })

  it('rechaza un texto libre en el campo `comment`, y no lo ignora', async () => {
    // El endpoint tiene `comment` desde hace semanas y alguien puede tener el
    // cliente viejo, o un curl. Si el `.strict()` no lo frenara, el 201 con
    // `creado: true` haria creer que el texto se guardo cuando se tiro. La
    // garantia de §5.9 se sostiene en que lo unico guardable este en el set
    // cerrado, y esto es lo que la sostiene en el borde.
    const anaC = await loginAs(ana.email)
    const res = await calificar(anaC, planTerminado.id, {
      rating: 4,
      comment: 'Ana es la unica que sabe lo que hace',
    })

    expect(res.status).toBe(400)
    expect(await votosEnBase(planTerminado.id)).toEqual([])
  })

  it('rechaza una etiqueta que no esta en el set, sin truncar ni guardar el resto', async () => {
    // Un id inventado con cara de etiqueta legitima. Con un campo de texto esto
    // seria el caso normal; con el enum es un 400.
    const anaC = await loginAs(ana.email)
    const res = await calificar(anaC, planTerminado.id, {
      rating: 4,
      tags: ['vale_la_pena', 'fulano_es_un_imbecil'],
    })

    expect(res.status).toBe(400)
    expect(await votosEnBase(planTerminado.id)).toEqual([])
  })

  it('acepta hasta el tope y rechaza la que sobra, y el rechazo no toca el voto', async () => {
    const anaC = await loginAs(ana.email)
    // Del set real y con el tope real: si alguien agrega una novena etiqueta o
    // sube el tope, este test se entera solo en vez de seguir probando un numero
    // que ya no existe.
    const hastaElTope = ETIQUETAS_EXPERIENCIA_IDS.slice(0, RATING_TAGS_MAX)
    const deMas = ETIQUETAS_EXPERIENCIA_IDS[RATING_TAGS_MAX]

    expect((await calificar(anaC, planTerminado.id, { rating: 4, tags: hastaElTope })).status).toBe(201)
    expect((await votosEnBase(planTerminado.id))[0].tags).toEqual(hastaElTope)

    const res = await calificar(anaC, planTerminado.id, {
      rating: 4,
      tags: [...hastaElTope, deMas],
    })
    expect(res.status).toBe(400)
    // Y lo importante: el rechazo no toco el voto de antes. Un 400 que borra lo
    // que ya estaba seria peor que el error.
    expect((await votosEnBase(planTerminado.id))[0].tags).toEqual(hastaElTope)
  })

  it('rechaza la misma etiqueta dos veces', async () => {
    // `['vale_la_pena', 'vale_la_pena']` contaria dos en el tally. La UI no lo
    // deja, pero el endpoint no puede confiar en la UI.
    const anaC = await loginAs(ana.email)
    const res = await calificar(anaC, planTerminado.id, {
      rating: 4,
      tags: ['vale_la_pena', 'vale_la_pena'],
    })

    expect(res.status).toBe(400)
    expect(await votosEnBase(planTerminado.id)).toEqual([])
  })

  it('rechaza `tags` que no es un array, porque un string seria un id partido', async () => {
    const anaC = await loginAs(ana.email)
    for (const tags of ['vale_la_pena', 5, { id: 'vale_la_pena' }]) {
      const res = await calificar(anaC, planTerminado.id, { rating: 4, tags })
      expect(res.status, JSON.stringify(tags)).toBe(400)
    }
    expect(await votosEnBase(planTerminado.id)).toEqual([])
  })

  it('rechaza campos que nadie deberia mandar', async () => {
    // Sobre todo `ratedUserId`: la calificacion es de la EXPERIENCIA del plan.
    // Aceptar el campo seria abrir, por la puerta de atras, calificar personas.
    const anaC = await loginAs(ana.email)
    for (const extra of [{ ratedUserId: beto.id }, { authorId: hilda.id }, { planId: planFuturo.id }]) {
      const res = await calificar(anaC, planTerminado.id, { rating: 4, ...extra })
      expect(res.status, JSON.stringify(extra)).toBe(400)
    }
    expect(await votosEnBase(planTerminado.id)).toEqual([])
  })

  it('sin sesion es 401, y un plan inexistente es 404', async () => {
    expect((await calificar(new Client(), planTerminado.id, { rating: 4 })).status).toBe(401)

    const anaC = await loginAs(ana.email)
    expect((await calificar(anaC, '11111111-1111-1111-1111-111111111111', { rating: 4 })).status).toBe(404)
  })
})

/**
 * El circuito completo de la calificacion, con el productor de asistencia
 * cualquiera: la fila existe porque alguien asistio, y calificar la escribe.
 */
describe('de la asistencia a la calificacion', () => {
  it('el voto no existe hasta que alguien estuvo, y lo destraba el organizador', async () => {
    // El fixture deja a Ana en `ATTENDED` porque casi todo este archivo la
    // necesita calificable. Este test la vuelve a `ACCEPTED` con Prisma para
    // partir del estado real de un plan recien terminado: nadie marco asistencia.
    await getPrisma().planParticipant.update({
      where: { planId_userId: { planId: planTerminado.id, userId: ana.id } },
      data: { status: 'ACCEPTED' },
    })
    const anaC = await loginAs(ana.email)

    // 1. Sin marcar: no puede calificar. Este es el bug que existia antes de
    //    este corte — no habia NINGUN camino que produjera `ATTENDED`, asi que
    //    este 403 no tenia salida.
    const antes = await calificar(anaC, planTerminado.id, { rating: 5 })
    expect(antes.status).toBe(403)
    expect(await votosEnBase(planTerminado.id)).toEqual([])

    // 2. El organizador marca. Este es el productor.
    const hildaC = await loginAs(hilda.email)
    const marcado = await hildaC.post(`/api/plans/${planTerminado.id}/attendance`, {
      userId: ana.id,
      attendance: 'ATTENDED',
    })
    expect(marcado.status).toBe(200)

    // 3. Ahora si, y el voto queda escrito.
    expect((await calificar(anaC, planTerminado.id, { rating: 5 })).status).toBe(201)
    expect((await calificar(hildaC, planTerminado.id, { rating: 3 })).status).toBe(201)

    const [{ promedio }] = await rawQuery<{ promedio: string }>(
      `SELECT round(avg(rating)::numeric, 1)::text AS promedio FROM "Rating" WHERE "planId" = $1`,
      [planTerminado.id],
    )
    expect(promedio).toBe('4.0')
  })
})
