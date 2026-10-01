import type { Alineacion } from './alignment'
import type { Reliability } from './reliability'

/**
 * Tipos y texto de la pantalla de solicitudes del organizador.
 *
 * Misma regla que `lib/plans.ts` y `lib/personality.ts`: la forma de la
 * respuesta vive aca y el route handler la cumple, no al reves. Si el endpoint
 * agrega un campo, este archivo deja de compilar; si el endpoint lo saca, tambien.
 */

export type SolicitudPendiente = {
  userId: string
  name: string
  joinedAt: string
  expiresAt: string | null
  hoursLeft: number
  reliability: Reliability | null
  alineacion: Alineacion | null
}

export type PlanSolicitudes = {
  plan: {
    id: string
    title: string
    startsAt: string
    capacity: number
    acceptedCount: number
    remainingSpots: number
    status: string
  }
  requests: SolicitudPendiente[]
  resolved: { accepted: number; declined: number }
}

/**
 * Un plan propio, para el selector de la pantalla de solicitudes.
 *
 * `pendingCount` viene en la consulta y no se cuenta en el cliente: son N planes
 * y el navegador los pediria de a uno, o peor, los traeria todos y contaria en
 * JS. El conteo en SQL es el unico que no puede desfasarse del filtro de
 * expiracion de `/requests`.
 */
export type HostPlanSummary = {
  id: string
  title: string
  placeName: string
  startsAt: string
  capacity: number
  acceptedCount: number
  status: string
  pendingCount: number
}

/**
 * Como se muestra la alineacion de un postulante.
 *
 * El `null` NO se muestra como 0%. Son dos verdades distintas: "sus rasgos no
 * encajan con este lugar" y "no hay nada comparable todavia" (no hizo el test,
 * o el lugar no tiene rasgos cargados). Un `0%` de relleno convertiria la
 * segunda en la primera, y el organizador rechazaria a alguien por un dato que
 * nunca se midio.
 *
 * El numero va como porcentaje porque `normalizado` ya es un promedio ponderado
 * entre -1 y 1 (los puntajes de rasgos van de -1 a 1, y los pesos del lugar
 * reparten la masa). O sea: 100% es "encaja con el perfil del lugar", 0% es "le
 * da lo mismo", y negativo es "le va en contra".
 *
 * Sin etiqueta cualitativa ("alta", "baja", "buen match"). El peso del lugar lo
 * define la curacion y no hay una escala acordada para despues; un "buen match"
 * derivado de un promedio inventado seria exactamente el tipo de numero que el
 * resto del proyecto evita.
 */
export function describirAlineacion(a: Alineacion | null): string {
  if (a === null) return 'Sin comparar: no hay datos de los dos lados'
  const pct = Math.round(a.normalizado * 100)
  const rasgos = a.traits === 1 ? '1 rasgo' : `${a.traits} rasgos`
  return `${pct}% sobre ${rasgos} del lugar`
}

/**
 * Como se muestra la reliability de un postulante.
 *
 * Sin historial es `null` y se dice "sin historial", no 0%: la misma
 * distincion que en la alineacion. Con historial se muestra el conteo crudo y
 * no solo el porcentaje, porque "1 de 1" y "8 de 8" dan el mismo 100% y significan
 * cosas muy distintas como evidencia.
 */
export function describirReliability(r: Reliability | null): string {
  if (r === null) return 'Sin historial'
  if (r.attended === 0 && r.noShow === 0) return 'Sin historial'
  const total = r.attended + r.noShow
  const pct = r.showUpRate === null ? '-' : `${Math.round(r.showUpRate * 100)}%`
  return `${pct} (${r.attended} de ${total} asistio)`
}
