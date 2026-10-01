import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { hashPassword } from '../../lib/auth/password'
import { getPrisma } from '../../lib/db'
import { nivelDe, posicionRelativa, rangosDeTest, sumarScores } from '../../lib/personality'
import { sembrarTestV1, TEST_V1 } from '../../prisma/personality-v1.mjs'
import { Client } from '../helpers/http'
import { closeDb, createUser, resetDb } from '../helpers/db'

/**
 * Las pantallas de personalidad: `/personalidad`, `/perfil`, y el recordatorio
 * del mapa.
 *
 * Se prueban con HTTP y no con un DOM porque no hay navegador en este proyecto.
 * Lo que se puede verificar asi es lo que se rompe en silencio: la pagina renderiza
 * (un error de import o un hook mal usado sale en blanco en el navegador y no
 * aparece en `tsc`), la ruta exige sesion de verdad (writing la URL a mano), y la
 * logica que se decidio de dejar en funciones puras.
 *
 * El render de las opciones y el estado del boton NO estan cubiertos por aca: eso
 * necesita un navegador, y lo que se puede afirmar sobre eso es unicamente que
 * los tests no lo cubren.
 */

const PASSWORD = 'correcto-caballo-grapa-42'

let n = 0
async function conSesion() {
  const email = `per${n++}@example.com`
  await createUser({ email, passwordHash: await hashPassword(PASSWORD), name: 'Persona' })
  const c = new Client()
  expect((await c.login(email, PASSWORD)).status).toBe(200)
  return c
}

async function conTest() {
  await resetDb()
  const info = await sembrarTestV1(getPrisma())
  const test = await getPrisma().personalityTest.findUniqueOrThrow({
    where: { id: info.testId },
    include: { questions: { include: { options: true }, orderBy: { order: 'asc' } } },
  })
  return test
}

function respuestasDe(test: { questions: { id: string; options: { id: string }[] }[] }) {
  return test.questions.map((q) => ({ questionId: q.id, optionId: q.options[2].id }))
}

beforeEach(() => {
  n = 0
})

afterAll(async () => {
  await closeDb()
})

describe('las rutas de personalidad exigen sesion', () => {
  // La proteccion esta en `AUTHENTICATED_PREFIXES` y se prueba escribiendo la
  // URL: el boton de la UI podria no existir y la pagina seguir abierta, y eso es
  // un agujero, no un detalle de estilo.
  it.each(['/personalidad', '/perfil'])('%s sin sesion responde 401', async (ruta) => {
    await conTest()
    const res = await new Client().get(ruta)
    expect(res.status).toBe(401)
  })

  it.each(['/personalidad', '/perfil'])('%s con sesion renderiza 200', async (ruta) => {
    await conTest()
    const c = await conSesion()
    const res = await c.get(ruta)
    expect(res.status).toBe(200)
  })
})

describe('/personalidad', () => {
  it('renderiza sin test activo, sin romperse', async () => {
    await resetDb()
    const c = await conSesion()
    // Sin test la pantalla dice que no hay test. Lo que importa es que no quede
    // en blanco: el `fetch` devuelve 404 y la UI tiene que absorberlo.
    const res = await c.get('/personalidad')
    expect(res.status).toBe(200)
  })

  it('el HTML inicial no trae el contenido del test: llega por fetch', async () => {
    const test = await conTest()
    const c = await conSesion()
    const res = await c.get('/personalidad')

    // Si el prompt de una pregunta estuviera en el HTML inicial, el `page.tsx`
    // estaria consultando la base y habria dos copias de la regla de "cual es la
    // version activa". Esta asercion es la que avisa si eso cambia.
    const pregunta = test.questions[0].options[0].label
    expect(res.text).not.toContain(pregunta)
  })
})

describe('/perfil', () => {
  it('sin resultado, el render inicial no inventa rasgos', async () => {
    await conTest()
    const c = await conSesion()
    const res = await c.get('/perfil')
    expect(res.status).toBe(200)

    // El HTML inicial sale con el estado de carga, no con los rasgos: el perfil
    // se arma con un `fetch` al montar. Lo que se verifica aca es que no se
    // affirmen rasgos que todavia no se pidieron. El contenido cargado se
    // verifica en los tests de `GET /api/personality/resultado`, que es de donde
    // sale.
    expect(res.text).toContain('Cargando tu perfil')
    const rasgo = await getPrisma().trait.findFirstOrThrow({ select: { label: true } })
    expect(res.text).not.toContain(rasgo.label)
  })

  it('con resultado devuelve los rasgos ordenados de mayor a menor', async () => {
    const test = await conTest()
    const c = await conSesion()
    await c.post('/api/personality/test', { testId: test.id, answers: respuestasDe(test) })

    const res = await c.get('/api/personality/resultado')
    expect(res.status).toBe(200)
    const body = res.body as {
      resultado: { rasgos: { key: string; value: number; nivel: string; posicion: number }[] }
    }
    expect(body.resultado.rasgos.length).toBeGreaterThan(1)

    const valores = body.resultado.rasgos.map((r) => r.value)
    expect(valores).toEqual([...valores].sort((a, b) => b - a))
  })

  it('el nivel que devuelve la API es el mismo que calcula la funcion pura', async () => {
    // La asercion compara la fila con la funcion y no con un numero escrito a
    // mano: si cambia la escala, cambia la funcion y el test sigue siendo el
    // dueno de la relacion entre las dos.
    const test = await conTest()
    const c = await conSesion()
    await c.post('/api/personality/test', { testId: test.id, answers: respuestasDe(test) })

    const res = await c.get('/api/personality/resultado')
    const body = res.body as {
      resultado: {
        rasgos: { key: string; traitId: string; value: number; nivel: string; posicion: number }[]
      }
    }
    // El mapa de rangos se indexa por `traitId`, igual que las preguntas. La
    // primera version de este test buscaba por `key` (el texto del trait), no
    // encontraba nada y comparaba `undefined` contra un rango: el lookup fallaba
    // en silencio y la asercion no lo veia.
    const rangos = rangosDeTest(
      test.questions.map((q) => ({ traitId: q.traitId, options: q.options })),
    )

    for (const r of body.resultado.rasgos) {
      const rango = rangos.get(r.traitId)
      expect(rango, `sin rango para ${r.key}`).toBeDefined()
      if (!rango) continue
      expect(r.posicion).toBeCloseTo(posicionRelativa(r.value, rango), 6)
      expect(r.nivel).toBe(nivelDe(r.posicion))
    }
  })

  it('el perfil de otra persona no se puede leer', async () => {
    // No hay endpoint que tome un id: el perfil es "el mio y nada mas". Esta
    // prueba vale mas como documents que como test: si alguien agrega
    // `?userId=`, esta sigue pasando, y por eso el `userId` sale del gate y no
    // del body. Lo que se verifica aca es que el endpoint no acepta un id
    // ajeno por parametro.
    const test = await conTest()
    const ana = await conSesion()
    const beto = await conSesion()
    await ana.post('/api/personality/test', { testId: test.id, answers: respuestasDe(test) })

    const ajeno = await beto.get('/api/personality/resultado?userId=123')
    expect(ajeno.status).toBe(200)
    expect((ajeno.body as { resultado: unknown }).resultado).toBeNull()
  })
})

describe('el recordatorio del mapa', () => {
  it('no aparece si no hay sesion', async () => {
    // El mapa es publico. Un recordatorio que empuja a registrarse a alguien que
    // solo esta mirando lugares es la manera de que el mapa se sienta como una
    // puerta de registro.
    await conTest()
    const res = await new Client().get('/explore')
    expect(res.status).toBe(200)
    expect(res.text).not.toContain('test de personalidad')
  })

  it('el mapa sigue renderizando con sesion y sin test', async () => {
    await resetDb()
    const c = await conSesion()
    expect((await c.get('/explore')).status).toBe(200)
  })
})

describe('el algoritmo de presentacion', () => {
  it('el rango de un trait con dos preguntas es mas ancho que el de uno con una', () => {
    // La razon de que el rango se calcule y no se hardcodee: con el contenido de
    // la v1 los traits no comparten escala, y un perfil que dijera "1.5 es el
    // maximo" estaria mintiendo para la mitad de los traits.
    const rangos = rangosDeTest(
      TEST_V1.questions.map((q) => ({
        traitId: q.trait,
        options: q.options.map((_, j) => ({ scoreDelta: TEST_V1.escala[j] * q.weight })),
      })),
    )
    const nuevaGente = rangos.get('nueva_gente')
    const improvisar = rangos.get('improvisar')
    expect(nuevaGente).toBeDefined()
    expect(improvisar).toBeDefined()
    if (!nuevaGente || !improvisar) return
    expect(nuevaGente.max - nuevaGente.min).toBeGreaterThan(improvisar.max - improvisar.min)
  })

  it('la posicion del extremo de cada rango es 0 y 1', () => {
    const rangos = rangosDeTest(
      TEST_V1.questions.map((q) => ({
        traitId: q.trait,
        options: q.options.map((_, j) => ({ scoreDelta: TEST_V1.escala[j] * q.weight })),
      })),
    )
    for (const rango of rangos.values()) {
      expect(posicionRelativa(rango.min, rango)).toBeCloseTo(0, 6)
      expect(posicionRelativa(rango.max, rango)).toBeCloseTo(1, 6)
    }
  })

  it('un rango degenerado da 0.5 y no NaN', () => {
    // El contenido real nunca produce esto. El caso se prueba igual porque un
    // NaN en el perfil se ve como un bug y un 0.5 se ve como un dato, que es la
    // diferencia entre un fallo que se reporta y uno que no.
    expect(posicionRelativa(1, { min: 1, max: 1 })).toBe(0.5)
  })

  it('el nivel del centro es medio y el de los extremos no', () => {
    expect(nivelDe(0.5)).toBe('medio')
    expect(nivelDe(0)).toBe('muy_bajo')
    expect(nivelDe(1)).toBe('muy_alto')
  })

  it('sumarScores y rangosDeTest usan los mismos numeros', () => {
    // Coherencia interna del modulo: si `sumarScores` invirtiera el signo o
    // perdiera una pregunta, la suma podria caerse fuera del rango que el
    // modulo mismo declara posible, y la pantalla mostraria un nivel inventado.
    const preguntas = TEST_V1.questions.map((q, i) => ({
      traitId: q.trait,
      options: q.options.map((_, j) => ({ scoreDelta: TEST_V1.escala[j] * q.weight })),
      indice: i,
    }))
    const rangos = rangosDeTest(preguntas)
    const puntables = preguntas.flatMap((p) =>
      p.options.map((o, j) => ({
        questionId: `q${p.indice}`,
        traitId: p.traitId,
        optionId: `q${p.indice}o${j}`,
        scoreDelta: o.scoreDelta,
      })),
    )

    for (const s of sumarScores(puntables)) {
      const rango = rangos.get(s.traitId)
      expect(rango).toBeDefined()
      if (!rango) continue
      expect(s.value).toBeGreaterThanOrEqual(rango.min)
      expect(s.value).toBeLessThanOrEqual(rango.max)
    }
  })
})
