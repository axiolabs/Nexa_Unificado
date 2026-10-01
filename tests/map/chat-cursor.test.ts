import { describe, expect, it } from 'vitest'
import {
  CHAT_PAGE_SIZE,
  ORDEN_CHAT,
  decodeCursor,
  encodeCursor,
  whereDespuesDe,
} from '../../lib/chat'

/**
 * El cursor del chat.
 *
 * Esta es la parte del chat donde un error NO se ve: si el cursor se come un
 * mensaje, la pantalla muestra una conversacion incompleta y nadie se entera.
 * Si devuelve de mas, la conversacion aparece duplicada, y eso se nota. El
 * peor caso es el primero, asi que los tests de aca apuntan a eso.
 *
 * Lo que se fija:
 *
 *   1. El par (createdAt, id) da un orden TOTAL. Con `createdAt` solo, dos
 *      mensajes del mismo milisegundo caen en el borde y uno de los dos
 *      finales posibles pierde una fila.
 *   2. Un cursor ilegible es un 400, no un "empezar de nuevo". Volver al
 *      principio en silencio reenvia el chat entero.
 *   3. El `where` descompuesto se comporta como una comparacion de tuplas.
 */

const t = (iso: string, id: string) => ({ createdAt: new Date(iso), id })

describe('encodeCursor / decodeCursor', () => {
  it('va y vuelve sin perder precision', () => {
    // Los milisegundos importan: si el ISO se trunca al segundo, dos mensajes
    // del mismo segundo se vuelven indistinguibles y el cursor miente.
    const c = t('2026-09-28T21:08:52.964Z', 'msg_abc')
    const vuelta = decodeCursor(encodeCursor(c))
    expect(vuelta).not.toBeNull()
    expect(vuelta!.createdAt.toISOString()).toBe('2026-09-28T21:08:52.964Z')
    expect(vuelta!.id).toBe('msg_abc')
  })

  it('es opaco: el id no aparece en claro', () => {
    // El cliente reusa el cursor, no lo arma. Que sea opaco es lo que permite
    // cambiar el formato mas adelante sin tocar el cliente.
    expect(encodeCursor(t('2026-09-28T21:08:52.964Z', 'msg_abc'))).not.toContain('msg_abc')
  })

  it('acepta un id con caracteres raros', () => {
    // Un id con `|` romperia el parseo por separador si se desarmara mal. Con
    // `indexOf` y no `split`, el corte es el primer `|` y el resto es el id.
    const c = t('2026-09-28T21:08:52.964Z', 'msg|con|barras')
    expect(decodeCursor(encodeCursor(c))!.id).toBe('msg|con|barras')
  })

  describe('lo que NO es un cursor', () => {
    it.each([
      ['string vacio', ''],
      ['basura', 'no-es-un-cursor'],
      ['sin separador', Buffer.from('2026-09-28T21:08:52.964Z', 'utf8').toString('base64url')],
      ['fecha invalida', Buffer.from('no-es-fecha|msg_1', 'utf8').toString('base64url')],
      ['id vacio', Buffer.from('2026-09-28T21:08:52.964Z|', 'utf8').toString('base64url')],
    ])('devuelve null con %s', (_caso, bruto) => {
      expect(decodeCursor(bruto)).toBeNull()
    })
  })
})

describe('whereDespuesDe', () => {
  const cursor = t('2026-09-28T21:08:52.964Z', 'msg_b')

  it('es un OR de dos ramas, no un AND', () => {
    // El bug caro: escribir las dos condiciones con AND. Seria
    // `createdAt > c AND createdAt = c`, que es siempre falso, y el chat
    // devolveria siempre vacio sin error en ningun lado.
    const where = whereDespuesDe('plan_1', cursor)
    expect(where.planId).toBe('plan_1')
    expect(Array.isArray(where.OR)).toBe(true)
    expect(where.OR).toHaveLength(2)
    expect('AND' in where).toBe(false)
  })

  it('la primera rama trae lo mas nuevo que el cursor', () => {
    const where = whereDespuesDe('plan_1', cursor)
    expect(where.OR[0]).toEqual({ createdAt: { gt: cursor.createdAt } })
  })

  it('la segunda rama trae el mismo instante con id mayor', () => {
    // Esta rama es la que impide perder el mensaje siguiente cuando cae en el
    // mismo milisegundo que el ultimo leido.
    const where = whereDespuesDe('plan_1', cursor)
    expect(where.OR[1]).toEqual({ createdAt: cursor.createdAt, id: { gt: 'msg_b' } })
  })

  it('el id se compara con `gt` y no con `gte`', () => {
    // Con `gte` el ultimo mensaje leido volveria en cada poll y la conversacion
    // se duplicaria sola.
    const where = whereDespuesDe('plan_1', cursor)
    expect((where.OR[1] as { id: { gt?: string; gte?: string } }).id.gt).toBe('msg_b')
    expect((where.OR[1] as { id: { gte?: string } }).id.gte).toBeUndefined()
  })
})

describe('ORDEN_CHAT', () => {
  it('ordena por createdAt y luego por id', () => {
    // El `id` va explicito aunque hoy casi nunca desempate: sin el, dos
    // mensajes del mismo milisegundo salen en el orden que quiera la base, y
    // ese orden puede cambiar entre dos llamadas identicas.
    expect(ORDEN_CHAT).toEqual([{ createdAt: 'asc' }, { id: 'asc' }])
  })
})

describe('CHAT_PAGE_SIZE', () => {
  it('es un numero acotado y razonable', () => {
    // No es un detalle: la pagina se trae entera al cliente, asi que el valor
    // define cuantos mensajes se pueden tener en memoria en una pestana.
    expect(CHAT_PAGE_SIZE).toBeGreaterThan(0)
    expect(CHAT_PAGE_SIZE).toBeLessThanOrEqual(500)
  })
})
