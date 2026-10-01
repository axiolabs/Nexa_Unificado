'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { formatPlanMoment } from '@/lib/plan-dates'
import { CATEGORY_LABELS } from '@/lib/enums'
import { MENSAJES_POR_ESTADO, decidirUnirse } from '@/lib/plan-join'
import type { TonoMensaje } from '@/lib/plan-join'
import { puedeUsarChat } from '@/lib/chat'
import { planCerrable } from '@/lib/plan-finished'
import type { PlanDetail } from '@/lib/plans'
import { ChatClient } from './chat-client'
import { AttendanceSection } from './attendance-section'
import { RatingSection } from './rating-section'

/**
 * Detalle de un plan, del lado del cliente.
 *
 * NO hay una forma escrita aca. `PlanDetail` vive en `lib/plans.ts`, que es donde
 * el endpoint `GET /api/plans/[planId]` anota lo que devuelve: si la respuesta
 * cambia, los dos lados dejan de compilar juntos. Re-declarar los campos aca
 * seria una copia que puede quedar vieja sin avisar, que es el mismo error que
 * el de los precios del explorador en `lib/enums.ts`.
 */

/** Lo que devuelve el `POST /join`, tal cual. Los 201 y los 409 tienen forma distinta. */
type JoinOk = {
  status: 'REQUESTED'
  expiresAt: string
  remainingSpots: number
  planIsFull: boolean
}
type JoinChoque = { status: string }

export function PlanDetailClient({ planId }: { planId: string }) {
  const [plan, setPlan] = useState<PlanDetail | null>(null)
  const [cargando, setCargando] = useState(true)
  const [noEncontrado, setNoEncontrado] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [uniendo, setUniendo] = useState(false)
  const [mensaje, setMensaje] = useState<{ tipo: TonoMensaje; texto: string } | null>(null)

  const cargar = useCallback(async (opciones?: { silencioso?: boolean }) => {
    // Un refetch silencioso para las acciones de cerrar el plan. Un POST de
    // asistencia o de calificacion no puede poner toda la pantalla en
    // "Cargando...": el scroll saltaria y se perderia el lugar. El flag no
    // cambia que se recargue igual, solo si se ve el estado de carga.
    if (!opciones?.silencioso) setCargando(true)
    setError(null)
    setNoEncontrado(false)
    try {
      const res = await fetch(`/api/plans/${planId}`, { cache: 'no-store' })
      if (res.status === 404) {
        // No se distingue "no existe" de "no lo podes ver", y es lo que el
        // endpoint garantiza. La pagina no le dice al usuario POR QUE, porque
        // decir "existe pero no es visible" ya seria filtrar que existe.
        setNoEncontrado(true)
        setPlan(null)
        return
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setError(body.error ?? `HTTP ${res.status}`)
        setPlan(null)
        return
      }
      const body = (await res.json()) as { plan: PlanDetail }
      setPlan(body.plan)
    } catch {
      setError('No se pudo cargar el plan. Revisa la conexion.')
      setPlan(null)
    } finally {
      setCargando(false)
    }
  }, [planId])

  useEffect(() => {
    void cargar()
  }, [cargar])

  /**
   * Pedir unirse.
   *
   * El 409 no es un error: es el endpoint diciendo "ya estas en este estado", y
   * trae el estado adentro justamente para esto. Un `catch` generico lo
   * convertiria en "no se pudo unir" y perderia la distincion entre "esperando
   * aprobacion" y "te rechazaron".
   */
  const pedirUnirme = useCallback(async () => {
    setUniendo(true)
    setMensaje(null)
    try {
      const res = await fetch(`/api/plans/${planId}/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      // `.catch(() => ({}))` y no un `json()` pelado: si un proxy o un gateway
      // contestara HTML, el `JSON.parse` tiraria y el `catch` de abajo
      // reportaria "revisa la conexion" de una peticion que si llego. Con esto,
      // el `body.error` queda vacio y el mensaje sale del status.
      const body = (await res.json().catch(() => ({}))) as (JoinOk & JoinChoque) & { error?: string }
      if (res.status === 201) {
        // El texto sale del mapa y no de aca: estaba duplicado, y dos copias
        // de la misma frase es una forma garantizada de que una quede vieja.
        setMensaje({
          tipo: MENSAJES_POR_ESTADO.REQUESTED.tono,
          texto: MENSAJES_POR_ESTADO.REQUESTED.texto,
        })
        await cargar()
        return
      }

      if (res.status === 409 && body.status) {
        // El 409 con estado: se refleja lo que dijo el server, no un texto fijo.
        // El tono tambien viene del server. Pintar esto de rojo seria tratar
        // "estoy esperando" y "me rechazaron" como si fueran un fallo de la app,
        // y el rechazo es privado: no puede gritarle al usuario igual que un 500.
        const porEstado = MENSAJES_POR_ESTADO[body.status]
        setMensaje(
          porEstado
            ? { tipo: porEstado.tono, texto: porEstado.texto }
            : { tipo: 'error', texto: body.error ?? 'No te pudiste unir' },
        )
        await cargar()
        return
      }

      setMensaje({ tipo: 'error', texto: body.error ?? 'No te pudiste unir' })
      // Un 404 o un 403 pueden venir de que el plan cambio mientras mirabamos:
      // recargar deja la pantalla con la verdad en vez de con un error viejo.
      if (res.status === 404) await cargar()
    } catch {
      setMensaje({ tipo: 'error', texto: 'No se pudo enviar la peticion. Revisa la conexion.' })
    } finally {
      setUniendo(false)
    }
  }, [planId, cargar])

  /**
   * Marcar asistencia. Relee el plan entero en vez de parchar la fila, porque
   * el `GET` decide que se publica segun quien mira y una fila local parcheada a
   * mano puede contradecirlo: para el organizador la lista trae el estado, y el
   * endpoint devuelve el estado real, asi que se usa ese.
   *
   * El error se propaga con `throw` en vez de guardarse en un `useState` de
   * esta pantalla: cada seccion tiene su propio error pegado a sus propios
   * botones, y un error global en la parte de arriba de la pagina dejaria al
   * usuario sin ver cual de los dos botones fallo.
   */
  const marcarAsistencia = useCallback(
    async (userId: string, attendance: 'ATTENDED' | 'NO_SHOW') => {
      const res = await fetch(`/api/plans/${planId}/attendance`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId, attendance }),
      })
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) throw new Error(body.error ?? 'No se pudo marcar la asistencia')
      await cargar({ silencioso: true })
    },
    [planId, cargar],
  )

  /**
   * Calificar. Recarga en silencio porque el promedio y el conteo los calcula el
   * servidor: el cliente solo tiene el suyo, y con el suyo no puede saber el
   * promedio nuevo sin adivinar cuantos votos hay. Adivinar el promedio en
   * pantalla mientras el POST responde es el tipo de numero que se ve distinto
   * del que quedo.
   *
   * Devuelve el `creado` del servidor porque la recarga llega **antes** de que la
   * seccion pinte el exito: para el segundo toque ya hay voto en
   * `plan.ratings.mine`, y el componente no puede distinguir "acabo de crear" de
   * "acabo de corregir" mirando su propio estado.
   */
  const calificar = useCallback(
    async (rating: number, tags: string[]) => {
      const res = await fetch(`/api/plans/${planId}/ratings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // `tags` se manda siempre, incluso vacio. El `default([])` del schema
        // toleraria que no viniera, pero mandarlo explicito deja claro que
        // "no marque ninguna" es una decision y no un forgot.
        body: JSON.stringify({ rating, tags }),
      })
      const body = (await res.json().catch(() => ({}))) as { error?: string; creado?: boolean }
      if (!res.ok) throw new Error(body.error ?? 'No se pudo enviar la calificacion')
      await cargar({ silencioso: true })
      return { creado: body.creado === true }
    },
    [planId, cargar],
  )

  if (cargando) return <main className="explore"><p className="lede">Cargando…</p></main>

  if (noEncontrado) {
    return (
      <main className="explore">
        <h1>Plan no encontrado</h1>
        <p className="note">
          Puede que no exista, o que ya no se vea.{' '}
          <Link className="shellbar-link" href="/explore">
            Volver al mapa
          </Link>
        </p>
      </main>
    )
  }

  if (error || !plan) {
    return (
      <main className="explore">
        <h1>No se pudo cargar el plan</h1>
        {error && <p className="msg error">{error}</p>}
        <p className="note">
          <button className="secondary" onClick={() => void cargar()}>
            Reintentar
          </button>
        </p>
      </main>
    )
  }

  const yaEsta = plan.viewer.participation?.status ?? null

  /*
   * Las dos ventanas de cierre, con las MISMAS funciones que usa el endpoint.
   *
   * `cerrable` no se recalcula en un `useMemo` ni se guarda en estado: son tres
   * comparaciones contra la hora, y la unica forma de que el render y el POST
   * discrepen es que uno de los dos deje de usar la funcion. Un plan que termina
   * mientras la pantalla esta abierta no actualiza solo, y no debe: recargar es
   * una accion, no un reloj. La proxima navegacion lo muestra.
   */
  const cerrable = planCerrable({ status: plan.status, startsAt: plan.startsAt, endsAt: plan.endsAt })

  return (
    <main className="explore plan-detail">
      <div className="shellbar">
        <span className="shellbar-title">Nexa</span>
        <Link className="shellbar-link" href="/explore">
          Volver al mapa
        </Link>
      </div>

      <h1>{plan.title}</h1>
      <p className="lede">
        {formatPlanMoment(plan.startsAt)}
        {plan.endsAt && ` - ${formatPlanMoment(plan.endsAt)}`}
      </p>

      <section aria-label="Lugar">
        <h2>Lugar</h2>
        <p>
          <strong>{plan.place.name}</strong>{' '}
          <span className="plan-meta">
            {CATEGORY_LABELS[plan.place.category] ?? plan.place.category}
          </span>
        </p>
      </section>

      <section aria-label="Descripcion">
        <h2>De que se trata</h2>
        {plan.description ? (
          <p>{plan.description}</p>
        ) : (
          <p className="note">El organizador no escribio descripcion.</p>
        )}
      </section>

      <section aria-label="Quien va">
        <h2>Quien va</h2>
        <p className="note">
          Organiza {plan.creator.name}. {plan.acceptedCount} de {plan.capacity} lugares tomados.
        </p>
        <ul className="place-list">
          {plan.participants.map((p) => (
            <li key={p.user.id}>
              <div className="place-card">
                <strong>{p.user.name}</strong>
                <span className="plan-meta">
                  {p.role === 'ORGANIZER' ? 'organiza' : 'va'}
                </span>
              </div>
            </li>
          ))}
        </ul>
      </section>

      {/*
       * El chat se monta por la MISMA regla que el endpoint, con el helper
       * compartido `puedeUsarChat` y no con un `=== 'ACCEPTED'` escrito aca: si
       * la condicion se duplica, un cambio de estado se olvida de uno de los dos
       * y aparece la combinacion que no tiene que existir, ver el chat y que el
       * POST responda 403. Montarlo para un `REQUESTED` ofreceria una caja de
       * texto que responde 403, y `viewer.participation` ya esta en la
       * respuesta del plan, asi que no cuesta una consulta extra.
       *
       * Con `ATTENDED` y `NO_SHOW` el chat sigue montado a proposito: el plan
       * termino pero el canal no. Ver `CHAT_ABIERTOS_A`.
       */}
      {puedeUsarChat(yaEsta) && <ChatClient planId={planId} />}

      {/*
       * La asistencia la ve solo quien organiza, y solo con el plan terminado.
       * El endpoint dice 403 en las otras dos combinaciones, asi que el filtro de
       * aca no es una cortesia: es lo que evita pintar botones que no van a
       * hacer nada.
       */}
      {plan.viewer.isCreator && cerrable && (
        <AttendanceSection plan={plan} alMarcar={marcarAsistencia} />
      )}

      {/*
       * La calificacion la ve todo el mundo con el plan terminado, pero solo
       * quien estuvo recibe el formulario. Que el promedio este siempre es a
       * proposito: es la senal anonima de si el lugar valio la pena, y sin el la
       * unica forma de enterarse es abrir otro plan. El filtro de quien puede
       * calificar va DENTRO del componente, no aca: asi el formulario y el motivo
       * de que no este nunca pueden desincronizarse.
       */}
      {cerrable && <RatingSection plan={plan} alCalificar={calificar} />}

      <section className="plan-join" aria-label="Unirse">
        <h2>Unirse</h2>
        {BotonUnirse({
          plan,
          yaEsta,
          uniendo,
          onPedir: pedirUnirme,
        })}
        {mensaje && (
          <p className={`msg ${mensaje.tipo}`} role="status">
            {mensaje.texto}
          </p>
        )}
        {/*
         * "Igual podes pedir" solo tiene sentido para quien todavia no pidio nada.
         * Con la condicion en `yaEsta !== 'ACCEPTED'` le caia tambien a
         * `ATTENDED` y `NO_SHOW`, que arriba ya lei "Ya estuviste en este plan":
         * dos renglones seguidos diciendo pidas lo que pidas y no tenes nada que
         * pedir. Y a un `REQUESTED`, que ya lo pidio. `yaEsta === null` es
         * exactamente el caso en que el renglon es cierto.
         */}
        {plan.isFull && yaEsta === null && (
          <p className="note">
            Esta completo. Igual podes pedir: si alguien libera su lugar, el organizador lo ve.
          </p>
        )}
      </section>
    </main>
  )
}

/**
 * Los estados del boton salen de `viewer` y del plan, no de un fetch extra.
 *
 * `viewer.participation` es lo que hace que esto sea una sola consulta: sin el,
 * la pagina tendria que disparar un POST para averiguar si ya estabas adentro.
 * Ver §13.6.
 *
 * La decision esta en `lib/plan-join.ts` y aca solo se pinta. Un detalle de copy
 * que se parece a una regla y no lo es: pedir en un plan COMPLETO se permite a
 * proposito, y el boton no se deshabilita. El endpoint acepta la peticion y
 * devuelve `planIsFull`. Cancelar en el peor momento libera el lugar para otro,
 * asi que el plan lleno avisa, no bloquea.
 */
/**
 * Que clase CSS lleva cada tono.
 *
 * Antes era un ternario de dos casos (`ok` o `note`) y cualquier tono nuevo
 * caia en `note` por defecto, que es como un `REQUESTED` en neutro terminó
 * dibujandose verde. Con el mapa, sumar un tono es agregar una fila y el
 * compilador avisa si falta una.
 */
const CLASE_POR_TONO: Record<TonoMensaje | 'note', string> = {
  ok: 'msg ok',
  neutro: 'msg neutro',
  error: 'msg error',
  note: 'note',
}

function BotonUnirse({
  plan,
  yaEsta,
  uniendo,
  onPedir,
}: {
  plan: PlanDetail
  yaEsta: string | null
  uniendo: boolean
  onPedir: () => void
}) {
  const decision = decidirUnirse(
    {
      status: plan.status,
      startsAt: plan.startsAt,
      creatorName: plan.creator.name,
      isCreator: plan.viewer.isCreator,
    },
    yaEsta ? { status: yaEsta } : null,
  )

  if (decision.tipo === 'informativo') {
    return <p className={CLASE_POR_TONO[decision.tono]}>{decision.texto}</p>
  }

  return (
    <>
      <button onClick={onPedir} disabled={uniendo}>
        {uniendo ? 'Enviando...' : decision.etiqueta}
      </button>
      {decision.nota && <p className="note">{decision.nota}</p>}
    </>
  )
}
