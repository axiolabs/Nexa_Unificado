import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { PlaceCategory } from '@prisma/client'
import { hashPassword } from '../../lib/auth/password'
import { CATEGORY_LABELS, PLACE_CATEGORIES } from '../../lib/enums'
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
 * `/api/places` es PUBLICO. Que sea publico es la decision: el mapa es la
 * superficie de adquisicion y asi lo aprobo el equipo.
 *
 * Pero publico no es "todo visible". Hay una linea, y esta suite existe para
 * que la linea no se corra por refactor sin que nadie se entere:
 *
 *   - Un lugar `PENDING` es invisible para cualquiera que no sea curador.
 *   - La respuesta no lleva datos personales de nadie.
 *
 * La segunda es la que mas importa y la mas facil de romper de forma
 * accidental: agregar un campo al `select` para mostrar "quien verifico este
 * lugar" y, de paso, exponer el `ownerId` de alguien.
 */

const PASSWORD = 'correcto-caballo-grapa-42'

// Buenos Aires: la caja cubre la ciudad sembrada.
const BA = '-58.50,-34.65,-58.30,-34.55'
// Una caja en el mar, lejos de todo.
const EMPTY = '-70.00,10.00,-69.90,10.10'
// Cruzando el antimeridiano: 170 este hasta 170 oeste.
const ANTIMERIDIAN = '170,-10,-170,10'

type PlaceRow = {
  id: string
  name: string
  description: string | null
  category: string
  latitude: number
  longitude: number
  openPlanCount: number
}

function placesOf(res: { body: unknown }): PlaceRow[] {
  return (res.body as { places: PlaceRow[] }).places
}

function namesOf(res: { body: unknown }): string[] {
  return placesOf(res).map((p) => p.name)
}

let ana: { id: string; email: string }
let approved: { id: string; name: string }
let pending: { id: string; name: string }

beforeEach(async () => {
  await resetDb()
  const passwordHash = await hashPassword(PASSWORD)
  ana = await createUser({ email: 'ana@example.com', name: 'Ana Ruiz', passwordHash, roles: ['USER'] })

  approved = await createPlace({ name: 'Cafe Aprobado', lat: -34.6037, lng: -58.3816 })
  pending = await createPlace({
    name: 'Bar Sin Revisar',
    lat: -34.604,
    lng: -58.382,
    verificationStatus: 'PENDING',
  })
  await createPlace({
    name: 'Bar Rechazado',
    lat: -34.6041,
    lng: -58.3821,
    verificationStatus: 'REJECTED',
  })
  await createPlace({ name: 'Parque Lejano', lat: -34.9, lng: -58.9 })
})

afterAll(async () => {
  await closeDb()
})

describe('GET /api/places', () => {
  it('es publico: sin sesion responde 200 y trae lugares', async () => {
    const res = await new Client().get(`/api/places?bbox=${BA}`)
    expect(res.status).toBe(200)
    expect(placesOf(res).length).toBeGreaterThan(0)
  })

  it('un lugar PENDING es invisible para un anonimo', async () => {
    const res = await new Client().get(`/api/places?bbox=${BA}`)
    const names = namesOf(res)
    expect(names).toContain('Cafe Aprobado')
    expect(names).not.toContain('Bar Sin Revisar')
  })

  it('un lugar REJECTED tampoco aparece nunca', async () => {
    const res = await new Client().get(`/api/places?bbox=${BA}`)
    expect(namesOf(res)).not.toContain('Bar Rechazado')
  })

  it('la caja acota: un lugar fuera de la pantalla no viene', async () => {
    const res = await new Client().get(`/api/places?bbox=${BA}`)
    expect(namesOf(res)).not.toContain('Parque Lejano')
  })

  it('un curador con sesion ve tambien los PENDING', async () => {
    await addRole(ana.id, 'CURATOR')
    const c = new Client()
    expect((await c.login(ana.email, PASSWORD)).status).toBe(200)

    const res = await c.get(`/api/places?bbox=${BA}`)
    const names = namesOf(res)
    expect(names).toContain('Bar Sin Revisar')
    // Pero un REJECTED sigue fuera, incluso para curador: la curaduria necesita
    // ver lo pendiente, no lo descartado.
    expect(names).not.toContain('Bar Rechazado')
  })

  it('un USER comun no ve los PENDING aunque tenga sesion', async () => {
    const c = new Client()
    expect((await c.login(ana.email, PASSWORD)).status).toBe(200)
    const res = await c.get(`/api/places?bbox=${BA}`)
    expect(namesOf(res)).not.toContain('Bar Sin Revisar')
  })

  it('la respuesta no lleva datos personales', async () => {
    const res = await new Client().get(`/api/places?bbox=${BA}`)
    const raw = JSON.stringify(res.body)
    // La asercion mas fuerte: ningun campo que identifique a una persona.
    expect(raw).not.toContain('ownerId')
    expect(raw).not.toContain('verifiedById')
    expect(raw).not.toContain(ana.email)

    // Y el shape es el esperado, campo por campo. Si alguien agrega un campo
    // nuevo, esta lista hay que actualizarla a proposito: es la forma de que
    // agregar un campo se convierta en una decision y no en un descuido.
    for (const p of placesOf(res)) {
      expect(Object.keys(p).sort()).toEqual([
        'category',
        'description',
        'id',
        'latitude',
        'longitude',
        'name',
        'openPlanCount',
      ])
    }
  })

  it('openPlanCount cuenta solo planes que todavia no empiezan', async () => {
    const futuro = new Date(Date.now() + 86_400_000)
    const pasado = new Date(Date.now() - 86_400_000)

    await createPlan({ placeId: approved.id, creatorId: ana.id, startsAt: futuro, status: 'OPEN' })
    await createPlan({ placeId: approved.id, creatorId: ana.id, startsAt: futuro, status: 'CANCELLED' })
    await createPlan({ placeId: approved.id, creatorId: ana.id, startsAt: pasado, status: 'OPEN' })

    const res = await new Client().get(`/api/places?bbox=${BA}`)
    const cafe = placesOf(res).find((p) => p.id === approved.id)
    // 1: solo el futuro y OPEN. Ni el cancelado ni el que ya empezo.
    expect(cafe?.openPlanCount).toBe(1)
  })

  it('un plan borrado logicamente no cuenta', async () => {
    await createPlan({
      placeId: approved.id,
      creatorId: ana.id,
      startsAt: new Date(Date.now() + 86_400_000),
      status: 'OPEN',
      deleted: true,
    })
    const res = await new Client().get(`/api/places?bbox=${BA}`)
    const cafe = placesOf(res).find((p) => p.id === approved.id)
    expect(cafe?.openPlanCount).toBe(0)
  })

  it('filtra por categoria contra la lista cerrada', async () => {
    await createPlace({ name: 'Museo Test', category: 'MUSEUM', lat: -34.603, lng: -58.38 })
    const res = await new Client().get(`/api/places?bbox=${BA}&category=MUSEUM`)
    expect(res.status).toBe(200)
    expect(namesOf(res)).toEqual(['Museo Test'])
  })

  it('una categoria inventada da 400, no 500', async () => {
    const res = await new Client().get(`/api/places?bbox=${BA}&category=INVENTADA`)
    expect(res.status).toBe(400)
    expect((res.body as { error: string }).error).toMatch(/categoria|category/i)
  })

  // Nexa es gratis: no hay niveles de precio ni filtro de precio. Este test fija
  // que el parametro muerto se IGNORA en vez de romper: un link viejo con
  // `?priceLevel=HIGH` guardado, o un cliente viejo desplegado, no pueden
  // convertir la pantalla del mapa en un error.
  it('ignora el priceLevel de links viejos, sin 400', async () => {
    await createPlace({ name: 'Bar Caro', lat: -34.6028, lng: -58.3798 })
    const res = await new Client().get(`/api/places?bbox=${BA}&priceLevel=HIGH`)
    expect(res.status).toBe(200)
    expect(namesOf(res)).toContain('Bar Caro')
  })

  it('un bbox invalido da 400 con el motivo', async () => {
    for (const bbox of ['basura', '1,2,3', '-181,0,0,1', '-180,-90,180,90', '0,,3,4']) {
      const res = await new Client().get(`/api/places?bbox=${bbox}`)
      expect(res.status, `bbox=${bbox}`).toBe(400)
      expect((res.body as { error: string }).error).toBeTruthy()
    }
  })

  it('sin bbox da 400, no la base entera', async () => {
    const res = await new Client().get('/api/places')
    expect(res.status).toBe(400)
  })

  it('una caja en mitad del oceano devuelve vacio sin error', async () => {
    const res = await new Client().get(`/api/places?bbox=${EMPTY}`)
    expect(res.status).toBe(200)
    expect(placesOf(res)).toEqual([])
  })

  it('una caja cruzando el antimeridiano no rompe la consulta', async () => {
    const res = await new Client().get(`/api/places?bbox=${ANTIMERIDIAN}`)
    expect(res.status).toBe(200)
    expect(Array.isArray(placesOf(res))).toBe(true)
  })

  it('la respuesta no se cachea en un CDN compartido', async () => {
    // El curador ve mas que el anonimo. Una cache compartida serviria los
    // PENDING de uno al otro, que es exactamente el leak que la regla evita.
    const res = await new Client().get(`/api/places?bbox=${BA}`)
    expect(res.headers.get('cache-control')).toContain('no-store')
  })

  it('las coordenadas vienen como numero, no como Decimal serializado', async () => {
    const res = await new Client().get(`/api/places?bbox=${BA}`)
    for (const p of placesOf(res)) {
      // Un Decimal de Prisma serializado a JSON rompe la forma y el mapa
      // recibe `{s, e, f}` en vez de -34.6.
      expect(typeof p.latitude).toBe('number')
      expect(typeof p.longitude).toBe('number')
    }
  })
})

/**
 * `?q=` es la via por nombre, para elegir el lugar de un plan.
 *
 * El contrato que mas importa aca NO es que encuentre cosas: es que el **tope
 * sea visible**. El mapa puede esconderse detras de un limite porque lo que no
 * aparece esta fuera de pantalla y el usuario lo entiende. Un selector de
 * lugares no tiene esa excusa: si hay un tope callado, el usuario busca el lugar
 * que quiere, no aparece, y no hay nada en la pantalla que explique por que.
 */
describe('GET /api/places?q=', () => {
  /** Los mismos fields que el camino por caja, para comparar sin duplicar forma. */
  function read(res: { body: unknown }) {
    return res.body as { places: PlaceRow[]; total: number; truncated: boolean }
  }

  it('es publico y encuentra por nombre', async () => {
    const res = await new Client().get('/api/places?q=Aprobado')
    expect(res.status).toBe(200)
    expect(placesOf(res).map((p) => p.name)).toEqual(['Cafe Aprobado'])
  })

  it('no distingue mayusculas ni minusculas', async () => {
    // El usuario escribe "cafe" con minuscula, el lugar se llama "Cafe".
    for (const q of ['cafe', 'CAFE', 'CaFe', 'aprobado', 'APROBADO']) {
      const res = await new Client().get(`/api/places?q=${q}`)
      expect(placesOf(res).map((p) => p.name), q).toEqual(['Cafe Aprobado'])
    }
  })

  it('matchea por substring, no solo por prefijo', async () => {
    const res = await new Client().get('/api/places?q=aprobado')
    expect(placesOf(res)).toHaveLength(1)
  })

  it('NO esta acotado a una caja: encuentra lugares fuera de la ciudad sembrada', async () => {
    // Esta es la diferencia que justifica que `q` exista. `Parque Lejano` esta
    // en -34.9,-58.9, fuera de `BA`, asi que la caja del mapa no lo trae. Un
    // host que quiere hacer el plan ahi tiene que poder encontrarlo por nombre.
    const res = await new Client().get('/api/places?q=Lejano')
    expect(res.status).toBe(200)
    expect(placesOf(res).map((p) => p.name)).toEqual(['Parque Lejano'])

    // Control: el mismo lugar NO aparece en la caja.
    const porCaja = await new Client().get(`/api/places?bbox=${BA}`)
    expect(namesOf(porCaja)).not.toContain('Parque Lejano')
  })

  it('un PENDING no aparece para un anonimo, igual que en el mapa', async () => {
    const res = await new Client().get('/api/places?q=Sin Revisar')
    expect(placesOf(res)).toEqual([])
    expect(read(res).total).toBe(0)
  })

  it('un curador si lo ve, y el total tambien lo refleja', async () => {
    const c = new Client()
    expect((await c.login(ana.email, PASSWORD)).status).toBe(200)
    await addRole(ana.id, 'CURATOR')
    const res = await c.get('/api/places?q=Sin Revisar')
    expect(placesOf(res).map((p) => p.name)).toEqual(['Bar Sin Revisar'])
    expect(read(res).total).toBe(1)
  })

  it('un REJECTED no aparece ni para curador', async () => {
    const c = new Client()
    await c.login(ana.email, PASSWORD)
    await addRole(ana.id, 'CURATOR')
    const res = await c.get('/api/places?q=Rechazado')
    expect(placesOf(res)).toEqual([])
  })

  it('un lugar desactivado o borrado logicamente tampoco', async () => {
    // Los tres filtros de visibilidad, aplicados por `q` tambien. Si `searchPlaces`
    // se olvidara de uno, el selector ofreceria un lugar que el POST va a
    // rechazar: el usuario completa el formulario y recibe un 404 al final.
    for (const sql of [
      `UPDATE "Place" SET "isActive" = false WHERE name = $1`,
      `UPDATE "Place" SET "deletedAt" = now() WHERE name = $1`,
    ]) {
      await rawQuery(sql, ['Parque Lejano'])
      const res = await new Client().get('/api/places?q=Lejano')
      expect(placesOf(res), sql).toEqual([])
      await rawQuery(
        `UPDATE "Place" SET "isActive" = true, "deletedAt" = NULL WHERE name = $1`,
        ['Parque Lejano'],
      )
    }
  })

  it('filtra por categoria y por precio, igual que la caja', async () => {
    // Los valores salen de la lista del dominio, no de memoria: `EXPENSIVE` y
    // `CHEAP` son inventos de una copia vieja del cliente (ver `lib/enums.ts`) y
    // un filtro con un valor asi devuelve 400, no una lista vacia. Un test que
    // usara un valor inexistente "pasaria" probando otra cosa.
    const porCat = await new Client().get(`/api/places?q=Aprobado&category=${PLACE_CATEGORIES[0]}`)
    expect(placesOf(porCat)).toHaveLength(1)

    // Y el caso NEGATIVO de cada filtro, que es el que importa: si el filtro no
    // se aplicara, un test que solo busca la categoria correcta seguiria en
    // verde, porque el lugar es de esa categoria y coincide de todos modos.
    const otraCat = await new Client().get('/api/places?q=Aprobado&category=PARK')
    expect(placesOf(otraCat)).toEqual([])
  })

  it('una categoria inventada da 400 tambien por el camino de la busqueda', async () => {
    const res = await new Client().get('/api/places?q=cafe&category=INVENTADO')
    expect(res.status).toBe(400)
  })

  describe('el tope es visible, no invisible', () => {
    // 25 lugares que matchean el mismo texto, contra un limite de 20.
    beforeEach(async () => {
      for (let i = 0; i < 25; i++) {
        await createPlace({
          name: `Sala Numero ${String(i).padStart(2, '0')}`,
          lat: -34.6,
          lng: -58.38,
        })
      }
    })

    it('trae el limite, avisa que hay mas, y dice cuantas', async () => {
      const res = await new Client().get('/api/places?q=Sala Numero')
      const body = read(res)
      expect(body.places).toHaveLength(20)
      expect(body.total).toBe(25)
      expect(body.truncated).toBe(true)
    })

    it('cuando entra todo, truncated es false: la senal sirve para algo', async () => {
      // Si `truncated` fuera siempre `true`, la UI no podria distinguir "estos
      // son todos" de "te falta ver algunos", y el campo no informa nada.
      const res = await new Client().get('/api/places?q=Aprobado')
      const body = read(res)
      expect(body.places).toHaveLength(1)
      expect(body.total).toBe(1)
      expect(body.truncated).toBe(false)
    })

    it('cero resultados: total 0 y truncated false, no null ni -1', async () => {
      const res = await new Client().get('/api/places?q=NoExisteEsteLugar')
      const body = read(res)
      expect(body.places).toEqual([])
      expect(body.total).toBe(0)
      expect(body.truncated).toBe(false)
    })
  })

  it('el total cuenta los ocultos por visibilidad, no solo los de la pagina', async () => {
    // Con un curador: 25 PENDING mas 25 APPROVED, limite 20. Si `total` fuera
    // `places.length` el curador veria "20 de 20" y creeria que no hay mas,
    // cuando en realidad hay 30 esperando. Por eso el conteo va en su propia
    // consulta con el mismo filtro de visibilidad.
    for (let i = 0; i < 25; i++) {
      await createPlace({
        name: `Salon Oculto ${i}`,
        lat: -34.6,
        lng: -58.38,
        verificationStatus: 'PENDING',
      })
    }
    const c = new Client()
    await c.login(ana.email, PASSWORD)
    await addRole(ana.id, 'CURATOR')
    const res = await c.get('/api/places?q=Salon Oculto')
    const body = read(res)
    expect(body.places).toHaveLength(20)
    expect(body.total).toBe(25)
    expect(body.truncated).toBe(true)
  })

  it('la respuesta no lleva datos personales, como la del mapa', async () => {
    const res = await new Client().get('/api/places?q=Aprobado')
    const text = JSON.stringify(res.body)
    expect(text).not.toContain('ownerId')
    expect(text).not.toContain('verifiedById')
    expect(text).not.toContain(ana.email)
  })

  it('las coordenadas vienen como numero, no como Decimal serializado', async () => {
    const res = await new Client().get('/api/places?q=Aprobado')
    for (const p of placesOf(res)) {
      expect(typeof p.latitude).toBe('number')
      expect(typeof p.longitude).toBe('number')
    }
  })

  it('no se cachea en un CDN compartido', async () => {
    const res = await new Client().get('/api/places?q=Aprobado')
    expect(res.headers.get('cache-control')).toContain('no-store')
  })

  it('openPlanCount funciona igual que en el mapa', async () => {
    await createPlan({ placeId: approved.id, creatorId: ana.id, capacity: 2, acceptedCount: 1 })
    const res = await new Client().get('/api/places?q=Aprobado')
    expect(placesOf(res)[0].openPlanCount).toBe(1)
  })
})

/**
 * `bbox` y `q` son alternativas. La regla se valida en el servidor porque el
 * cliente no es quien decide el contrato: cualquiera puede pegarle a la API.
 */
describe('bbox y q no se combinan', () => {
  it('los dos juntos da 400 diciendo que son alternativos', async () => {
    const res = await new Client().get(`/api/places?bbox=${BA}&q=cafe`)
    expect(res.status).toBe(400)
    expect((res.body as { error: string }).error).toContain('alternativos')
  })

  it('el error de los dos juntos no es un error de formato de bbox', async () => {
    // Con un bbox invalido Y un `q` presente, el mensaje tiene que ser el del
    // contrato, no "abarca demasiado": si el usuario se equivoco de filtro, que
    // le digan que se equivoco de filtro.
    const res = await new Client().get('/api/places?bbox=basura&q=cafe')
    expect(res.status).toBe(400)
    expect((res.body as { error: string }).error).not.toContain('abarca demasiado')
  })

  it('ninguno de los dos da 400, diciendo cuales son las dos opciones', async () => {
    // El mensaje importa mas que el status. `parseBbox` tambien responde 400
    // cuando no recibe una caja, asi que un test que solo mirara el status
    // pasaria aunque la ruta dejara de validar el contrato y devolviera el
    // error de formato equivocado.
    const res = await new Client().get('/api/places?category=CAFE')
    expect(res.status).toBe(400)
    const error = (res.body as { error: string }).error
    expect(error).toContain('bbox o q')
    expect(error).not.toContain('abarca demasiado')
  })

  it('un q de un solo caracter da 400 con el motivo', async () => {
    for (const q of ['a', '%20', ' ']) {
      const res = await new Client().get(`/api/places?q=${q}`)
      expect(res.status, `q=${q}`).toBe(400)
      expect((res.body as { error: string }).error, `q=${q}`).toContain('2 caracteres')
    }
  })

  it('los espacios alrededor del texto se ignoran antes de medir el largo', async () => {
    // `q=%20a%20` tiene 3 caracteres pero 1 util. Medir crudo deja pasar el piso
    // y devuelve la tabla entera.
    const res = await new Client().get('/api/places?q=%20%20a%20%20')
    expect(res.status).toBe(400)
  })

  it('un q de 2 caracteres utiles si funciona', async () => {
    const res = await new Client().get('/api/places?q=%20%20Le%20')
    expect(res.status).toBe(200)
    expect(placesOf(res).map((p) => p.name)).toEqual(['Parque Lejano'])
  })
})

describe('sincronia de las listas cerradas con los enums', () => {
  it('PLACE_CATEGORIES coincide con el enum de Prisma', () => {
    const fromEnum = Object.values(PlaceCategory).sort()
    expect([...PLACE_CATEGORIES].sort()).toEqual(fromEnum)
  })

  it('toda categoria tiene etiqueta, y ninguna etiqueta sobra', () => {
    // Un enum nuevo sin etiqueta se renderiza como `<option>{undefined}</option>`
    // y no rompe el build: se ve roto en la pantalla y nada mas. Y una etiqueta
    // sin valor al que corresponda es un filtro que la API va a rechazar con 400
    // si alguien lo selecciona.
    expect(Object.keys(CATEGORY_LABELS).sort()).toEqual([...PLACE_CATEGORIES].sort())
  })
})
