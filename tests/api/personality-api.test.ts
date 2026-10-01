import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { hashPassword } from '../../lib/auth/password'
import { getPrisma } from '../../lib/db'
import { sembrarTestV1 } from '../../prisma/personality-v1.mjs'
import { Client } from '../helpers/http'
import { closeDb, createUser, resetDb } from '../helpers/db'

/**
 * El test de personalidad por HTTP: GET del test, POST del resultado.
 *
 * El contenido que se usa aqui es el de la v1 de verdad, el mismo que siembra
 * `npm run db:seed`. Un test con un cuestionario de juguete pasaria aunque el
 * seed este roto, que es el bug mas caro de todos: la pantalla muestra 404 en la
 * base de desarrollo y los tests estan en verde.
 */

const PASSWORD = 'test1234567'

let n = 0
async function userConSesion() {
  const email = `p${n++}@example.com`
  await createUser({ email, passwordHash: await hashPassword(PASSWORD), name: 'Persona' })
  const c = new Client()
  expect((await c.login(email, PASSWORD)).status).toBe(200)
  return { client: c, email }
}

/** El test activo, sembrado. */
async function conTestActivo() {
  await resetDb()
  const info = await sembrarTestV1(getPrisma())
  return getPrisma().personalityTest.findUniqueOrThrow({
    where: { id: info.testId },
    include: { questions: { include: { options: true }, orderBy: { order: 'asc' } } },
  })
}

/** Un set valido de respuestas: la primera opcion de cada pregunta. */
function respuestasDe(test: { questions: { id: string; options: { id: string }[] }[] }) {
  return test.questions.map((q) => ({ questionId: q.id, optionId: q.options[0].id }))
}

beforeEach(() => {
  n = 0
})

afterAll(async () => {
  await closeDb()
})

describe('GET /api/personality/test', () => {
  it('sin sesion responde 401', async () => {
    await conTestActivo()
    const res = await new Client().get('/api/personality/test')
    expect(res.status).toBe(401)
  })

  it('devuelve el test activo con sus preguntas y opciones ordenadas', async () => {
    await conTestActivo()
    const { client } = await userConSesion()

    const res = await client.get('/api/personality/test')
    expect(res.status).toBe(200)
    const body = res.body as {
      test: { version: number; questions: { order: number; options: { order: number }[] }[] }
      resultado: unknown
    }
    expect(body.test.version).toBe(1)
    expect(body.test.questions.length).toBeGreaterThan(0)
    expect(body.resultado).toBeNull()

    for (const q of body.test.questions) {
      const ordenes = q.options.map((o) => o.order)
      expect(ordenes).toEqual([...ordenes].sort((a, b) => a - b))
    }
  })

  it('NO expone scoreDelta: es el algoritmo del servidor, no un dato del cliente', async () => {
    // La razon de este test esta en el comment del handler, y es la que mas
    // caro sale perder: en cuanto el cliente puede calcular el score, el score
    // guardado puede dejar de ser el que calculo el servidor sin que nada falle.
    // Por eso la asercion mira el JSON entero y no un campo puntual: si mañana
    // alguien agrega el campo a otro nivel del objeto, esto tambien lo ve.
    await conTestActivo()
    const { client } = await userConSesion()

    const res = await client.get('/api/personality/test')
    expect(res.text).not.toContain('scoreDelta')
  })

  it('sin test activo responde 404', async () => {
    await resetDb()
    const { client } = await userConSesion()
    const res = await client.get('/api/personality/test')
    expect(res.status).toBe(404)
  })

  it('si ya hay resultado de este test, lo dice', async () => {
    const test = await conTestActivo()
    const { client } = await userConSesion()
    const post = await client.post('/api/personality/test', {
      testId: test.id,
      answers: respuestasDe(test),
    })
    expect(post.status).toBe(201)

    const res = await client.get('/api/personality/test')
    expect((res.body as { resultado: { id: string } | null }).resultado).not.toBeNull()
  })
})

describe('POST /api/personality/test', () => {
  it('sin sesion responde 401', async () => {
    const test = await conTestActivo()
    const res = await new Client().post('/api/personality/test', {
      testId: test.id,
      answers: respuestasDe(test),
    })
    expect(res.status).toBe(401)
  })

  it('un origen distinto responde 403', async () => {
    const test = await conTestActivo()
    const { client } = await userConSesion()
    const res = await client.req('/api/personality/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://otro-sitio.example' },
      body: JSON.stringify({ testId: test.id, answers: respuestasDe(test) }),
    })
    expect(res.status).toBe(403)
  })

  it('un body invalido responde 400', async () => {
    await conTestActivo()
    const { client } = await userConSesion()

    expect((await client.post('/api/personality/test', {})).status).toBe(400)
    expect((await client.post('/api/personality/test', { testId: 'x', answers: [] })).status).toBe(400)
    expect(
      (await client.post('/api/personality/test', { testId: 'x', answers: [{ questionId: 'a' }] }))
        .status,
    ).toBe(400)
  })

  it('guarda Result, Answer y Score en la misma pasada', async () => {
    const test = await conTestActivo()
    const { client } = await userConSesion()

    const res = await client.post('/api/personality/test', {
      testId: test.id,
      answers: respuestasDe(test),
    })
    expect(res.status).toBe(201)

    // Se afirma sobre la base, no sobre la respuesta: el 201 podria devolver un
    // body construido a mano y novenlo de lo que quedo guardado. Lo que importa
    // es lo que leyo el proximo lector.
    const prisma = getPrisma()
    const guardado = await prisma.personalityResult.findFirst({
      include: { answers: true, scores: true },
    })
    expect(guardado).not.toBeNull()
    expect(guardado?.testId).toBe(test.id)
    expect(guardado?.answers).toHaveLength(test.questions.length)
    expect(guardado?.scores.length).toBeGreaterThan(0)
  })

  it('el score guardado es la suma de los scoreDelta de las opciones elegidas', async () => {
    // El calculo se comprueba contra la fila, no contra lo que devuelve la
    // respuesta. Si el endpoint mintiera en el body, este test tiene que
    // seguir viendo el numero correcto en la base, que es lo que leen las
    // consultas de matching del futuro.
    const test = await conTestActivo()
    const { client } = await userConSesion()

    // Ultima opcion de cada pregunta: son los deltas mas extremos, y por lo tanto
    // los mas sensibles a que se tome el signo al reves.
    const answers = test.questions.map((q) => ({
      questionId: q.id,
      optionId: q.options[q.options.length - 1].id,
    }))
    const res = await client.post('/api/personality/test', { testId: test.id, answers })
    expect(res.status).toBe(201)

    const prisma = getPrisma()
    const guardado = await prisma.personalityResult.findFirstOrThrow({ include: { scores: true } })
    const esperado = new Map<string, number>()
    for (const q of test.questions) {
      const delta = q.options[q.options.length - 1].scoreDelta
      esperado.set(q.traitId, (esperado.get(q.traitId) ?? 0) + delta)
    }

    expect(guardado.scores).toHaveLength(esperado.size)
    for (const s of guardado.scores) {
      expect(s.value, s.traitId).toBeCloseTo(esperado.get(s.traitId) ?? 0, 6)
    }
  })

  it('una pregunta sin contestar responde 400', async () => {
    const test = await conTestActivo()
    const { client } = await userConSesion()
    const answers = respuestasDe(test).slice(0, -1)

    const res = await client.post('/api/personality/test', { testId: test.id, answers })
    expect(res.status).toBe(400)
    expect(JSON.stringify(res.body)).toContain('sin_contestar')
  })

  it('una pregunta contestada dos veces responde 400', async () => {
    // El caso que la base NO puede ver: `@@unique([resultId, optionId])` solo
    // impide repetir la misma opcion. Dos opciones distintas de la misma
    // pregunta pasan el unico de Postgres.
    const test = await conTestActivo()
    const { client } = await userConSesion()
    const answers = respuestasDe(test)
    const primera = test.questions[0]
    answers.push({ questionId: primera.id, optionId: primera.options[4].id })

    const res = await client.post('/api/personality/test', { testId: test.id, answers })
    expect(res.status).toBe(400)
    expect(JSON.stringify(res.body)).toContain('repetida')
  })

  it('una opcion de otro test responde 400', async () => {
    // Una v2 con sus propias opciones. Mandar un `optionId` de ahi es un POST
    // manipulado, y tiene que fallar: si pasara, se guardarian traits que la
    // persona nunca vio contestados.
    const test = await conTestActivo()
    const { client } = await userConSesion()

    const v2 = await getPrisma().personalityTest.create({
      data: {
        version: 99,
        name: 'v2 de prueba',
        isActive: true,
        publishedAt: new Date(),
        questions: {
          create: {
            prompt: 'Pregunta de otra version',
            order: 1,
            traitId: test.questions[0].traitId,
            options: { create: { label: 'Opcion ajena', scoreDelta: 9, order: 1 } },
          },
        },
      },
      include: { questions: { include: { options: true } } },
    })
    const ajena = v2.questions[0].options[0]

    const answers = respuestasDe(test)
    answers[0] = { questionId: test.questions[0].id, optionId: ajena.id }

    const res = await client.post('/api/personality/test', { testId: test.id, answers })
    expect(res.status).toBe(400)
    expect(JSON.stringify(res.body)).toContain('fuera_del_test')
  })

  it('un questionId que no corresponde a la opcion responde 400', async () => {
    // El body esta describiendo algo que no existe: dice "esta pregunta" y manda
    // una opcion de otra. Aceptarlo seria confiarle al cliente la estructura.
    const test = await conTestActivo()
    const { client } = await userConSesion()
    const answers = respuestasDe(test)
    answers[0] = { questionId: test.questions[1].id, optionId: test.questions[0].options[0].id }

    const res = await client.post('/api/personality/test', { testId: test.id, answers })
    expect(res.status).toBe(400)
  })

  it('responder dos veces el mismo test responde 409', async () => {
    const test = await conTestActivo()
    const { client } = await userConSesion()
    const body = { testId: test.id, answers: respuestasDe(test) }

    expect((await client.post('/api/personality/test', body)).status).toBe(201)
    const segundo = await client.post('/api/personality/test', body)
    expect(segundo.status).toBe(409)
    expect((segundo.body as { code: string }).code).toBe('ya_completado')
  })

  it('un test que ya no es la version activa responde 409', async () => {
    // El caso de carrera real: la persona abrio el test v1, tardo, se publico la
    // v2 y mando las respuestas de la v1. El 409 no es por purismo: el score se
    // calcula con el `scoreDelta` de la v1, y guardarlo dejaria un score con la
    // escala vieja, que es peor que pedir el test de nuevo.
    const test = await conTestActivo()
    const { client } = await userConSesion()

    await getPrisma().personalityTest.update({ where: { id: test.id }, data: { isActive: false } })
    await getPrisma().personalityTest.create({
      data: { version: 2, name: 'v2', isActive: true, publishedAt: new Date() },
    })

    const res = await client.post('/api/personality/test', {
      testId: test.id,
      answers: respuestasDe(test),
    })
    expect(res.status).toBe(409)
    expect((res.body as { code: string }).code).toBe('test_desactualizado')
  })

  it('un testId inexistente responde 404', async () => {
    await conTestActivo()
    const { client } = await userConSesion()
    const res = await client.post('/api/personality/test', {
      testId: 'no-existe',
      answers: [{ questionId: 'a', optionId: 'b' }],
    })
    expect(res.status).toBe(404)
  })

  it('el 409 por repetir NO deja un resultado a medias', async () => {
    // La transaccion es lo que garantiza esto: si el Result se creara y el
    // Score fallara, quedaria un resultado sin puntuar que un lector
    // interpretaria como "contesto pero dio cero".
    const test = await conTestActivo()
    const { client } = await userConSesion()
    const body = { testId: test.id, answers: respuestasDe(test) }
    await client.post('/api/personality/test', body)
    await client.post('/api/personality/test', body)

    const prisma = getPrisma()
    const todos = await prisma.personalityResult.findMany({ include: { scores: true } })
    expect(todos).toHaveLength(1)
    expect(todos[0].scores.length).toBeGreaterThan(0)
  })
})

describe('GET /api/personality: el chequeo barato del recordatorio', () => {
  it('sin sesion responde 401', async () => {
    await conTestActivo()
    expect((await new Client().get('/api/personality')).status).toBe(401)
  })

  it('sin test activo dice que no hay test', async () => {
    // El recordatorio se apaga solo. Insistir en hacer un test que no existe es
    // peor que no recordar.
    await resetDb()
    const { client } = await userConSesion()
    const res = await client.get('/api/personality')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ hayTest: false, hayResultado: false, version: null })
  })

  it('antes de responder dice que no hay resultado', async () => {
    await conTestActivo()
    const { client } = await userConSesion()
    const res = await client.get('/api/personality')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ hayTest: true, hayResultado: false, version: 1 })
  })

  it('despues de responder dice que hay resultado, y de que version', async () => {
    const test = await conTestActivo()
    const { client } = await userConSesion()
    await client.post('/api/personality/test', { testId: test.id, answers: respuestasDe(test) })

    const res = await client.get('/api/personality')
    expect(res.body).toMatchObject({ hayTest: true, hayResultado: true, resultadoVersion: 1 })
  })

  it('el resultado de una version vieja no apaga el recordatorio de la nueva', async () => {
    // "Tengo resultado" y "tengo resultado de la version que te estoy
    // mostrando" no son lo mismo. Si se trataran igual, publicar una v2
    // desapareceria el boton de rehacer el test para todos los que hicieron la
    // v1, sin que nadie lo haya pedido.
    const test = await conTestActivo()
    const { client } = await userConSesion()
    await client.post('/api/personality/test', { testId: test.id, answers: respuestasDe(test) })

    await getPrisma().personalityTest.update({ where: { id: test.id }, data: { isActive: false } })
    await getPrisma().personalityTest.create({
      data: { version: 2, name: 'v2', isActive: true, publishedAt: new Date() },
    })

    const res = await client.get('/api/personality')
    expect(res.body).toMatchObject({
      hayResultado: true,
      resultadoVersion: 1,
      version: 2,
    })
  })
})
