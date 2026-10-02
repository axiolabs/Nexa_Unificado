/**
 * Denuncias: que se puede denunciar, con que motivos, y cuando NO se puede.
 *
 * Puro y en `lib/`, por la misma razon que `personality-reminder.ts`,
 * `plan-join.ts` y `home-nav.ts`: lo que se decide sin DOM se decide aca y se
 * testea. El endpoint y el componente solo preguntan.
 *
 * Y antes que nada, lo que este modulo NO hace: no suspende a nadie, no cancela
 * planes, no saca lugares de circulacion. Una denuncia es una fila en una cola.
 * Quien la resuelve usa las herramientas que ya existen
 * (`Place.verificationStatus`, `User.isActive`, `PlanParticipant.status`). Que
 * este archivo no ofrezca una funcion tipo `aplicarSancion()` no es oversight:
 * §12 de `docs/decisiones-auth.md` ya decidio "intervencion humana, no
 * cancelacion automatica" porque un plan es una promesa con hora y lugar adentro,
 * y sin canal de notificacion un cancel automatico deja a gente que se presento
 * apuntando a algo que ya no existe.
 */

import type { ReportReason, ReportStatus, ReportTarget } from '@prisma/client'

/**
 * Los motivos, y cuales tiene sentido para cada tipo de objetivo.
 *
 * Un solo enum plano y no uno por tipo, por dos razones. La primera es que el
 * enum en la base no cambia si manana se agrega un motivo: agregar un valor a un
 * enum de Postgres usado por un solo tipo obliga a una migracion con ALTER, y
 * esto se va a usar mas de una vez. La segunda es que los subconjuntos son
 * datos, no logica: son una tabla, y una tabla se puede testear entera.
 *
 * Que `PLACE` no ofrezca `NO_SHOW_RISK` no es un detalle: "no se presentó" es un
 * hecho de una persona en un plan, no de un cafe. Y que `USER` no ofrezca
 * `CLOSED` es lo mismo al reves. Un motivo que no aplica es ruido que hace que
 * la gente elija mal.
 */
export const MOTIVOS_POR_OBJETIVO: Record<ReportTarget, readonly ReportReason[]> = {
  PLACE: ['CLOSED', 'WRONG_INFO', 'UNSAFE', 'OFF_TOPIC', 'OTHER'],
  PLAN: ['MISLEADING', 'UNSAFE', 'NO_SHOW_RISK', 'WRONG_INFO', 'OTHER'],
  USER: ['HARASSMENT', 'SPAM', 'IMPERSONATION', 'UNSAFE', 'OTHER'],
  MESSAGE: ['HARASSMENT', 'SPAM', 'OFF_TOPIC', 'OTHER'],
}

/** Los motivos que se ofrecen para un objetivo. */
export function motivosPara(target: ReportTarget): readonly ReportReason[] {
  return MOTIVOS_POR_OBJETIVO[target] ?? []
}

/** Un motivo es valido para el objetivo que se esta denunciando. */
export function motivoValido(target: ReportTarget, reason: string): reason is ReportReason {
  return (MOTIVOS_POR_OBJETIVO[target] ?? []).includes(reason as ReportReason)
}

/** Texto para la persona. Nunca el nombre del enum: "OTHER" no le dice nada. */
export const MOTIVO_LABELS: Record<ReportReason, string> = {
  CLOSED: 'No existe mas o esta cerrado',
  WRONG_INFO: 'Los datos estan mal',
  UNSAFE: 'No me siento seguro ahi',
  NO_SHOW_RISK: 'Gente que no avisa si va',
  MISLEADING: 'La informacion no es real',
  HARASSMENT: 'Me esta molestando',
  SPAM: 'Spam o publicidad',
  IMPERSONATION: 'Se hace pasar por otra persona',
  OFF_TOPIC: 'No va con Nexa',
  OTHER: 'Otra cosa',
}

/** Que se puede denunciar, y como se llama en voz humana. */
export const OBJETIVO_LABELS: Record<ReportTarget, string> = {
  PLACE: 'lugar',
  PLAN: 'plan',
  USER: 'persona',
  MESSAGE: 'mensaje',
}

/** Los estados terminales y lo que significan. */
export const STATUS_LABELS: Record<ReportStatus, string> = {
  OPEN: 'Sin revisar',
  RESOLVED: 'Resuelto',
  DISMISSED: 'Revisado y estaba bien',
}

/**
 * Si se puede denunciar esto.
 *
 * Devuelve el motivo por el que no, o `null` si se puede. Devolver la razon y no
 * un `boolean` es a proposito: el endpoint la necesita para el 403 y para no
 * filtrar informacion ("ya lo denunciaste" y "no te puedes denunciar a vos" son
 * respuestas distintas, y la UI puede tratar la primera como algo ya hecho en vez
 * de como un error).
 *
 * Las reglas, y por que estan en este orden:
 *
 * - Se necesita sesion. Una anonymously no se puede: sin `reporterId` el
 *   `ON DELETE CASCADE` de `User` no tiene de que borrar y el reporte queda
 *   huerfano sin autor conocido.
 * - No uno mismo. Denunciarse a si mismo no es un error de la persona, es ruido
 *   que el equipo tiene que leer. Para `PLAN` y `MESSAGE` esto se extiende al
 *   organizador y al autor respectivamente, no solo a la propia cuenta: es el
 *   caso mas comun, y por eso los ids llegan aparte en `relacionados`.
 * - `OTHER` sin detalle no alcanza. Un "otra cosa" en blanco no le dice nada a
 *   quien tiene que resolverlo, y el equipo lo va a descartar. Se pide detalle
 *   solo en ese motivo, para no frenar a quien ya eligio una opcion util.
 */
export const SIN_SESION = 'SIN_SESION' as const
export const AUTORREPORTE = 'AUTORREPORTE' as const
export const MOTIVO_INVALIDO = 'MOTIVO_INVALIDO' as const
export const DETALLE_REQUERIDO = 'DETALLE_REQUERIDO' as const

export type MotivoRechazo =
  | typeof SIN_SESION
  | typeof AUTORREPORTE
  | typeof MOTIVO_INVALIDO
  | typeof DETALLE_REQUERIDO

export function puedeReportar(args: {
  target: ReportTarget
  reason: string
  detail?: string | null
  reporterId: string | null
  /** La id del objetivo. Se compara con los ids de quien lo creo. */
  targetId: string
  /** Ids de gente ligada al objetivo: organizador del plan, autor del mensaje. */
  relacionados?: readonly string[]
}): MotivoRechazo | null {
  if (!args.reporterId) return 'SIN_SESION'

  // El objetivo tiene que ser alguien distinto. Se comparan TODOS los ids
  // relacionados, no solo el del objetivo: el caso real es que alguien denuncie
  // el plan que organizo, o el mensaje que escribio, y si solo se comparara el
  // `targetId` del plan contra el reporter pasaria limpio.
  if (args.reporterId === args.targetId) return 'AUTORREPORTE'
  for (const id of args.relacionados ?? []) {
    if (id === args.reporterId) return 'AUTORREPORTE'
  }

  if (!motivoValido(args.target, args.reason)) return 'MOTIVO_INVALIDO'

  // El detalle solo es obligatorio para `OTHER`, y "sin detalle" es `undefined`,
  // `null` y cadena vacia: el endpoint puede pasar cualquiera de los tres y un
  // `if (!detail)` sobre `undefined` no es lo mismo que un `.trim()` sobre `''`.
  if (args.reason === 'OTHER') {
    const d = (args.detail ?? '').trim()
    if (d.length === 0) return 'DETALLE_REQUERIDO'
  }

  return null
}

/** Que le contesta el endpoint a la persona cuando no se puede denunciar. */
export const RECHAZO_MENSAJES: Record<MotivoRechazo, string> = {
  SIN_SESION: 'Tenes que entrar con tu cuenta para denunciar.',
  AUTORREPORTE: 'No podes denunciar esto vos.',
  MOTIVO_INVALIDO: 'Elegi otro motivo.',
  DETALLE_REQUERIDO: 'Contanos que pasa, aunque sea una linea.',
}
