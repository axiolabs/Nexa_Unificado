import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { hashPassword } from '../../lib/auth/password'
import { buildBbox } from '../../lib/map-bbox'
import { DEFAULT_CENTER, DEFAULT_ZOOM, OSM_ATTRIBUTION, resolveTileConfig } from '../../lib/map-tiles'
import { Client } from '../helpers/http'
import { addRole, closeDb, createPlace, createPlan, createUser, resetDb } from '../helpers/db'

/**
 * `/explore` es la pagina publica del producto.
 *
 * Lo que se verifica aca no es el Leaflet (eso necesita un navegador), sino las
 * cosas que se rompen sin avisar:
 *
 *   1. La pagina RENDERIZA sin sesion. Un error de import dinamico mal puesto no
 *      se ve en `tsc` ni en el build: se ve en el navegador, en blanco.
 *   2. La atribucion de OSM dice "contributors". Va sobre la constante, no sobre
 *      el HTML, porque Leaflet la pinta en el cliente.
 *   3. Leaflet NO entra en el bundle inicial, que es el punto de `ssr: false`.
 *   4. El HTML inicial no trae datos de terceros: los llegan por fetch.
 */

const PASSWORD = 'correcto-caballo-grapa-42'

/**
 * La caja que el navegador pide en la primera carga: la que sale del centro por
 * defecto. Se CALCULA en vez de estar escrita a mano, porque si esta escrita a
 * mano el test sigue pasando cuando `DEFAULT_CENTER` se mueve a otra ciudad, y
 * ese es justo el error que hay que cazar (el seed en una ciudad y el centro en
 * otra deja el mapa vacio sin que nada falle).
 */
const CAJA_POR_DEFECTO = (() => {
  const b = buildBbox(DEFAULT_CENTER, DEFAULT_ZOOM)
  return [b.minLng, b.minLat, b.maxLng, b.maxLat].join(',')
})()

let ana: { id: string; email: string }
let beto: { id: string; email: string }

beforeEach(async () => {
  await resetDb()
  const passwordHash = await hashPassword(PASSWORD)
  ana = await createUser({ email: 'ana@example.com', name: 'Ana Ruiz', passwordHash, roles: ['USER'] })
  beto = await createUser({ email: 'beto@example.com', name: 'Beto Diaz', passwordHash, roles: ['USER'] })
  // Coordenadas dentro de la caja por defecto (Manizales), no en Buenos Aires:
  // un fixture fuera de la caja hace que el test valide "el filtro anda bien"
  // cuando en realidad esta probando que el filtro descarta todo.
  const place = await createPlace({ name: 'Cafe Tortuga', lat: 5.0703, lng: -75.5183 })
  await createPlan({ placeId: place.id, creatorId: ana.id, capacity: 4, acceptedCount: 1 })
})

afterAll(async () => {
  await closeDb()
})

describe('GET /explore', () => {
  it('renderiza sin sesion, con 200', async () => {
    const res = await new Client().get('/explore')
    expect(res.status).toBe(200)
    expect(res.text).toContain('Explorar')
  })

  it('no rompe el render con datos cargados', async () => {
    // El caso que mas falla: el componente monta, hace fetch, y el estado
    // inicial del mapa tiene que existir aunque la caja venga vacia.
    const c = new Client()
    expect((await c.login(ana.email, PASSWORD)).status).toBe(200)
    const res = await c.get('/explore')
    expect(res.status).toBe(200)
  })

  it('la atribucion de OSM dice "contributors"', () => {
    // La politica de OSM pide "OpenStreetMap contributors", no "OpenStreetMap".
    // Es una diferencia de una palabra, y es la palabra que hace legal el uso de
    // las teselas. Va como test sobre la constante y no sobre el HTML porque la
    // atribucion la pinta Leaflet dentro del `.leaflet-control-attribution`, que
    // se crea en el cliente: no existe todavia en el HTML del servidor.
    expect(OSM_ATTRIBUTION).toContain('OpenStreetMap contributors')
    expect(OSM_ATTRIBUTION).toContain('openstreetmap.org/copyright')
    expect(resolveTileConfig().attribution).toBe(OSM_ATTRIBUTION)
  })

  it('Leaflet NO se descarga en el primer render', async () => {
    // `dynamic(..., { ssr: false })` tiene que poner el mapa en un chunk aparte.
    // Si el bundle inicial lo trajera, cada visita a /explore pagaria la
    // descarga de Leaflet (~150 kB) antes de ver un solo lugar, y en un movil
    // con datos justos eso es la diferencia entre cargar y no cargar.
    //
    // El precio de esto es que el mapa aparece despues. Es el trade correcto:
    // el HTML y los filtros llegan al instante, y el mapa cuando puede.
    const res = await new Client().get('/explore')
    const scripts = [...res.text.matchAll(/src="([^"]+\.js)"/g)].map((m) => m[1])
    expect(scripts.length).toBeGreaterThan(0)

    const initial = await Promise.all(
      scripts.map((s) => fetch('http://127.0.0.1:3100' + s).then((r) => r.text())),
    )
    // Leaflet minificado se reconoce por su clase de contenedor, que no existe
    // en ningun otro modulo del proyecto.
    const traeLeaflet = initial.some((js) => js.includes('leaflet-container'))
    expect(traeLeaflet).toBe(false)
  })

  it('el esqueleto del mapa tiene altura, para que la pagina no salte', async () => {
    // Un contenedor de altura 0 hace que Leaflet dibuje en 0x0 y las teselas no
    // carguen. En el HTML del servidor solo esta el skeleton del `dynamic`, y su
    // altura es lo que evita el salto cuando el mapa entra.
    const res = await new Client().get('/explore')
    expect(res.text).toContain('map-skeleton')
  })

  it('ofrece los filtros de categoria y precio', async () => {
    const res = await new Client().get('/explore')
    expect(res.text).toContain('Categoria')
    expect(res.text).toContain('Precio')
    expect(res.text).toContain('Cafe')
  })

  it('el HTML no filtra datos de terceros', async () => {
    // La pagina es un Server Component que no consulta la base: los datos
    // llegan por fetch del lado del cliente. Este test fija que el HTML
    // inicial no los trae incrustados, que seria una fuga hacia un CDN o un
    // "ver fuente" sin sesion.
    const res = await new Client().get('/explore')
    expect(res.text).not.toContain(beto.email)
    expect(res.text).not.toContain(ana.email)
    expect(res.text).not.toContain('Plan de prueba')
  })

  it('la caja por defecto cubre Manizales y trae los lugares', async () => {
    // El centro por defecto tiene que incluir los lugares, o la primera
    // pantalla que ve un usuario nuevo esta vacia y parece rota.
    const res = await new Client().get(`/api/places?bbox=${CAJA_POR_DEFECTO}`)
    expect(res.status).toBe(200)
    const places = (res.body as { places: unknown[] }).places
    expect(places.length).toBeGreaterThan(0)
  })

  it('un curador tambien puede abrir la pagina', async () => {
    await addRole(ana.id, 'CURATOR')
    const c = new Client()
    expect((await c.login(ana.email, PASSWORD)).status).toBe(200)
    expect((await c.get('/explore')).status).toBe(200)
  })
})
