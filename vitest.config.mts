import { defineConfig } from 'vitest/config'

// Se carga .env.test en el proceso principal de Vitest. Si no esta, se sigue
// adelante: la falla util viene de los helpers, que dicen que falta la base,
// en vez de un error de modulo ilegible.
try {
  process.loadEnvFile('.env.test')
} catch {
  // sin .env.test todavia
}

const PORT = process.env.TEST_PORT ?? '3100'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],

    /**
     * Un archivo a la vez, y un solo worker.
     *
     * Todos los tests comparten la misma base `_test` y hacen TRUNCATE entre
     * casos. Con archivos en paralelo, el truncate de un archivo puede pisar el
     * usuario que otro acaba de crear, y los fallos serian intermitentes y
     * sin causa aparente. Preferimos la suite completa en serie a un suite
     * que miente.
     *
     * (`fileParallelism` y `maxWorkers` van top-level: Vitest 5 movio
     * `poolOptions` por completo.)
     */
    fileParallelism: false,
    maxWorkers: 1,
    pool: 'forks',

    globalSetup: ['./tests/setup/server.ts'],

    // argon2 a 64 MiB por hash y la app arrancando en frio: los defaults de
    // Vitest (5 s) se quedan cortos.
    testTimeout: 30_000,
    hookTimeout: 90_000,

    env: {
      DATABASE_URL: process.env.DATABASE_URL ?? '',
      SESSION_SECRET: process.env.SESSION_SECRET ?? '',
      SESSION_VERSION: process.env.SESSION_VERSION ?? '1',
      APP_ORIGIN: process.env.APP_ORIGIN ?? `http://127.0.0.1:${PORT}`,
      TEST_PORT: PORT,
      TEST_BASE_URL: `http://127.0.0.1:${PORT}`,
    },
  },
})
