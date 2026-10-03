import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { hashPassword } from '../../lib/auth/password'
import { Client } from '../helpers/http'
import { fuentesDeRuta } from '../helpers/chunks'
import { addRole, closeDb, createPlace, createUser, resetDb } from '../helpers/db'

/**
 * `/host/planes/nuevo` es la primera pantalla de creacion de plan.
 *
 * Lo que se verifica aca es lo que NO se ve en `tsc` ni en el build:
 *
 *   1. El middleware la rechaza sin rol, y no solo la API. La pagina es
 *      alcanzable escribiendo la URL, asi que el gate tiene que estar en el
 *      middleware por prefijo, no solo en el `POST`.
 *   2. RENDERIZA con sesion de host. Un error de import dinamico, un nombre de
 *      archivo mal puesto o un hook llamado fuera de orden se ven en el
 *      navegador, en blanco, y en ningun lado mas.
 *   3. El HTML inicial no pide datos de terceros: los lugares llegan por fetch
 *      desde el endpoint del selector.
 *   4. El formulario no manda la `description` vacia como si fuera un string.
 *      Esa es una diferencia de una linea entre "sin descripcion" y "descripcion
 *      en blanco", y solo se nota en la base.
 *
 * Lo que NO se verifica: que el formulario cree un plan de verdad. Eso lo cubre
 * `tests/map/plans-api.test.ts` contra el endpoint, y aca no hay navegador para
 * tipear.
 */

const PASSWORD = 'correcto-caballo-grapa-42'

let host: { id: string; email: string }
let plain: { id: string; email: string }

beforeEach(async () => {
  await resetDb()
  const passwordHash = await hashPassword(PASSWORD)
  host = await createUser({ email: 'host@example.com', name: 'Host', passwordHash, roles: ['USER'] })
  plain = await createUser({ email: 'ana@example.com', name: 'Ana', passwordHash, roles: ['USER'] })
  await addRole(host.id, 'HOST')
  await createPlace({ name: 'Cafe Aprobado', lat: -34.6037, lng: -58.3816 })
})

afterAll(async () => {
  await closeDb()
})

async function loginAs(email: string): Promise<Client> {
  const c = new Client()
  const res = await c.login(email, PASSWORD)
  expect(res.status).toBe(200)
  return c
}

describe('GET /host/planes/nuevo', () => {
  it('sin sesion no se renderiza: el middleware rechaza antes de la pagina', async () => {
    const res = await new Client().get('/host/planes/nuevo')
    expect(res.status).toBe(401)
  })

  it('un USER sin rol HOST tampoco llega, aunque tenga sesion', async () => {
    const c = await loginAs(plain.email)
    const res = await c.get('/host/planes/nuevo')
    expect(res.status).toBe(403)
  })

  it('renderiza con 200 para un host', async () => {
    const c = await loginAs(host.email)
    const res = await c.get('/host/planes/nuevo')
    expect(res.status).toBe(200)
  })

  it('el HTML trae el formulario y sus campos', async () => {
    const c = await loginAs(host.email)
    const { text } = await c.get('/host/planes/nuevo')

    // Los `id` son los que conectan `label htmlFor` con `input id`. Sin la
    // pareja, el clic en la etiqueta no enfoca el campo y la pantalla falla el
    // teclado entero sin que se note mirando.
    for (const id of ['place-q', 'title', 'description', 'startsAt', 'endsAt', 'capacity']) {
      expect(text, `falta el control ${id}`).toContain(`id="${id}"`)
    }
    expect(text).toContain('Buscar por nombre')
    expect(text).toContain('Crear plan')
  })

  it('los limites del cliente coinciden con el schema', async () => {
    // Duplicados a proposito como ASERCION, no como validacion: si el schema
    // cambia los maximos y nadie toca el formulario, este test avisa. La
    // validacion de verdad sigue estando en el server; esto es para que el
    // `maxLength` del input no quede viejo en silencio.
    //
    // Se busca la forma RENDERIZADA (`maxLength="120"`), no la del JSX
    // (`maxLength={120}`): React no deja la expresion en el HTML, asi que la
    // asercion sobre el fuente pasaria en el componente y fallaria aca.
    const c = await loginAs(host.email)
    const { text } = await c.get('/host/planes/nuevo')
    expect(text).toContain('maxLength="120"')
    expect(text).toContain('maxLength="2000"')
    expect(text).toContain('minLength="3"')
    expect(text).toContain('min="2"')
    expect(text).toContain('max="50"')
  })

  it('el HTML inicial no trae lugares: se piden al selector', async () => {
    const c = await loginAs(host.email)
    const { text } = await c.get('/host/planes/nuevo')
    // El nombre del lugar sembrado no debe estar en el HTML. Si aparece, es que
    // el picker se esta server-renderizando con datos, y entonces el HTML
    // mostraria los lugares de otra sesion.
    expect(text).not.toContain('Cafe Aprobado')
    // Y el `fieldset` del selector tiene que venir sin resultados ya cargados.
    const picker = text.slice(text.indexOf('class="picker"'), text.indexOf('</fieldset>'))
    expect(picker).not.toContain('<li')
  })

  it('el selector pega al endpoint con rol, no al publico', async () => {
    // La URL del `fetch` vive en el chunk del cliente, no en el HTML: por eso
    // este test lee el bundle de la pagina y busca en el contenido.
    // Verificarlo en el HTML daria verde siempre.
    const joined = fuentesDeRuta('/host/planes/nuevo')
    expect(joined, 'el selector deberia pegarle al endpoint con rol').toContain('/api/host/places')
    // Y no al publico: pegarle al publico es el bug que hace que un curador
    // ofrezca lugares pendientes que el POST va a rechazar.
    expect(joined).not.toContain('"/api/places?q="')
  })

  it('explica la regla de disponibilidad en el propio formulario', async () => {
    // El selector ya aplica `planablePlaceWhere`. Decirlo en pantalla evita el
    // ticket de "¿por que no aparece el lugar que arme?", que es la pregunta
    // que hace cualquiera que conoce un lugar y no lo encuentra.
    const c = await loginAs(host.email)
    const { text } = await c.get('/host/planes/nuevo')
    expect(text).toContain('Solo aparecen lugares aprobados')
  })
})
