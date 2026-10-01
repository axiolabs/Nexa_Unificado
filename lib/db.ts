import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'

/**
 * Prisma 7 exige un driver adapter: `new PrismaClient()` sin adapter ya no es
 * valido. El adapter de Postgres es `pg` a traves de `@prisma/adapter-pg`.
 *
 * Se construye por factory y se cachea en globalThis, no como constante de
 * modulo a proposito. Razon: `middleware.ts` corre en un runtime separado del
 * de los route handlers, y cada uno necesita su propia instancia. Con el
 * singleton de modulo, el primer request de cada runtime paga la conexion y el
 * hot-reload de `next dev` acumularia pools hasta agotar max_connections.
 */
function createPrismaClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    throw new Error('DATABASE_URL no esta definido')
  }
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
  })
}

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

export function getPrisma(): PrismaClient {
  globalForPrisma.prisma ??= createPrismaClient()
  return globalForPrisma.prisma
}
