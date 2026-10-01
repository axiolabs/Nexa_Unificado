import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { Readable } from 'node:stream'

// El globalSetup corre antes que cualquier test file, asi que es el primer
// lugar donde tiene que estar disponible el entorno.
if (existsSync(resolve(process.cwd(), '.env.test'))) {
  process.loadEnvFile('.env.test')
}

/**
 * Levanta la app de produccion real para los tests y la baja al terminar.
 *
 * Por que HTTP y no llamadas directas a los route handlers: el objeto bajo
 * prueba es el MIDDLEWARE. Si se importara `middleware()` y se lo llamara con
 * un `NextRequest` a mano, el test pasaria aunque el matcher de `config` no
 * cubriera la ruta, o aunque la ruta no existiera. El unico modo de comprobar
 * "un usuario sin rol recibe 403 en /admin" es preguntarle a /admin.
 *
 * Se usa `next start` y no `next dev`: sin recompilacion por request, y es el
 * camino de produccion, middleware incluido.
 */

const PORT = process.env.TEST_PORT ?? '3100'
const BASE = process.env.TEST_BASE_URL ?? `http://127.0.0.1:${PORT}`

let server: ChildProcessByStdio<null, Readable, Readable> | null = null

function required(name: string): string {
  const v = process.env[name]
  if (!v) {
    throw new Error(
      `${name} no esta definido. Copia .env.test.example a .env.test y completalo, ` +
        `o corré primero: npm run test:db:setup`,
    )
  }
  return v
}

async function waitForHttp(url: string, what: string, attempts: number) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) })
      if (res.status > 0) return
    } catch {
      // todavia no levanta
    }
    await sleep(1000)
  }
  throw new Error(`${what} no respondio en ${attempts}s. URL: ${url}`)
}

export async function setup() {
  required('DATABASE_URL')
  required('SESSION_SECRET')

  const url = new URL(required('DATABASE_URL'))
  const dbName = url.pathname.replace(/^\//, '')
  if (!dbName.endsWith('_test')) {
    throw new Error(
      `Los tests no corren contra "${dbName}": la base tiene que terminar en "_test".`,
    )
  }

  console.log(`[test] base: ${dbName}, puerto: ${PORT}`)

  // `next start` sin binario .cmd, para que funcione igual en Windows.
  // Se resuelve desde cwd (raiz del proyecto) y no con aritmetica de import.meta.url,
  // que desde tests/setup/ terminaba en tests/node_modules.
  const nextBin = resolve(process.cwd(), 'node_modules', 'next', 'dist', 'bin', 'next')

  // Con `stdio: ['ignore', ...]` el hijo no es ChildProcessWithoutNullStreams
  // (su stdin es null, no Writable), asi que el tipo correcto es este.
  server = spawn(process.execPath, [nextBin, 'start', '-p', PORT], {
    env: { ...process.env, NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as unknown as ChildProcessByStdio<null, Readable, Readable>

  const log: string[] = []
  server.stdout.on('data', (d: Buffer) => log.push(d.toString()))
  server.stderr.on('data', (d: Buffer) => log.push(d.toString()))

  server.on('exit', (code: number | null) => {
    if (code !== 0 && code !== null) {
      console.error(`\n[test] el server de Next murio con codigo ${code}:\n${log.join('')}`)
    }
  })

  try {
    await waitForHttp(BASE + '/', 'el server de Next', 60)
  } catch (err) {
    console.error(`\n[test] salida del server:\n${log.join('')}`)
    throw err
  }

  console.log(`[test] app escuchando en ${BASE}`)
}

export async function teardown() {
  if (!server) return
  server.kill('SIGTERM')
  // Le da margen a que Next cierre antes de que muera el proceso de Vitest.
  await sleep(500)
  if (!server.killed) server.kill('SIGKILL')
  server = null
}
