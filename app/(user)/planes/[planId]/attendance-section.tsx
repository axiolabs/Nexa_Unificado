'use client'

import { useState } from 'react'
import { resumenAsistencia } from '@/lib/attendance'
import type { PlanDetail } from '@/lib/plans'

/**
 * La lista de asistencia, solo del organizador y solo con el plan terminado.
 *
 * **No escribe el estado antes de que el servidor responda.** El endpoint
 * devuelve el estado que quedo (`{ userId, status, cambio }`) y recien ahi se
 * recarga el plan. Con una escritura optimista, un doble clic rapido deja el
 * boton en un estado que el server nunca confirmo, y la unica forma de saber
 * cual de los dos gano es recargar. Es el mismo criterio del chat: el servidor es
 * la verdad y la pantalla la copia.
 *
 * El estado no se parchea en esta pantalla sino recargando el `GET`, porque el
 * `GET` decide que se publica segun quien mira: un parche local podria dejar
 * visible una fila que para otro viewer tiene que estar filtrada. La recarga es
 * en silencio, asi que la pantalla no vuelve a "Cargando" y el scroll no salta.
 */

type Props = {
  plan: PlanDetail
  alMarcar: (userId: string, status: 'ATTENDED' | 'NO_SHOW') => Promise<void>
}

export function AttendanceSection({ plan, alMarcar }: Props) {
  const [marcando, setMarcando] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const resumen = resumenAsistencia(plan.participants)

  async function marcar(userId: string, status: 'ATTENDED' | 'NO_SHOW') {
    setMarcando(userId)
    setError(null)
    try {
      await alMarcar(userId, status)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo marcar la asistencia')
    } finally {
      setMarcando(null)
    }
  }

  return (
    <section className="plan-closing" aria-label="Asistencia">
      <h2>Asistencia</h2>
      <p className="note">
        {resumen.completo
          ? `Marcaste los ${resumen.total}. Podes corregir lo que quieras.`
          : `Marcaste ${resumen.total - resumen.sinMarcar} de ${resumen.total}.`}
      </p>

      <ul className="place-list">
        {plan.participants.map((p) => (
          <li key={p.user.id}>
            <div className="place-card">
              <div>
                <strong>{p.user.name}</strong>
                <span className="plan-meta">
                  {p.status === 'ATTENDED'
                    ? 'asistio'
                    : p.status === 'NO_SHOW'
                      ? 'no vino'
                      : 'sin marcar'}
                </span>
              </div>
              <div className="attendance-buttons">
                <button
                  className="secondary"
                  aria-pressed={p.status === 'ATTENDED'}
                  disabled={marcando === p.user.id}
                  onClick={() => void marcar(p.user.id, 'ATTENDED')}
                >
                  Asistio
                </button>
                <button
                  className="secondary"
                  aria-pressed={p.status === 'NO_SHOW'}
                  disabled={marcando === p.user.id}
                  onClick={() => void marcar(p.user.id, 'NO_SHOW')}
                >
                  No vino
                </button>
              </div>
            </div>
          </li>
        ))}
      </ul>

      {error && (
        <p className="msg error" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
