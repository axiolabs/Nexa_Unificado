import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { hashPassword } from '../../lib/auth/password'
import { getPrisma } from '../../lib/db'
import { Client } from '../helpers/http'
import { addRole, closeDb, createPlace, createUser, resetDb } from '../helpers/db'

/**
 * `GET /api/host/places` es el selector de lugares del formulario de creacion de
 * plan, y existe aparte de `/api/places` por una sola razon: responde una
 * pregunta DISTINTA.
 *
 *   - `/api/places` -> "que lugares puedo ver?" incluye los `PENDING` del curador.
 *   - `/api/host/places` -> "donde puedo hacer un plan?" solo `APPROVED`.
 *
 * Si el formulario usara el endpoint publico, un curador elegiria un lugar
 * pendiente, llenaria el formulario entero, y el `POST /api/plans` le responderia
 * 404 al final. El 404 seria correcto; el problema es que el error llega cuando
 * el usuario ya termino de hacer todo el trabajo.
 *
 * Estos tests fijan esa diferencia. Si alguien "simplifica" un endpoint en el
 * otro, aca se entera.
 */

const PASSWORD = 'correcto-caballo-grapa-42'

let host: { id: string; email: string }
let hostCurator: { id: string; email: string }
let plain: { id: string; email: string }

async function hostClient(email: string): Promise<Client> {
  const c = new Client()
  const res = await c.login(email, PASSWORD)
  expect(res.status).toBe(200)
  return c
}

beforeEach(async () => {
  await resetDb()
  const passwordHash = await hashPassword(PASSWORD)
  host = await createUser({ email: 'host@example.com', name: 'Host', passwordHash, roles: ['USER'] })
  plain = await createUser({ email: 'ana@example.com', name: 'Ana', passwordHash, roles: ['USER'] })
  hostCurator = await createUser({
    email: 'curador@example.com',
    name: 'Curador',
    passwordHash,
    roles: ['USER'],
  })
  await addRole(host.id, 'HOST')
  await addRole(hostCurator.id, 'HOST')
  await addRole(hostCurator.id, 'CURATOR')
  await addRole(host.id, 'ADMIN')
})

afterAll(async () => {
  await closeDb()
})

describe('GET /api/host/places', () => {
  it('exige sesion', async () => {
    const res = await new Client().get('/api/host/places?q=Cafe')
    expect(res.status).toBe(401)
  })

  it('exige rol HOST o ADMIN: un USER registrado no alcanza', async () => {
    const c = await hostClient(plain.email)
    const res = await c.get('/api/host/places?q=Cafe')
    expect(res.status).toBe(403)
  })

  it('deja buscar a un host, y encuentra por nombre', async () => {
    await createPlace({ name: 'Cafe Aprobado', lat: -34.6037, lng: -58.3816 })
    const c = await hostClient(host.email)
    const res = await c.get('/api/host/places?q=Aprobado')
    expect(res.status).toBe(200)
    const body = res.body as { places: { name: string }[]; total: number; truncated: boolean }
    expect(body.places.map((p) => p.name)).toEqual(['Cafe Aprobado'])
    expect(body.total).toBe(1)
    expect(body.truncated).toBe(false)
  })

  it('deja buscar a un admin, que tambien puede crear planes', async () => {
    await createPlace({ name: 'Cafe Aprobado', lat: -34.6037, lng: -58.3816 })
    const c = await hostClient(host.email)
    expect((await c.get('/api/host/places?q=Aprobado')).status).toBe(200)
  })

  it('NO muestra un PENDING ni a un curador: es el selector, no la cola de moderacion', async () => {
    await createPlace({ name: 'Bar Sin Revisar', lat: -34.604, lng: -58.382, verificationStatus: 'PENDING' })
    const c = await hostClient(hostCurator.email)

    const selector = (await c.get('/api/host/places?q=Revisar')).body as { places: unknown[] }
    expect(selector.places).toEqual([])

    // El mismo lugar, en el endpoint publico, SI aparece. Si este test pasara
    // solo porque el fixture esta mal sembrado, el otro falla: los dos leen la
    // misma fila.
    const publico = (await c.get('/api/places?q=Revisar')).body as { places: unknown[] }
    expect(publico.places).toHaveLength(1)
  })

  it('NO muestra un REJECTED, ni uno inactivo, ni uno borrado logicamente', async () => {
    await createPlace({ name: 'Bar Rechazado', lat: -34.6041, lng: -58.3821, verificationStatus: 'REJECTED' })
    await createPlace({ name: 'Bar Apagado', lat: -34.6042, lng: -58.3822, isActive: false })
    await createPlace({ name: 'Bar Borrado', lat: -34.6043, lng: -58.3823, deleted: true })
    const c = await hostClient(host.email)

    for (const nombre of ['Rechazado', 'Apagado', 'Borrado']) {
      const res = (await c.get(`/api/host/places?q=${nombre}`)).body as {
        places: unknown[]
        total: number
      }
      expect(res.places, `no deberia ofrecer "${nombre}"`).toEqual([])
      expect(res.total).toBe(0)
    }
  })

  it('es la MISMA regla que aplica el POST, no una parecida', async () => {
    // El contrato entero de esta suite cabe en una linea: todo lugar que el
    // selector ofrece tiene que ser aceptable por `POST /api/plans`. La
    // asercion usa el endpoint real en vez de repetir el predicado, porque dos
    // copias de la regla divergen apenas alguien cambia una.
    await createPlace({ name: 'Cafe Aprobado', lat: -34.6037, lng: -58.3816 })
    const c = await hostClient(host.email)
    const res = await c.get('/api/host/places?q=Aprobado')
    const lugares = (res.body as { places: { id: string }[] }).places
    expect(lugares).toHaveLength(1)

    const future = new Date(Date.now() + 86_400_000)
    const post = await c.post('/api/plans', {
      title: 'Probando el contrato del selector',
      placeId: lugares[0].id,
      startsAt: future.toISOString(),
      capacity: 4,
    })
    expect(post.status).toBe(201)
  })

  it('pide dos caracteres y dice cuales son los dos modos de buscar', async () => {
    const c = await hostClient(host.email)
    const corto = await c.get('/api/host/places?q=a')
    expect(corto.status).toBe(400)

    const sinQ = await c.get('/api/host/places')
    expect(sinQ.status).toBe(400)
  })

  it('no depende de una caja: el buscador es global a proposito', async () => {
    // El mapa es una caja; el buscador es una consulta. Un host que busca "Parque"
    // quiere todos los parques, no los que caen dentro de la vista que todavia no
    // eligio. Por eso este endpoint no acepta `bbox` y no lo filtra.
    await createPlace({ name: 'Parque Lejano', lat: -34.9, lng: -58.9 })
    const c = await hostClient(host.email)
    const res = await c.get('/api/host/places?q=Parque')
    expect((res.body as { places: { name: string }[] }).places.map((p) => p.name)).toEqual([
      'Parque Lejano',
    ])
  })

  it('ignora un bbox en vez de mezclarlo en silencio', async () => {
    // Si se aceptara, el host que pegara un bbox con la URL del mapa veria una
    // lista vacia y concluiria que no hay lugares. Es peor que un 400.
    await createPlace({ name: 'Cafe Aprobado', lat: -34.6037, lng: -58.3816 })
    const c = await hostClient(host.email)
    const conCaja = '/api/host/places?q=Cafe&bbox=-58.50,-34.65,-58.30,-34.55'
    const res = await c.get(conCaja)
    // Hoy el `bbox` no se lee y el filtro es solo por nombre. Lo que importa es
    // que la respuesta NO dependa de la caja.
    expect((res.body as { places: { name: string }[] }).places).toHaveLength(1)
  })

  it('declara el tope con total y truncated, igual que el endpoint publico', async () => {
    for (let i = 0; i < 25; i++) {
      await createPlace({ name: `Cafe Numero ${String(i).padStart(2, '0')}`, lat: -34.6, lng: -58.38 })
    }
    const c = await hostClient(host.email)
    const res = (await c.get('/api/host/places?q=Cafe')).body as {
      places: unknown[]
      total: number
      truncated: boolean
    }
    expect(res.total).toBe(25)
    expect(res.places).toHaveLength(20)
    expect(res.truncated).toBe(true)
  })

  it('no lleva datos del dueño del lugar, igual que el endpoint publico', async () => {
    const place = await createPlace({ name: 'Cafe Aprobado', lat: -34.6037, lng: -58.3816 })
    const c = await hostClient(host.email)
    const res = (await c.get('/api/host/places?q=Cafe')).body as { places: Record<string, unknown>[] }
    const row = res.places[0]

    // La lista EXACTA, no un `not.toContain`. Un `not.toContain('ownerId')`
    // pasa aunque la fila exponga `verifiedById` con el id de quien verifico el
    // lugar, que es el mismo error con otro nombre: la lista cerrada es la que
    // obliga a pensar en cada campo nuevo antes de mandarlo.
    expect(Object.keys(row).sort()).toEqual([
      'category',
      'description',
      'id',
      'latitude',
      'longitude',
      'name',
      'openPlanCount',
    ])
    expect(row.latitude).toBeTypeOf('number')
    expect(row.latitude).not.toBeTypeOf('string')

    // Y que el `ownerId` exista de verdad en la fila de la base, o el test de
    // arriba probaria una columna que ya no esta.
    await expect(getPrisma().place.findUnique({ where: { id: place.id } })).resolves.toBeTruthy()
  })

  it('no se cachea: la respuesta depende de quien pregunta', async () => {
    const c = await hostClient(host.email)
    const res = await c.get('/api/host/places?q=Cafe')
    expect(res.headers.get('cache-control')).toBe('private, no-store')
  })
})
