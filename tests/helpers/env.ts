/**
 * Carga `.env.test` una sola vez para todos los helpers y archivos de test.
 *
 * Se hace aqui y no con `test.env` en `vitest.config.mts` porque ese camino
 * depende de que el loader del config corra y de que Vitest propague las
 * variables al worker. Cuando esa propagacion falla, el sintoma es un
 * `DATABASE_URL no esta definido` en un archivo de test, a kilometers de la
 * causa. Cargando desde el propio proceso del test, el fallo -- si hay --
 * aparece en el primer archivo y con el mensaje util.
 *
 * En CI, donde las variables vienen del entorno, esto es un no-op: lo que ya
 * esta definido gana y no se sobreescribe.
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

if (existsSync(resolve(process.cwd(), '.env.test'))) {
  process.loadEnvFile('.env.test')
}

export const BASE_URL = process.env.TEST_BASE_URL ?? `http://127.0.0.1:${process.env.TEST_PORT ?? '3100'}`
