'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { formatPlanMoment } from '@/lib/plan-dates'
import type { TonoMensaje } from '@/lib/plan-join'
import {
  describirAlineacion,
  describirReliability,
  type HostPlanSummary,
  type PlanSolicitudes,
  type SolicitudPendiente,
} from '@/lib/plan-requests'

/**
 * La pantalla de solicitudes, del lado del cliente.
 *
 * Los tipos vienen de `lib/plan-requests.ts`, que es donde vive anotada la
 * forma de las dos respuestas. Misma regla que en `plan-detail-client.tsx`: no
 * se re-declara la forma aca, porque una copia puede quedar vieja sin avisar.
 */

export function RequestsClient({ planPedido }: { planPedido?: string }) {
  const [planes, setPlanes] = useState<HostPlanSummary[] | null>(null)
  const [planId, setPlanId] = useState<string | null>(planPedido ?? null)
  const [datos, setDatos] = useState<PlanSolicitudes | null>(null)

  const [cargandoPlanes, setCargandoPlanes] = useState(true)
  const [cargandoSolicitudes, setCargandoSolicitudes] = useState(false)

  /**
   * Dos errores y no uno.
   *
   * Con un solo estado, `cargarPlanes` y `cargarSolicitudes` se pisan: se
   * relanzan juntos al decidir una solicitud, y el `setError(null)` del que
   * termina bien borra el fallo del otro, dejando la pantalla en blanco sin
   * decir nada. Cada cargadueñe su error.
   */
  const [errorPlanes, setErrorPlanes] = useState<string | null>(null)
  const [errorSolicitudes, setErrorSolicitudes] = useState<string | null>(null)
  /** userId de la fila en la que se esta clicking, para desactivar solo esa. */
  const [decidiendo, setDecidiendo] = useState<string | null>(null)
  const [mensaje, setMensaje] = useState<{ tipo: TonoMensaje; texto: string } | null>(null)

  /**
   * Los planes propios. Se cargan una vez y se vuelven a pedir tras decidir.
   *
   * Ante un fallo, `planes` queda en `null` y no en `[]`. Con `[]` el render
   * caia en "No organizas ningun plan todavia", que es un exito falso: un 401
   * o la conexion caida llevan al organizador a crear un plan que ya tiene.
   */
  const cargarPlanes = useCallback(async () => {
    try {
      const res = await fetch('/api/host/plans', { cache: 'no-store' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setErrorPlanes(body.error ?? `HTTP ${res.status}`)
        setPlanes(null)
        return
      }
      const body = (await res.json()) as { plans: HostPlanSummary[] }
      setPlanes(body.plans)
      setErrorPlanes(null)
      // El plan de la URL manda, pero solo si es propio. Un `?plan=` con el id
      // de otro plan, o de un plan borrado, no puede quedar seleccionado: el
      // selector no tendria una opcion marcada y la vista de solicitudes
      // devolveria 404 con un error que no ayuda a nada.
      setPlanId((actual) => {
        if (actual && body.plans.some((p) => p.id === actual)) return actual
        // Sin eleccion en la URL se abre el plan con pendientes: el primero a
        // secas podria ser un plan sin nada que revisar y la pantalla pareceria
        // vacia.
        const conPendientes = body.plans.find((p) => p.pendingCount > 0)
        return (conPendientes ?? body.plans[0])?.id ?? null
      })
    } catch {
      setErrorPlanes('No se pudieron cargar tus planes. Revisa la conexion.')
      setPlanes(null)
    } finally {
      setCargandoPlanes(false)
    }
  }, [])

  const cargarSolicitudes = useCallback(async (id: string) => {
    setCargandoSolicitudes(true)
    try {
      const res = await fetch(`/api/plans/${id}/requests`, { cache: 'no-store' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setErrorSolicitudes(body.error ?? `HTTP ${res.status}`)
        setDatos(null)
        return
      }
      setDatos((await res.json()) as PlanSolicitudes)
      setErrorSolicitudes(null)
    } catch {
      setErrorSolicitudes('No se pudieron cargar las solicitudes. Revisa la conexion.')
      setDatos(null)
    } finally {
      setCargandoSolicitudes(false)
    }
  }, [])

  useEffect(() => {
    void cargarPlanes()
  }, [cargarPlanes])

  useEffect(() => {
    if (planId) void cargarSolicitudes(planId)
    else setDatos(null)
  }, [planId, cargarSolicitudes])

  /**
   * Aceptar o rechazar.
   *
   * El 409 no se trata como error generico: es el endpoint diciendo que el plan
   * se lleno o que la peticion ya no esta pendiente, y en los dos casos la
   * respuesta correcta es volver a leer la pantalla en vez de mostrar un error
   * que no ayuda a decidir nada. Igual se avisa, porque la decision del
   * organizador no ocurrio y tiene que saberlo.
   */
  const decidir = useCallback(
    async (s: SolicitudPendiente, decision: 'ACCEPTED' | 'DECLINED') => {
      if (!planId) return
      setDecidiendo(s.userId)
      setMensaje(null)
      try {
        const res = await fetch(`/api/plans/${planId}/requests`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ userId: s.userId, decision }),
        })
        if (res.ok) {
          if (decision === 'ACCEPTED') {
            setMensaje({ tipo: 'ok', texto: `Aceptaste a ${s.name}.` })
          } else {
            // Rechazar no es un logro que se festeje con verde, igual que no
            // es un error que merece rojo: es una decision privada entre el
            // organizador y quien pidio. Se confirma y se sigue.
            setMensaje({ tipo: 'neutro', texto: `No aceptaste la peticion de ${s.name}.` })
          }
        } else if (res.status === 409) {
          const body = await res.json().catch(() => ({}))
          setMensaje({ tipo: 'error', texto: `No se pudo decidir: ${body.error ?? 'el plan cambio'}` })
        } else {
          const body = await res.json().catch(() => ({}))
          setMensaje({ tipo: 'error', texto: body.error ?? `HTTP ${res.status}` })
        }
        // La lista y el contador del selector cambian juntos. Si solo se
        // recarga uno, el "2 pendientes" del selector deja de cuadrar con las
        // filas de la pantalla.
        await Promise.all([cargarSolicitudes(planId), cargarPlanes()])
      } catch {
        setMensaje({ tipo: 'error', texto: 'No se pudo enviar la decision. Revisa la conexion.' })
      } finally {
        setDecidiendo(null)
      }
    },
    [planId, cargarSolicitudes, cargarPlanes],
  )

  if (cargandoPlanes) return <p className="note">Cargando tus planes...</p>

  if (errorPlanes) return <p className="msg error">{errorPlanes}</p>

  if (planes && planes.length === 0) {
    return (
      <div>
        <p className="msg ok">No organizas ningun plan todavia.</p>
        <p className="note">
          <Link href="/host/planes/nuevo">Crear un plan</Link>
        </p>
      </div>
    )
  }

  const plan = datos?.plan
  const sinLugar = plan ? plan.remainingSpots <= 0 : false
  const solicituantes = datos?.requests ?? []

  return (
    <div>
      {/*
       * El selector es una lista de links y no un `<select>`, para que el plan
       * elegido quede en la URL. Ademas muestra el numero de pendientes, que es
       * la razon por la que se entra a esta pantalla.
       */}
      <ul className="plan-list">
        {(planes ?? []).map((p) => (
          <li key={p.id}>
            <Link
              href={`/host/requests?plan=${p.id}`}
              className="plan-card"
              aria-current={p.id === planId ? 'true' : undefined}
            >
              <span className="plan-go">{p.title}</span>
              <span className="plan-meta">
                {p.placeName} - {formatPlanMoment(p.startsAt)} - {p.acceptedCount} de {p.capacity}
              </span>
              <span className="plan-meta">
                {p.pendingCount === 0
                  ? 'sin solicitudes pendientes'
                  : `${p.pendingCount} solicitud${p.pendingCount === 1 ? '' : 'es'} pendiente${
                      p.pendingCount === 1 ? '' : 's'
                    }`}
                {p.status !== 'OPEN' ? ` - ${p.status.toLowerCase()}` : ''}
              </span>
            </Link>
          </li>
        ))}
      </ul>

      {errorSolicitudes ? <p className="msg error">{errorSolicitudes}</p> : null}

      {!planId ? <p className="note">Elegi un plan para ver las solicitudes.</p> : null}

      {cargandoSolicitudes ? <p className="note">Cargando solicitudes...</p> : null}

      {plan && !cargandoSolicitudes ? (
        <section className="solicitudes">
          <h2>{plan.title}</h2>
          <p className="note">
            {formatPlanMoment(plan.startsAt)} - {plan.acceptedCount} de {plan.capacity} lugares
            ocupados.
          </p>

          {/*
           * El plan lleno no se esconde: se avisa arriba. Un plan con 0 lugares
           * libres puede tener alguien esperando, y si la pantalla no dice por
           * que no puede aceptar, el organizador piensa que la pantalla esta
           * rota.
           */}
          {sinLugar ? (
            <p className="msg error">
              No quedan lugares. Podés seguir rechazando, pero no se puede aceptar a nadie hasta
              que libere lugares o abras el plan.
            </p>
          ) : null}

          {plan.status !== 'OPEN' ? (
            <p className="note">
              Este plan esta {plan.status.toLowerCase()}. Las decisiones siguen disponibles, pero no
              conviene tomarlas.
            </p>
          ) : null}

          {solicituantes.length === 0 ? (
            <p className="msg ok">No hay solicitudes pendientes en este plan.</p>
          ) : (
            <ul className="solicitud-lista">
              {solicituantes.map((s) => (
                <li key={s.userId} className="solicitud">
                  <div className="solicitud-cabeza">
                    <strong>{s.name}</strong>
                    <span className="note">
                      pide hace {s.hoursLeft === 1 ? '1 hora' : `${s.hoursLeft} horas`}
                      {s.hoursLeft === 0 ? ' (vence ahora)' : ''}
                    </span>
                  </div>
                  <dl className="solicitud-datos">
                    <dt>rasgos</dt>
                    <dd>{describirAlineacion(s.alineacion)}</dd>
                    <dt>asistencia</dt>
                    <dd>{describirReliability(s.reliability)}</dd>
                  </dl>
                  <div className="solicitud-acciones">
                    <button
                      type="button"
                      className="ok"
                      disabled={decidiendo === s.userId || sinLugar}
                      onClick={() => void decidir(s, 'ACCEPTED')}
                    >
                      {decidiendo === s.userId ? 'guardando...' : 'aceptar'}
                    </button>
                    <button
                      type="button"
                      disabled={decidiendo === s.userId}
                      onClick={() => void decidir(s, 'DECLINED')}
                    >
                      rechazar
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {/*
           * `resolved` se muestra aunque no queden solicitudes. El
           * auto-resolucion por TTL existe y no se ve: sin esto, un plan que
           * tuvo 6 solicitudes y ninguna pendiente parece un plan sin
           * actividad.
           */}
          {datos && (datos.resolved.accepted > 0 || datos.resolved.declined > 0) ? (
            <p className="note">
              {datos.resolved.accepted} aceptada{datos.resolved.accepted === 1 ? '' : 's'} y{' '}
              {datos.resolved.declined} rechazada{datos.resolved.declined === 1 ? '' : 's'} por
              vencimiento automatico.
            </p>
          ) : null}

          {mensaje ? <p className={`msg ${mensaje.tipo}`}>{mensaje.texto}</p> : null}
        </section>
      ) : null}
    </div>
  )
}
