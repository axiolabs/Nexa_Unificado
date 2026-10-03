import { Client } from 'pg'
import { getPrisma } from '../../lib/db'
import './env'

/**
 * Helpers de base de datos para los tests.
 *
 * Se habla con `pg` directo y no con Prisma por una razon concreta: los tests
 * necesitan TRUNCATE y UPDATE crudos para simular suspension y revocacion de
 * roles, cosas que un ORM no deberia permitir en produccion pero que en un
 * fixture son exactamente lo que hay que ejecutar.
 */

// OJO: la constante NO se llama `URL`. `new URL(...)` de mas abajo usa la
// clase global, y namesake con la variable la tapaba: "URL is not a
// constructor".
const DB_URL = process.env.DATABASE_URL
if (!DB_URL) throw new Error('DATABASE_URL no esta definido (se carga desde .env.test)')

const dbName = new URL(DB_URL).pathname.replace(/^\//, '')

/**
 * Guardia: los tests hacen TRUNCATE. Apuntar esto a la base de desarrollo le
 * borraria los datos a quien este trabajando, y el error no se veria hasta
 * tarde. Se prefiere fallar en la primera linea.
 */
if (!dbName.endsWith('_test')) {
  throw new Error(
    `Los tests no tocan la base "${dbName}": tiene que terminar en "_test". ` +
      `Los tests hacen TRUNCATE.`,
  )
}

const client = new Client({ connectionString: DB_URL })
await client.connect()

/**
 * `SET TIME ZONE 'UTC'` antes de escribir cualquier fecha.
 *
 * Las columnas de fecha del schema son `timestamp WITHOUT TIME ZONE`, y hay dos
 * clientes distintos hablando con la misma base: Prisma y este `pg` crudo.
 *
 * Prisma escribe y lee el reloj de pared en UTC. `pg`, en cambio, serializa un
 * `Date` a la cadena de la zona LOCAL del proceso. Con la maquina en
 * America/Bogota (UTC-5), un fixture insertado aca queda 5 horas corrido
 * respecto de lo que Prisma espera, y el que lee despues (la app) ve un
 * instante que nunca existio.
 *
 * No es cosmetico: asi se produjo un fallo de 19h en vez de 24h en el calculo de
 * `expiresAt = min(now() + 24h, plan.startsAt)`, y el sintoma apuntaba al codigo
 * de la app cuando el bug estaba en el fixture. Fijar la zona de la sesion
 * alinea los dos clientes y hace que el error aparezca en el lugar correcto.
 *
 * La app no necesita esto: Prisma ya habla UTC. Esto alinea el `pg` crudo con
 * Prisma.
 */
await client.query("SET TIME ZONE 'UTC'")

/**
 * Normaliza un `Date` a texto UTC antes de mandarlo como parametro.
 *
 * `SET TIME ZONE` NO alcanza para esto y conviene dejarlo escrito: node-postgres
 * serializa el `Date` a cadena en la zona LOCAL del proceso antes de enviar la
 * consulta, asi que la zona de la sesion no llega a intervenir. Enviando el ISO
 * en UTC, Postgres guarda el reloj de pared en UTC, que es lo que Prisma espera
 * al leer.
 */
function sqlDate(d: Date): string {
  return d.toISOString()
}

/**
 * Borra todas las tablas de la app. `_prisma_migrations` se conserva: no es
 * estado de test, es el historial de migraciones, y borrarlo haria que un
 * `migrate deploy` posterior intentara reaplicar todo.
 */
export async function resetDb() {
  const { rows } = await client.query<{ tablename: string }>(`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename <> '_prisma_migrations'
  `)
  if (rows.length === 0) return
  const list = rows.map((r) => `"${r.tablename}"`).join(', ')
  await client.query(`TRUNCATE ${list} CASCADE`)
}

export async function closeDb() {
  await client.end()
}

/**
 * Crea un usuario con roles, sin pasar por la API: el fixture no es el objeto
 * de prueba.
 *
 * El `id` y los timestamps se generan aca y no se dejan en default porque
 * `@default(cuid())` y `@updatedAt` son defaults de PRISMA, no de Postgres: las
 * columnas quedan NOT NULL sin DEFAULT en la base, y un INSERT crudo sin esas
 * columnas falla con "null value ... violates not-null constraint".
 *
 * Importante para cualquier SQL crudo del proyecto, no solo para los tests.
 */
export async function createUser(opts: {
  email: string
  name?: string
  passwordHash: string
  roles?: string[]
  isActive?: boolean
  suspended?: boolean
  deleted?: boolean
}) {
  const id = await client.query<{ id: string }>(
    `INSERT INTO "User" (id, email, name, "passwordHash", "isActive", "suspendedAt", "deletedAt", "createdAt", "updatedAt")
     VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, now(), now()) RETURNING id`,
    [
      opts.email,
      opts.name ?? 'Test User',
      opts.passwordHash,
      opts.isActive ?? true,
      opts.suspended ? new Date() : null,
      opts.deleted ? new Date() : null,
    ],
  )
  const userId = id.rows[0].id

  for (const role of opts.roles ?? ['USER']) {
    await client.query(
      `INSERT INTO "UserRoleAssignment" ("userId", role) VALUES ($1, $2)`,
      [userId, role],
    )
  }
  return { id: userId, email: opts.email }
}

export async function addRole(userId: string, role: string) {
  await client.query(
    `INSERT INTO "UserRoleAssignment" ("userId", role) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [userId, role],
  )
}

export async function revokeRole(userId: string, role: string) {
  await client.query(
    `DELETE FROM "UserRoleAssignment" WHERE "userId" = $1 AND role = $2`,
    [userId, role],
  )
}

export async function setSuspended(userId: string, suspended: boolean) {
  await client.query(
    `UPDATE "User" SET "suspendedAt" = $2, "suspendedReason" = $3 WHERE id = $1`,
    [userId, suspended ? new Date() : null, suspended ? 'test' : null],
  )
}

/** Desactiva la cuenta sin suspenderla: es un estado distinto, con su propio 403. */
export async function setActive(userId: string, isActive: boolean) {
  await client.query(`UPDATE "User" SET "isActive" = $2 WHERE id = $1`, [userId, isActive])
}

/** Borrado logico. El middleware responde 401, no 403: la cuenta ya no existe. */
export async function setDeleted(userId: string, deleted: boolean) {
  await client.query(`UPDATE "User" SET "deletedAt" = $2 WHERE id = $1`, [
    userId,
    deleted ? new Date() : null,
  ])
}

export async function createPlace(opts: {
  name: string
  category?: string
  lat: number
  lng: number
  verificationStatus?: string
  isActive?: boolean
  deleted?: boolean
}) {
  const id = await client.query<{ id: string }>(
    `INSERT INTO "Place"
       (id, name, category, latitude, longitude, timezone,
        "verificationStatus", "isActive", "deletedAt", "createdAt", "updatedAt")
     VALUES (gen_random_uuid()::text, $1, $2, $3, $4, 'America/Argentina/Buenos_Aires',
             $5, $6, $7, now(), now())
     RETURNING id`,
    [
      opts.name,
      opts.category ?? 'CAFE',
      opts.lat,
      opts.lng,
      opts.verificationStatus ?? 'APPROVED',
      opts.isActive ?? true,
      opts.deleted ? sqlDate(new Date()) : null,
    ],
  )
  return { id: id.rows[0].id, name: opts.name }
}

export async function createPlan(opts: {
  placeId: string
  creatorId: string
  startsAt?: Date
  /**
   * Opcional a proposito. La app calcula si un plan termino con
   * `endsAt ?? startsAt`, asi que los dos caminos necesitan fixtures: sin
   * `endsAt` el plan termina cuando empieza, y con el sigue "en curso" hasta
   * `endsAt` aunque `startsAt` ya haya pasado. Un plan que empieza en el pasado
   * con `endsAt` futura es el caso raro, y sin el se prueba a medias.
   */
  endsAt?: Date
  capacity?: number
  status?: string
  acceptedCount?: number
  deleted?: boolean
}) {
  const id = await client.query<{ id: string }>(
    `INSERT INTO "Plan"
       (id, title, "placeId", "creatorId", "startsAt", "endsAt", capacity, "acceptedCount",
        status, "deletedAt", "createdAt", "updatedAt")
     VALUES (gen_random_uuid()::text, 'Plan de prueba', $1, $2, $3, $4, $5, $6, $7, $8, now(), now())
     RETURNING id`,
    [
      opts.placeId,
      opts.creatorId,
      sqlDate(opts.startsAt ?? new Date(Date.now() + 86_400_000)),
      opts.endsAt ? sqlDate(opts.endsAt) : null,
      opts.capacity ?? 4,
      opts.acceptedCount ?? 0,
      opts.status ?? 'OPEN',
      opts.deleted ? sqlDate(new Date()) : null,
    ],
  )
  return { id: id.rows[0].id, startsAt: opts.startsAt ?? new Date(Date.now() + 86_400_000) }
}

/** Una fila de `PlanParticipant`, para no repetir el `create` en cada test. */
export async function joinPlan(opts: {
  planId: string
  userId: string
  status: string
  role?: string
}) {
  return getPrisma().planParticipant.create({
    data: {
      planId: opts.planId,
      userId: opts.userId,
      role: (opts.role ?? 'PARTICIPANT') as never,
      status: opts.status as never,
      joinedAt: new Date(),
    },
    select: { planId: true, userId: true, status: true },
  })
}

/** Lectura cruda, para poder afirmar sobre lo que quedo guardado de verdad. */
export async function rawQuery<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
  const res = await client.query(sql, params)
  return res.rows as T[]
}
