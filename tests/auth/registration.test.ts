import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { hashPassword } from '../../lib/auth/password'
import { Client } from '../helpers/http'
import { closeDb, rawQuery, resetDb } from '../helpers/db'

/**
 * Seccion 6 del doc: bordes de validacion, normalizacion de email, y lo que
 * se guarda en la base. Mismo motivo que `authorization.test.ts`: se verificaron
 * a mano una vez y no hay nada que impida que se rompan.
 */

const PASSWORD = 'correcto-caballo-grapa-42'

beforeEach(resetDb)
afterAll(closeDb)

describe('registro: validacion de entrada', () => {
  it('rechaza una contrasena de 11 caracteres', async () => {
    const res = await new Client().register('Barbara', 'b@example.com', 'once1234567')
    expect(res.status).toBe(400)
    expect((res.body as { fields: Record<string, string> }).fields.password).toMatch(/12/)
  })

  it('acepta una contrasena de exactamente 12', async () => {
    const res = await new Client().register('Barbara', 'b@example.com', 'once12345678')
    expect(res.status).toBe(201)
  })

  it('acepta 128 y rechaza 129 caracteres', async () => {
    const c = new Client()
    expect((await c.register('Nombre Uno', 'a@example.com', 'x'.repeat(128))).status).toBe(201)
    expect((await c.register('Nombre Dos', 'b@example.com', 'x'.repeat(129))).status).toBe(400)
  })

  it('rechaza un email sin formato', async () => {
    const res = await new Client().register('Barbara', 'no-es-email', PASSWORD)
    expect(res.status).toBe(400)
  })

  it('rechaza un nombre de 1 caracter', async () => {
    const res = await new Client().register('X', 'x@example.com', PASSWORD)
    expect(res.status).toBe(400)
  })

  it('rechaza un body que no es JSON', async () => {
    const res = await new Client().post('/api/auth/register', 'texto-plano')
    expect(res.status).toBe(400)
  })

  it('rechaza campos faltantes, nombrando cada uno', async () => {
    const res = await new Client().post('/api/auth/register', {})
    expect(res.status).toBe(400)
    const fields = (res.body as { fields: Record<string, string> }).fields
    expect(fields).toHaveProperty('name')
    expect(fields).toHaveProperty('email')
    expect(fields).toHaveProperty('password')
  })
})

describe('registro: normalizacion y unicidad de email', () => {
  it('guarda el email en minusculas aunque venga mezclado', async () => {
    const res = await new Client().register('Ana Ruiz', 'Ana.Ruiz@Example.COM', PASSWORD)
    expect(res.status).toBe(201)
    expect((res.body as { user: { email: string } }).user.email).toBe('ana.ruiz@example.com')

    const rows = await rawQuery<{ email: string }>('SELECT email FROM "User"')
    expect(rows).toHaveLength(1)
    expect(rows[0].email).toBe('ana.ruiz@example.com')
  })

  it('rechaza el mismo email escrito con otra caja (409, no dos usuarios)', async () => {
    const c = new Client()
    expect((await c.register('Ana', 'ana@example.com', PASSWORD)).status).toBe(201)

    const res = await c.register('Ana Otra', 'ANA@EXAMPLE.COM', PASSWORD)
    expect(res.status).toBe(409)

    const rows = await rawQuery('SELECT id FROM "User"')
    expect(rows).toHaveLength(1)
  })

  it('el login acepta el email en cualquier caja', async () => {
    const c = new Client()
    await c.register('Ana Ruiz', 'ana@example.com', PASSWORD)
    const res = await new Client().login('ANA@Example.com', PASSWORD)
    expect(res.status).toBe(200)
  })
})

describe('registro: lo que queda guardado', () => {
  it('el passwordHash es argon2id y nunca la contrasena en claro', async () => {
    await new Client().register('Ana Ruiz', 'ana@example.com', PASSWORD)

    const rows = await rawQuery<{ passwordHash: string }>(
      'SELECT "passwordHash" FROM "User" WHERE email = $1',
      ['ana@example.com'],
    )
    expect(rows).toHaveLength(1)
    // Sin orden fijo de parametros: argon2 emite `m,p,t`.
    expect(rows[0].passwordHash).toMatch(/^\$argon2id\$v=19\$m=\d+,p=\d+,t=\d+\$/)
    expect(rows[0].passwordHash).not.toContain(PASSWORD)
  })

  it('el registro asigna el rol USER y deja la cuenta activa', async () => {
    await new Client().register('Ana Ruiz', 'ana@example.com', PASSWORD)

    const users = await rawQuery<{ isActive: boolean }>(
      'SELECT "isActive" FROM "User" WHERE email = $1',
      ['ana@example.com'],
    )
    expect(users).toHaveLength(1)
    expect(users[0].isActive).toBe(true)

    const roles = await rawQuery<{ role: string }>(
      `SELECT r.role FROM "UserRoleAssignment" r
       JOIN "User" u ON u.id = r."userId" WHERE u.email = $1`,
      ['ana@example.com'],
    )
    expect(roles.map((r) => r.role)).toEqual(['USER'])
  })

  it('el registro deja al usuario con sesion iniciada', async () => {
    const c = new Client()
    const res = await c.register('Ana Ruiz', 'ana@example.com', PASSWORD)
    expect(res.status).toBe(201)
    expect(c.cookieHeader).toContain('nexa_session')

    const me = await c.get('/api/auth/me')
    expect(me.status).toBe(200)
  })

  it('la cookie emitida lleva HttpOnly y SameSite', async () => {
    const c = new Client()
    const res = await c.req('/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ana Ruiz', email: 'ana@example.com', password: PASSWORD }),
    })
    const raw = res.headers.getSetCookie().find((c) => c.startsWith('nexa_session='))!
    expect(raw).toMatch(/HttpOnly/i)
    expect(raw).toMatch(/SameSite=Lax/i)
  })
})

describe('login', () => {
  beforeEach(async () => {
    await new Client().register('Ana Ruiz', 'ana@example.com', PASSWORD)
  })

  it('rechaza una contrasena incorrecta', async () => {
    const res = await new Client().login('ana@example.com', 'equivocada-12345')
    expect(res.status).toBe(401)
  })

  it('rechaza un email inexistente con el MISMO mensaje', async () => {
    const res = await new Client().login('nadie@example.com', PASSWORD)
    expect(res.status).toBe(401)
    expect((res.body as { error: string }).error).toBe('Email o contrasena incorrectos')
  })

  it('el mensaje de error no distingue entre email inexistente y password mala', async () => {
    const a = await new Client().login('nadie@example.com', PASSWORD)
    const b = await new Client().login('ana@example.com', 'equivocada-12345')
    expect((a.body as { error: string }).error).toBe((b.body as { error: string }).error)
  })

  it('la contrasena se compara con mayusculas significativas', async () => {
    await new Client().register('Dora', 'dora@example.com', 'SeCtA-De-Verificacion')
    expect((await new Client().login('dora@example.com', 'secta-de-verificacion')).status).toBe(401)
    expect((await new Client().login('dora@example.com', 'SeCtA-De-Verificacion')).status).toBe(200)
  })
})

describe('sesion', () => {
  beforeEach(async () => {
    await new Client().register('Ana Ruiz', 'ana@example.com', PASSWORD)
  })

  it('logout limpia la cookie y /me pasa a 401', async () => {
    const c = new Client()
    await c.login('ana@example.com', PASSWORD)
    expect((await c.get('/api/auth/me')).status).toBe(200)

    expect((await c.post('/api/auth/logout', {})).status).toBe(200)

    expect((await c.get('/api/auth/me')).status).toBe(401)
  })

  it('/me sin cookie devuelve 401', async () => {
    expect((await new Client().get('/api/auth/me')).status).toBe(401)
  })

  it('la cookie de una cuenta vale en /me con el rol resuelto desde la base', async () => {
    const c = new Client()
    await c.login('ana@example.com', PASSWORD)
    const res = await c.get('/api/auth/me')
    expect((res.body as { user: { roles: string[] } }).user.roles).toEqual(['USER'])
  })
})
