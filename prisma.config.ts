import { defineConfig, env } from 'prisma/config'

// Prisma 7 no auto-carga .env a diferencia de Prisma 5/6, y este archivo se
// evalua antes de que cualquier comando corra. Node >= 20.6 tiene
// process.loadEnvFile() nativo, asi que no hace falta dotenv-cli.
//
// Se llama explicitamente antes de defineConfig porque env() se resuelve al
// importar el modulo: si se hiciera despues, la variable todavia no existiria.
if (!process.env.DATABASE_URL) {
  try {
    process.loadEnvFile()
  } catch {
    // No hay .env. Se deja pasar el error de Prisma, que es mas util que
    // enmascararlo con una URL inventada.
  }
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: env('DATABASE_URL') },
})
