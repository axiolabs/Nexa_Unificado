import { describe, expect, it } from 'vitest'
import {
  agregarMensajes,
  avanzarCursor,
  type Mensaje,
} from '../../lib/chat'

/**
 * Las dos reglas que sostienen la pantalla de chat.
 *
 * No hay DOM en el harness, asi que la UI no se puede testear con clicks. Pero
 * los dos bugs que mas dano en un chat con polling no son de render: son de
 * estado, y los dos viven en funciones puras que salen de `lib/chat.ts`. Por eso
 * estan ahi y no adentro del `.tsx`.
 *
 * Los dos casos que se fijan:
 *
 *   1. Un mensaje que llega dos veces se muestra una sola.
 *   2. Un poll vacio NO borra el cursor.
 *
 * El segundo es el que mas caro sale: si el cursor se pierde, el proximo poll
 * reenvia el chat entero, y si la deduplicacion tambien falla, la conversacion
 * se duplica de punta a punta.
 */

function mensaje(id: string, createdAt: string, cuerpo = `cuerpo de ${id}`): Mensaje {
  return {
    id,
    body: cuerpo,
    createdAt,
    authorId: 'u1',
    authorName: 'Ana Ruiz',
    mine: true,
    deletedAt: null,
  }
}

const T0 = '2026-09-28T10:00:00.000Z'
const T1 = '2026-09-28T10:00:01.000Z'

describe('agregarMensajes', () => {
  it('une lo nuevo al final, en el orden en que llega', () => {
    const previos = [mensaje('a', T0)]
    const joined = agregarMensajes(previos, [mensaje('b', T1), mensaje('c', '2026-09-28T10:00:02.000Z')])
    expect(joined.map((m) => m.id)).toEqual(['a', 'b', 'c'])
  })

  it('no repite un mensaje que ya estaba', () => {
    // El caso real: mandaste un mensaje, el POST lo devuelve y lo agregas, y el
    // proximo poll lo vuelve a traer porque el cursor todavia esta antes. Es
    // NORMAL que pase, y si aparece dos veces en pantalla el chat parece roto.
    const previos = [mensaje('a', T0), mensaje('b', T1)]
    const joined = agregarMensajes(previos, [mensaje('b', T1)])
    expect(joined.map((m) => m.id)).toEqual(['a', 'b'])
  })

  it('deduplica solo lo repetido y deja pasar lo nuevo de la misma tanda', () => {
    // Un poll que se solapa con otro trae un rango que ya se leyo entero mas
    // someados de nuevos. Filtrar la tanda entera perderia los nuevos.
    const previos = [mensaje('a', T0)]
    const joined = agregarMensajes(previos, [mensaje('a', T0), mensaje('b', T1), mensaje('c', '2026-09-28T10:00:02.000Z')])
    expect(joined.map((m) => m.id)).toEqual(['a', 'b', 'c'])
  })

  it('deduplica por id y NO por fecha: dos mensajes del mismo milisegundo', () => {
    // Si comparara por `createdAt` creeria que el repetido es otro, porque
    // tecnicamente no hay dos mensajes con la misma fecha e id al mismo tiempo.
    const previos = [mensaje('a', T0)]
    const joined = agregarMensajes(previos, [mensaje('a', T0), mensaje('b', T0)])
    expect(joined.map((m) => m.id)).toEqual(['a', 'b'])
  })

  it('una tanda vacia devuelve el MISMO arreglo, para no re-renderizar', () => {
    // El poll cada 3 segundos devuelve vacio la mayor parte de las veces. Si
    // esto devolviera un arreglo nuevo, React re-renderizaria la pantalla cada 3
    // segundos aunque no haya pasado nada, y en un plan chico se nota: la lista
    // de mensajes "parpadea" sin motivo.
    const previos = [mensaje('a', T0)]
    expect(agregarMensajes(previos, [])).toBe(previos)
  })

  it('una tanda toda repetida tambien devuelve el mismo arreglo', () => {
    const previos = [mensaje('a', T0), mensaje('b', T1)]
    expect(agregarMensajes(previos, [mensaje('a', T0), mensaje('b', T1)])).toBe(previos)
  })

  it('no toca el arreglo previo', () => {
    const previos = [mensaje('a', T0)]
    agregarMensajes(previos, [mensaje('b', T1)])
    expect(previos.map((m) => m.id)).toEqual(['a'])
  })
})

describe('avanzarCursor', () => {
  it('avanza cuando el servidor manda cursor', () => {
    expect(avanzarCursor('viejo', 'nuevo')).toBe('nuevo')
  })

  it('un poll vacio NO borra el cursor que ya se tiene', () => {
    // El bug mas caro de la pantalla. `nextCursor` viene `null` cuando la
    // pagina vino vacia, y aceptar ese `null` reinicia la lectura desde el
    // principio: cada poll reenvia los 100 ultimos mensajes, cada 3 segundos,
    // para siempre. Con `??` en vez de `=`, el `null` del servidor no pisa el
    // cursor que ya anda avanzando.
    expect(avanzarCursor('ya-estoy-aki', null)).toBe('ya-estoy-aki')
  })

  it('sin cursor previo, un poll vacio deja el cursor en null', () => {
    // El caso inverso: si nunca se leyo nada, no hay cursor que preservar, y
    // inventar uno dejaria al cliente pidiendo `?after=undefined`.
    expect(avanzarCursor(null, null)).toBeNull()
  })

  it('tampoco avanza si el servidor manda cadena vacia', () => {
    // El endpoint trata `after=` vacio como "sin cursor" y devuelve todo desde
    // el principio. Si el cliente lo aceptara, reenviaria la conversacion
    // entera creyendo que avanza.
    expect(avanzarCursor('actual', '')).toBe('actual')
    expect(avanzarCursor(null, '')).toBeNull()
  })
})
