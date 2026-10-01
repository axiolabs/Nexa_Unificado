import { describe, expect, it } from 'vitest'
import { Prisma } from '@prisma/client'
import { isRetryableDbError } from '../../lib/prisma-errors'

/**
 * Estos tests son unitarios a proposito: los errores que hay que clasificar NO se
 * pueden provocar desde HTTP. Un P1001 (base caida) o un P2034 (deadlock) se
 * Provocan en produccion, y probarlos de verdad implica cortar la base o dos
 * transacciones peleandose por el mismo lock. Construir el error de Prisma a mano
 * y pasarlo por la funcion es lo unico que verifica la CLASIFICACION, que es
 * justamente la parte que se puede equivocar.
 *
 * Lo que no cubren, y por eso hay que decirlo: que cada route la use. Eso lo
 * sostienen los tests de `plans-api.test.ts` para los casos que se pueden
 * provocar, y revision para el resto.
 */

/** Construye un `PrismaClientKnownRequestError` real con el codigo dado. */
function prismaError(code: string, message = 'boom') {
  return new Prisma.PrismaClientKnownRequestError(message, { code, clientVersion: 'test' })
}

describe('isRetryableDbError', () => {
  it('trata un deadlock (P2034) como reintentable', () => {
    expect(isRetryableDbError(prismaError('P2034'))).toBe(true)
  })

  it('trata un timeout de transaccion (P2028) como reintentable', () => {
    expect(isRetryableDbError(prismaError('P2028'))).toBe(true)
  })

  it('trata la base inalcanzable (P1001) como reintentable, no como "no existe"', () => {
    // El caso que motiva la funcion: sin esto, una base caida produce
    // "El lugar no existe" en toda la app y nadie se entera.
    expect(isRetryableDbError(prismaError('P1001'))).toBe(true)
    for (const code of ['P1002', 'P1008', 'P1017']) {
      expect(isRetryableDbError(prismaError(code)), code).toBe(true)
    }
  })

  it('NO trata como reintentable un error de constraint: son de negocio', () => {
    // P2002 y P2003 los traduce cada route con su propio mensaje. Marcarlo
    // aca como reintentable seria un bug: "ya participas de este plan" no se
    // arregla reintentando.
    for (const code of ['P2002', 'P2003', 'P2025']) {
      expect(isRetryableDbError(prismaError(code)), code).toBe(false)
    }
  })

  it('un codigo desconocido NO se marca como reintentable', () => {
    // Ante la duda, propagar. Un 503 por un error de logica le dice al cliente
    // que reintente algo que va a fallar igual, y en el log tapa la causa real.
    expect(isRetryableDbError(prismaError('P9999'))).toBe(false)
  })

  it('un error que no es de Prisma no se clasifica', () => {
    expect(isRetryableDbError(new Error('boom'))).toBe(false)
    expect(isRetryableDbError(new TypeError('undefined is not a function'))).toBe(false)
  })

  it('no explota con cualquier cosa: undefined, null, un string, un objeto', () => {
    // Este `catch` esta en el camino de TODAS las requests, asi que un
    // `err.code` sobre algo que no es error no puede convertirse en un
    // TypeError que tape el error original.
    for (const cosa of [undefined, null, 'texto', 42, {}, [], Symbol('x')]) {
      expect(isRetryableDbError(cosa), String(cosa)).toBe(false)
    }
  })

  it('un objeto con `code` pero que no es error tampoco se clasifica', () => {
    // El `instanceof Error` no es decorativo: un response de API o un objeto
    // plano con un `code`colgado tiene `code: "P1001"` y no es un error de
    // Prisma. Sin el chequeo, se reportaria como caida de base.
    expect(isRetryableDbError({ code: 'P1001' })).toBe(false)
  })
})
