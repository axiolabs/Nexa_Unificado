import type { Prisma } from '@prisma/client'

/**
 * Errores de Prisma/Postgres que describen INFRAESTRUCTURA, no logica de negocio.
 *
 * El motivo de existir: estos codigos significan "volvela a intentar" y en
 * ningun caso "el lugar no existe" ni "ya participas de este plan". Un `catch`
 * que no los distingue responde con un mensaje de negocio a un problema de
 * infraestructura, y el efecto practico es doble:
 *
 *   1. El usuario ve "el lugar no existe" cuando la base esta caida, y no
 *      reintenta. Peor todavia: la app queda pareciendo sana.
 *   2. En el log, un P1001 disfrazado de 404 no dispara ninguna alerta, asi
 *      que nadie se entera de que la base esta caida hasta que alguien llama
 *      por soporte.
 *
 * La separacion de responsabilidades: aca viven SOLO los codigos que son
 * reintentables o de conexion. Los de constraint (P2002 unique, P2003 FK) los
 * traduce cada route, porque el mensaje depende de que se este haciendo (una
 * fila duplicada en `PlanParticipant` no es lo mismo que un lugar que no existe).
 *
 * Ver la seccion 12 de `docs/decisiones-auth.md`.
 */
const RETRYABLE: ReadonlySet<string> = new Set([
  // Deadlock o conflicto de serializacion. La transaccion se aborta, pero la
  // operacion es segura de reintentar: la perdi el lock, no la escribi.
  'P2034',
  // Timeout de la transaccion. Mismo caso: se aborta, se reintenta.
  'P2028',
  // La base no esta alcanzable. Prisma las agrupa bajo "PrismaClientInitializationError".
  'P1001',
  'P1002',
  'P1008',
  'P1017',
])

/** `true` si el error es de conexion o de conflicto transaccional. */
export function isRetryableDbError(err: unknown): err is Prisma.PrismaClientKnownRequestError {
  return err instanceof Error && RETRYABLE.has((err as { code?: string }).code ?? '')
}
