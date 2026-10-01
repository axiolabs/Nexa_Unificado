/**
 * Marcar asistencia: quien se puede marcar y como se cuenta lo que falta.
 *
 * Puro, sin Prisma ni Next, como `lib/chat.ts` y `lib/ratings.ts`. La lista de
 * marcables la usan **el endpoint y la pantalla**, y por la misma razon que el
 * gate del chat: si cada uno tiene la suya, un estado nuevo entra por un lado y
 * no por el otro, y aparece la combinacion que no tiene que existir — un boton
 * que el POST rechaza, o peor, un `REQUESTED` que se puede marcar como
 * "asistio" a un plan al que nunca estuvo.
 */

import type { ParticipationStatus } from '@prisma/client'

/**
 * Desde que estado tiene sentido decir "estuvo" o "no vino".
 *
 * `ACCEPTED` es el caso de siempre: el plan termino y hay que decir de cada uno
 * si vino. Los otros dos son la correccion, porque una lista de asistencia se
 * arma a ojo.
 *
 * **`ACCEPTED` no es una salida.** Volver ahi seria decir "no se", que el schema
 * no tiene como representar, y ademas sacaria a la persona del numerador **y**
 * del denominador de la reliability de un plumazo: un `NO_SHOW` corregido a
 * "no se" desapareceria por completo del historial, en vez de quedar registrado
 * como lo que fue. Entre `ATTENDED` y `NO_SHOW` se corrige libre; hacia atras,
 * no.
 *
 * `REQUESTED`, `DECLINED` y `CANCELLED` quedan afuera: los tres pueden ser
 * marcados igual y el resultado seria un dato falso.
 */
export const MARCABLES = ['ACCEPTED', 'ATTENDED', 'NO_SHOW'] as const

export type Marcable = (typeof MARCABLES)[number]

/** El predicado, con el mismo `as` que el endpoint: el enum tiene seis valores. */
export function puedeMarcar(status: ParticipationStatus | null | undefined): boolean {
  return status != null && (MARCABLES as readonly string[]).includes(status)
}

/**
 * Que falta para terminar la lista.
 *
 * El organizador necesita saber si ya termino, y el "¿listo?" no puede ser
 * "todos tienen un boton prendido", porque los `ATTENDED` y los `NO_SHOW` ya
 * estan resueltos y siguen teniendo boton (para corregir). Lo que falta son los
 * que siguen en `ACCEPTED`.
 */
export function resumenAsistencia(
  participantes: { status: ParticipationStatus | null }[],
): { total: number; asistio: number; noShow: number; sinMarcar: number; completo: boolean } {
  let asistio = 0
  let noShow = 0
  let sinMarcar = 0
  for (const p of participantes) {
    if (p.status === 'ATTENDED') asistio += 1
    else if (p.status === 'NO_SHOW') noShow += 1
    else sinMarcar += 1
  }
  return { total: participantes.length, asistio, noShow, sinMarcar, completo: sinMarcar === 0 }
}
