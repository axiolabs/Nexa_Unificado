/**
 * Que muestra el boton de unirse, y por que.
 *
 * Vive en `lib/` y no dentro del Client Component a proposito: la decision es
 * pura -- entra el estado del plan y del viewer, sale un tipo de decision -- y
 * una decision pura se testea sin DOM. Adentro del componente solo se puede
 * probar leyendolo, que es como se escaparon los bugs de este tipo la primera
 * vez.
 *
 * Que quede claro que esto NO cubre: que el click llegue al `fetch`. El
 * `onClick` y el `POST` quedan sin test, y no hay forma de testearlos sin
 * navegador. Ver la deuda en `docs/decisiones-auth.md` §13.8.
 */
import type { PlanStatusValue } from './plans'

export type DecisionUnirse =
  /** No hay nada que pedir. Se muestra un texto y listo. */
  | { tipo: 'informativo'; texto: string; tono: TonoMensaje | 'note' }
  /** Hay algo que pedir: el boton. `nota` es la aclaracion de abajo. */
  | { tipo: 'solicitar'; etiqueta: string; nota: string | null }

export type EntradaDecision = {
  status: PlanStatusValue
  startsAt: string
  creatorName: string
  isCreator: boolean
}

/**
 * El orden de estas reglas ES la especificacion, y no es arbitrario.
 *
 * Se prueba de adentro hacia afuera: primero lo que no se puede cambiar (soy el
 * organizador, ya estoy confirmado), despues lo que paso (me rechazaron, me
 * di de baja), y al final lo que depende del plan (ya empezo, se completo).
 *
 * La consecuencia de ordenarlos asi: un `CANCELLED` en un plan que YA EMPEZO ve
 * "este plan ya empezo" y no "pedir de nuevo". Es lo correcto -- volver a pedir
 * entrada a algo que arranco no tiene sentido --, pero sale del orden, no de una
 * regla explicita, asi que esta escrito aca para que el proximo que lo lea no lo
 * "simplifique" y ofrezca un boton que el endpoint va a rechazar con 409.
 */
export function decidirUnirse(
  plan: EntradaDecision,
  participacion: { status: string } | null,
  ahora: Date = new Date(),
): DecisionUnirse {
  const yaEsta = participacion?.status ?? null

  if (plan.isCreator) {
    return { tipo: 'informativo', tono: 'note', texto: 'Lo organizas vos. No hay nada que pedir.' }
  }

  if (yaEsta === 'ACCEPTED' || yaEsta === 'ATTENDED') {
    return { tipo: 'informativo', tono: 'ok', texto: 'Estas confirmado. Tenes lugar.' }
  }

  if (yaEsta === 'REQUESTED') {
    return {
      tipo: 'informativo',
      // Neutro, y no `ok` como estaba: pedir no es Confirmation. En verde esta
      // pantalla le dice al usuario que ya entro, que es exactamente la mentira
      // que el texto del boton ("Pedir no es entrar") intenta evitar.
      tono: 'neutro',
      texto: 'Pediste unirte. Esperando que el organizador responda.',
    }
  }

  if (yaEsta === 'DECLINED') {
    return {
      tipo: 'informativo',
      tono: 'note',
      texto: 'El organizador no acepto tu peticion para este plan.',
    }
  }

  if (yaEsta === 'NO_SHOW') {
    return {
      tipo: 'informativo',
      tono: 'note',
      texto: 'Fuiste anotado. El organizador ve el detalle en su pantalla.',
    }
  }

  if (plan.status !== 'OPEN') {
    return { tipo: 'informativo', tono: 'note', texto: 'Este plan ya no acepta participantes.' }
  }

  if (new Date(plan.startsAt).getTime() <= ahora.getTime()) {
    return { tipo: 'informativo', tono: 'note', texto: 'Este plan ya empezo.' }
  }

  if (yaEsta === 'CANCELLED') {
    return {
      tipo: 'solicitar',
      etiqueta: 'Pedir de nuevo',
      nota: 'Te habias dado de baja. Si queres volver, pedi de nuevo.',
    }
  }

  return {
    tipo: 'solicitar',
    etiqueta: 'Pedir unirme',
    // El texto que mas importa de la pantalla: pedir NO es entrar, y el que
    // organiza tiene que aprobar. Sin esta linea, "unirme" se lee como
    // reservar.
    nota: `Pedir no es entrar. Queda esperando a que ${plan.creatorName} lo vea y lo acepte.`,
  }
}

/**
 * Que tono lleva un mensaje en pantalla.
 *
 * `neutro` existe para lo que NO es un fallo: pedir y esperar, que te hayan
 * rechazado, haber estado. La audiencia tiene ansiedad social y el rechazo es
 * privado por diseno, asi que un `DECLINED` pintado con el rojo de un fallo de
 * redaria al usuario de que rompio algo. Un error de verdad (no se pudo
 * guardar, se cayo la conexion) sigue siendo el unico caso con rojo.
 */
export type TonoMensaje = 'ok' | 'neutro' | 'error'

/**
 * Que dice un 409 que trae estado, y con que tono se muestra.
 *
 * El 409 con `status` no es un error: es el endpoint diciendo "ya estas en este
 * estado". El texto sale del estado y no al azar, porque "no se pudo unir" y
 * "el organizador no te acepto" son cosas que el usuario tiene que poder
 * distinguir.
 *
 * `Record<string, ...>` y no un union estricto a proposito: la clave viene
 * del servidor, y un estado nuevo tiene que mostrar un texto y no un
 * `undefined` en pantalla. Para estado desconocido, el que llama usa el `error`
 * del body.
 */
export const MENSAJES_POR_ESTADO: Record<string, { texto: string; tono: TonoMensaje }> = {
  // Pedir no es un error ni un exito: es una espera. Verde ("ya estas") seria
  // mentir, y rojo seria alarma.
  //
  // El orden de la oracion importa mas que la palabra "error". Decir "tiene
  // hasta 24 horas" primero pone el reloj como protagonista, y eso invita a
  // calcular y a esperar ansioso. Ademas el texto NO promete aviso: hoy no
  // hay notificaciones push, asi que decir "te avisamos" seria hacer creer que
  // va a llegar algo y, cuando nadie avise, generar mas ansiedad que el
  // silencio. Lo que si es cierto es que puede volver cuando quiera.
  REQUESTED: {
    texto: 'Pediste unirte. Podes volver a revisar cuando quieras: el organizador tiene como maximo 24 horas para responder.',
    tono: 'neutro',
  },
  ACCEPTED: { texto: 'Ya estas confirmado.', tono: 'ok' },
  // "Ya estuviste" es un hecho, no un problema.
  ATTENDED: { texto: 'Ya estuviste en este plan.', tono: 'neutro' },
  // El rechazo es privado y definitivo. Neutro, nunca rojo.
  DECLINED: { texto: 'El organizador no acepto tu peticion.', tono: 'neutro' },
  CANCELLED: { texto: 'Te habias dado de baja de este plan.', tono: 'neutro' },
  NO_SHOW: { texto: 'El organizador ve el detalle de tu asistencia.', tono: 'neutro' },
}
