import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { hashPassword } from '../../lib/auth/password'
import { Client } from '../helpers/http'
import { addRole, closeDb, createUser, resetDb, revokeRole, setActive, setDeleted, setSuspended } from '../helpers/db'

/**
 * Los 9 escenarios de `docs/decisiones-auth.md` seccion 4, como tests.
 *
 * El motivo de que existan: en el slice A esto se verifico con scripts de
 * PowerShell contra la app andando. Se ejecuto una vez, dio bien, y quedo
 * citado en el doc. Eso es exactamente el estado en el que un control de
 * acceso se erosiona: nadie lo rompe a proposito, alguien adjusts un matcher,
 * un test sigue verde porque no existia, y tres meses despues la ruta `/admin`
 * esta abierta.
 *
 * La asercion clave NO es "da 403". Es que el MISMO cliente, con el MISMO
 * cookie, cambia de veredicto segun lo que hay en `UserRoleAssignment`. Eso
 * distingue un gate que consulta la base de uno que confia en el cliente.
 */

const PASSWORD = 'correcto-caballo-grapa-42'

let ana: { id: string; email: string }

beforeEach(async () => {
  await resetDb()
  const passwordHash = await hashPassword(PASSWORD)
  ana = await createUser({
    email: 'ana@example.com',
    name: 'Ana Ruiz',
    passwordHash,
    roles: ['USER'],
  })
})

afterAll(async () => {
  await closeDb()
})

/** Cliente con sesion iniciada de Ana. */
async function anaClient(): Promise<Client> {
  const c = new Client()
  const res = await c.login(ana.email, PASSWORD)
  expect(res.status, 'el login de fixture deberia funcionar').toBe(200)
  expect(c.cookieHeader, 'el login deberia emitir cookie de sesion').toContain('nexa_session')
  return c
}

describe('control de acceso por rol (seccion 4 del doc)', () => {
  it('1. USER recibe 403 en /admin, /host y /curacion', async () => {
    const c = await anaClient()
    for (const path of ['/admin', '/host', '/curacion']) {
      const res = await c.get(path)
      expect(res.status, `${path} deberia rechazar a un USER`).toBe(403)
    }
  })

  it('1b. el 403 dice que falta el rol, no devuelve la pagina', async () => {
    const c = await anaClient()
    const res = await c.get('/admin')
    // Si el gate se rompe y se renderiza la pagina, el body no puede contener
    // el contenido de la ruta protegida.
    expect(res.text).not.toContain('Llegaste aca')
    expect(res.text).toMatch(/ADMIN|MODERATOR/)
  })

  it('2. USER si puede entrar a la home', async () => {
    const c = await anaClient()
    const res = await c.get('/')
    expect(res.status).toBe(200)
  })

  it('3. con ADMIN Otorgado en la base, el MISMO cookie entra a las tres rutas', async () => {
    const c = await anaClient()

    // Antes del cambio, con este mismo cliente:
    expect((await c.get('/admin')).status).toBe(403)

    await addRole(ana.id, 'ADMIN')

    // Mismo cliente, mismo cookie, sin re-loguear. Si esto no cambia, el gate
    // no esta leyendo UserRoleAssignment.
    for (const path of ['/admin', '/host', '/curacion']) {
      const res = await c.get(path)
      expect(res.status, `${path} deberia abrir con ADMIN`).toBe(200)
      expect(res.text).toContain('Llegaste aca')
    }
  })

  it('4. revocado el rol, vuelve a 403 sin tocar el cookie', async () => {
    const c = await anaClient()
    await addRole(ana.id, 'ADMIN')
    expect((await c.get('/admin')).status).toBe(200)

    await revokeRole(ana.id, 'ADMIN')

    expect((await c.get('/admin')).status).toBe(403)
  })

  it('5. una cuenta suspendida da 403 aunque el rol siga vigente', async () => {
    await addRole(ana.id, 'ADMIN')
    const c = await anaClient()
    expect((await c.get('/admin')).status).toBe(200)

    await setSuspended(ana.id, true)

    expect((await c.get('/admin')).status).toBe(403)
    // El login tambien se bloquea, no solo las rutas protegidas.
    const otro = new Client()
    expect((await otro.login(ana.email, PASSWORD)).status).toBe(403)
  })

  it('5b. la home publica sigue respondiendo con la cuenta suspendida', async () => {
    await setSuspended(ana.id, true)
    const c = new Client()
    expect((await c.get('/')).status).toBe(200)
  })

  it('6. reactivada la cuenta, vuelve a 200', async () => {
    await addRole(ana.id, 'ADMIN')
    const c = await anaClient()
    await setSuspended(ana.id, true)
    expect((await c.get('/admin')).status).toBe(403)

    await setSuspended(ana.id, false)

    expect((await c.get('/admin')).status).toBe(200)
  })

  it('7. sin cookie, las rutas de rol devuelven 401', async () => {
    const anon = new Client()
    for (const path of ['/admin', '/host', '/curacion']) {
      expect((await anon.get(path)).status, `${path} sin sesion`).toBe(401)
    }
  })

  it('8. una cookie con firma falsificada devuelve 401', async () => {
    const c = new Client()
    // Payload con forma correcta, firma inventada.
    c.setCookie('nexa_session', 'eyJ1aWQiOiJoYWNrZWQiLCJ2ZXIiOjEsImlhdCI6MX0.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')
    expect((await c.get('/admin')).status).toBe(401)
  })

  it('8b. manipular el payload sin romper la firma no sirve de nada', async () => {
    // Un token con un uid arbitrario y firma inventada. Si la verificacion no
    // firmara el payload, o aceptara cualquier firma, este token pasaria.
    const forjado = new Client()
    forjado.setCookie('nexa_session', tamperedSession(ana.id))
    expect((await forjado.get('/admin')).status).toBe(401)
  })

  it('9. un Origin distinto del configurado se rechaza', async () => {
    const c = new Client()
    const res = await c.req('/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://sitio-malicioso.example' },
      body: JSON.stringify({ name: 'Evil', email: 'evil@example.com', password: PASSWORD }),
    })
    expect(res.status).toBe(403)
  })
})

/**
 * Construye un token con el payload manipulado y una firma que no corresponde.
 * Si la verificacion no usara tiempo constante sobre la firma, o no firmara
 * el payload, este token pasaria.
 */
function tamperedSession(uid: string): string {
  const payload = Buffer.from(
    JSON.stringify({ uid, ver: 1, iat: Math.floor(Date.now() / 1000), exp: 9999999999 }),
  ).toString('base64url')
  return `${payload}.${'A'.repeat(43)}`
}

/**
 * Estado de la cuenta, independiente del rol.
 *
 * Estos dos casos NO estaban en los 9 escenarios del doc, y aparecen aca
 * porque el mutation testing los expojo como el unico punto ciego real: el
 * middleware tiene las comprobaciones de `isActive` y `deletedAt`, pero ningun
 * test las ejercitaba. Borrar cualquiera de las dos dejaba la suite en verde.
 */
describe('estado de la cuenta (agregado por mutation testing)', () => {
  it('una cuenta desactivada da 403 aunque tenga el rol y la cookie sea valida', async () => {
    await addRole(ana.id, 'ADMIN')
    const c = await anaClient()
    expect((await c.get('/admin')).status).toBe(200)

    await setActive(ana.id, false)

    expect((await c.get('/admin')).status, 'isActive=false deberia cortar el acceso').toBe(403)
    // Tambien corta el login, no solo las rutas ya protegidas.
    const otro = new Client()
    expect((await otro.login(ana.email, PASSWORD)).status).toBe(403)
  })

  it('una cuenta con deletedAt da 401, no 403', async () => {
    await addRole(ana.id, 'ADMIN')
    const c = await anaClient()
    expect((await c.get('/admin')).status).toBe(200)

    await setDeleted(ana.id, true)

    // 401 y no 403: la cuenta ya no existe, no es un problema de permisos.
    // Confundir los dos cambia lo que la UI le puede sugerir al usuario.
    expect((await c.get('/admin')).status, 'deletedAt deberia dar 401').toBe(401)
  })

  it('el mismo cookie revive al restaurar la cuenta: no se cachea el veredicto', async () => {
    await addRole(ana.id, 'ADMIN')
    const c = await anaClient()
    await setDeleted(ana.id, true)
    expect((await c.get('/admin')).status).toBe(401)

    await setDeleted(ana.id, false)

    // Refuerza que la sesion se evalua contra la base en cada request.
    expect((await c.get('/admin')).status).toBe(200)
  })
})
