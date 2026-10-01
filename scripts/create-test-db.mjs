import { Client } from 'pg'

// Node pelado no carga .env solo. Prisma lo hace por su prisma.config.ts, pero
// este script no pasa por ahi. Se usa el loader nativo para que el mismo
// archivo funcione con `npm run test:db:setup` y con el DATABASE_URL del CI.
try {
  process.loadEnvFile('.env.test')
} catch {
  // si no esta, el chequeo de abajo avisa con un mensaje util
}

/**
 * Crea la base de test si no existe.
 *
 * `prisma migrate deploy` aplica migraciones pero NO crea la base, asi que
 * hace falta este paso antes. Se hace con `pg` a mano en vez de depender de
 * Prisma o de tener psql instalado, para que funcione igual en Windows, en el
 * contenedor y en CI.
 *
 * Solo hace CREATE, nunca DROP. La limpieza la hace el truncate de cada test
 * sobre una base que se llama `_test`, y `tests/helpers/db.ts` se niega a
 * truncar cualquier otra.
 */

const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL no esta definido. Se espera .env.test (o la variable en el entorno).')
  process.exit(1)
}

const dbName = new URL(url).pathname.replace(/^\//, '')
if (!dbName) {
  console.error('DATABASE_URL no tiene nombre de base de datos.')
  process.exit(1)
}

if (!dbName.endsWith('_test')) {
  console.error(
    `Se niega a trabajar sobre "${dbName}": el nombre de la base de test tiene que terminar en "_test".\n` +
      `Los tests hacen TRUNCATE. apuntar esto a una base de desarrollo le borraria los datos.`,
  )
  process.exit(1)
}

// Se conecta a `postgres` para poder Issuing CREATE DATABASE.
const adminUrl = new URL(url)
adminUrl.pathname = '/postgres'

const client = new Client({ connectionString: adminUrl.toString() })

try {
  await client.connect()
} catch (err) {
  console.error(`No se pudo conectar a Postgres para crear "${dbName}": ${err.message}`)
  console.error('Levantalo con: npm run db:up')
  process.exit(1)
}

const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName])

if (existing.rowCount === 0) {
  // CREATE DATABASE no puede ir dentro de una transaccion. pg lo manda como
  // query simple justamente por esto.
  await client.query(`CREATE DATABASE "${dbName}"`)
  console.log(`base de test creada: ${dbName}`)
} else {
  console.log(`base de test ya existe: ${dbName}`)
}

await client.end()

/**
 * Aplica las migraciones, con DATABASE_URL pasado de forma EXPLICITA.
 *
 * Esto no es cosmetico. Correr `prisma migrate deploy` a secas desde este
 * script usa `prisma.config.ts`, que carga `.env` -- o sea, la base de
 * DESARROLLO. Pasaba: la base `nexa_test` se creaba y el deploy reportaba
 * "No pending migrations to apply" mirando `nexa`, dejando la base de test sin
 * una sola tabla y sin ningun error visible.
 *
 * Un paso unico con el env explícito hace que el error sea imposible de
 * obtener por omision.
 */
const { spawnSync } = await import('node:child_process')
const prismaBin = new URL('../node_modules/prisma/build/index.js', import.meta.url).pathname.replace(
  /^\/([A-Za-z]:)/,
  '$1',
)

const migrate = spawnSync(
  process.execPath,
  [prismaBin, 'migrate', 'deploy'],
  {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'inherit',
    shell: false,
  },
)

if (migrate.status !== 0) {
  console.error('prisma migrate deploy fallo sobre la base de test.')
  process.exit(migrate.status ?? 1)
}
