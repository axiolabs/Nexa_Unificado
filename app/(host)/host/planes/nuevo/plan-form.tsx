'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { formatPlanMoment, nextQuarterHour, toApiDate, toLocalInputValue } from '@/lib/plan-dates'
import { PLACE_CATEGORIES } from '@/lib/enums'
// Importado, no re-declarado: una copia local del union compila igual y queda
// vieja en silencio, que es el mismo modo de falla que motivo `lib/enums.ts`.
import type { PlaceCategoryValue } from '@/lib/enums'

/**
 * Formulario de creacion de plan.
 *
 * Decisiones que no son obvias y conviene no volver a debatable:
 *
 * 1. El selector de lugares pega contra `/api/host/places`, NO contra
 *    `/api/places`. El endpoint publico responde a "que lugares puedo ver" y le
 *    muestra los `PENDING` al curador; este responde a "donde puedo hacer un
 *    plan" y aplica `planablePlaceWhere()`. Con el endpoint equivocado, un
 *    curador elige un lugar pendiente, completa el formulario entero, y recibe
 *    un 404 al enviar. El error del servidor seria correcto, pero llega tarde.
 *
 * 2. El tope de resultados se muestra. Si la busqueda trae 20 de 63, el texto
 *    lo dice con el numero al lado, en vez de dejar que el host escriba "bar"
 *    tres veces y concluya que solo hay dos bares en la ciudad.
 *
 * 3. La validacion real es la del server. Aca solo estan los `required`,
 * `min`, `max` y `minLength` nativos, que dan una ayuda inmediata y gratis. Toda
 *    regla que se duplique en el cliente y no en el schema es una regla que va
 *    a quedar desincronizada; el server es la unica autoridad y el unico que
 *    devuelve errores por campo.
 *
 * 4. El exito NO manda al host a /explore. Mostrar el resultado en el lugar y
 *    ofrecer un enlace al plan recien creado: un plan que no aparece en ninguna
 *    pantalla es indistinguible de un plan que no se creo, y el mapa no lo
 *    muestra si el lugar esta fuera de la caja que se esta mirando.
 *
 * 5. `PlaceCategoryValue` se IMPORTA de `lib/enums`. Acero
 *    estaba la misma union escrita a mano, y el comentario de al lado que dice
 *    "los uniones salen de lib/enums" era falso por la copia misma.
 */

type PlaceHit = {
  id: string
  name: string
  description: string | null
  category: PlaceCategoryValue
  latitude: number
  longitude: number
  openPlanCount: number
}

/**
 * `PlaceHit` replica EXACTAMENTE lo que devuelve el endpoint, y a proposito
 * incluye el `openPlanCount`, que es el campo que distingue dos lugares con el
 * mismo nombre y ademas le dice al host si ese lugar ya tiene planes.
 *
 * `address` y `city` NO aparecen, aunque existan en el modelo: no estan en el
 * `select` de `PLACE_SELECT`, que es compartido con el endpoint publico.
 * Agregarlos cambiaria la forma de la respuesta publica, y eso no se cambia de
 * pasada. Queda anotado como deuda.
 *
 * Con `description` no se dibuja nada, por la misma razon: es texto libre de
 * quien propose el lugar y no ayuda a elegir.
 */

type SearchResult = {
  places: PlaceHit[]
  total: number
  truncated: boolean
}

type FieldErrors = Record<string, string>

type CreatedPlan = {
  id: string
  title: string
  startsAt: string
  capacity: number
  acceptedCount: number
}

const LIMITE_VISIBLE = 20

/**
 * La linea de detalle de un lugar en el selector.
 *
 * Necesita desambiguar, no decorar: la busqueda es por subcadena del nombre, asi
 * que todos los resultados se parecen entre si. La categoria sola no alcanza
 * cuando hay dos "cafe" del mismo barrio, asi que suma cuantos planes abiertos
 * tiene: datos que el host ya tiene en pantalla y que contestan "¿este o el
 * otro?" sin abrir otra pagina.
 */
function describePlace(p: PlaceHit): string {
  const partes = [p.category.toLowerCase()]
  if (p.openPlanCount > 0) {
    partes.push(
      `${p.openPlanCount} ${p.openPlanCount === 1 ? 'plan abierto' : 'planes abiertos'}`,
    )
  }
  return partes.join(' - ')
}

export function PlanForm() {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [startsAt, setStartsAt] = useState('')
  const [endsAt, setEndsAt] = useState('')
  const [capacity, setCapacity] = useState(4)

  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [place, setPlace] = useState<PlaceHit | null>(null)

  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const [created, setCreated] = useState<CreatedPlan | null>(null)

  // El `min` de los inputs se calcula una vez al montar. Recalcularlo en cada
  // render hace que el limite se mueva mientras el usuario tipea, y el navegador
  // le marca error por un valor que hace un segundo era valido.
  const [minDate] = useState(() => nextQuarterHour())

  // Guarda el AbortController de la busqueda en curso. Sin esto, dos tecleadas
  // rapidas generan dos requests y el que responde ULTIMO gana: la lista
  // termina mostrando los resultados de "ba" cuando el usuario ya escribio
  // "bar". Es un bug de carrera, no de logica, y por eso se cancela el anterior
  // en vez de confiar en el orden de llegada de la red.
  const searchAbort = useRef<AbortController | null>(null)

  useEffect(() => {
    const q = query.trim()
    if (q.length < 2) {
      searchAbort.current?.abort()
      setResults(null)
      setSearchError(null)
      setSearching(false)
      return
    }

    const controller = new AbortController()
    searchAbort.current?.abort()
    searchAbort.current = controller
    setSearching(true)

    // 300 ms. Menor que eso es una request por tecla; mayor que eso se siente
    // lento sin motivo. No es un numero magicado con evidencia: es el mismo
    // criterio que usan los buscadores sin infraestructura propia.
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/host/places?q=${encodeURIComponent(q)}`, {
          signal: controller.signal,
        })
        const body = (await res.json()) as SearchResult & { error?: string }
        if (!res.ok) {
          setSearchError(body.error ?? 'No se pudo buscar')
          setResults(null)
          return
        }
        setSearchError(null)
        setResults(body)
      } catch (err) {
        // Un abort es el camino normal, no un error: se termino otra busqueda o
        // se desarmo el componente. Solo se reporta lo que no es cancelacion.
        if (!(err instanceof DOMException && err.name === 'AbortError')) {
          setSearchError('No se pudo buscar. Revisa la conexion.')
          setResults(null)
        }
      } finally {
        // Solo el request vigente puede tocar el estado: si uno viejo termina
        // despues, su `finally` apagaria el spinner de la busqueda nueva.
        if (!controller.signal.aborted) setSearching(false)
      }
    }, 300)

    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [query])

  const onSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault()
      setFormError(null)
      setFieldErrors({})

      if (!place) {
        setFormError('Elegi un lugar')
        return
      }

      const startsIso = toApiDate(startsAt)
      if (!startsIso) {
        setFieldErrors({ startsAt: 'Elegi una fecha de inicio valida' })
        return
      }
      const endsIso = endsAt.trim() ? toApiDate(endsAt) : null
      if (endsAt.trim() && !endsIso) {
        setFieldErrors({ endsAt: 'La hora de fin no es una fecha valida' })
        return
      }

      setSubmitting(true)
      try {
        const res = await fetch('/api/plans', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            title: title.trim(),
            // El schema hace `description` opcional, no obligatoria: mandarla
            // vacia como `''` seria un string presente y el `.trim()` lo deja en
            // '', que no es lo mismo que no mandarla. Se omite el campo entero.
            ...(description.trim() ? { description: description.trim() } : {}),
            placeId: place.id,
            startsAt: startsIso,
            ...(endsIso ? { endsAt: endsIso } : {}),
            capacity,
          }),
        })
        const body = (await res.json()) as {
          plan?: CreatedPlan
          error?: string
          fields?: FieldErrors
        }

        if (res.status === 201 && body.plan) {
          setCreated(body.plan)
          return
        }
        if (body.fields) setFieldErrors(body.fields)
        setFormError(body.error ?? 'No se pudo crear el plan')
      } catch {
        setFormError('No se pudo crear el plan. Revisa la conexion.')
      } finally {
        setSubmitting(false)
      }
    },
    [title, description, place, startsAt, endsAt, capacity],
  )

  if (created) {
    return (
      <div className="msg ok" role="status">
        <p style={{ margin: '0 0 0.5rem' }}>
          <strong>Plan creado.</strong> Quedaste como organizer, ya estas confirmado, y tu plaza
          esta contada: sos {created.acceptedCount} de {created.capacity}.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          {created.title} - {formatPlanMoment(created.startsAt)}
        </p>
        <p className="note" style={{ margin: 0 }}>
          <Link href={`/planes/${created.id}`}>Ver el plan</Link> para ver quien se confirmo, o{' '}
          <Link href="/explore">el mapa</Link> para seguir buscando lugares.
        </p>
      </div>
    )
  }

  return (
    <form className="plan-form" onSubmit={onSubmit} noValidate>
      {formError && (
        <div className="msg error" role="alert">
          {formError}
        </div>
      )}

      <fieldset className="picker">
        <legend>Lugar</legend>

        {place ? (
          <div className="place-chip">
            <div>
              <strong>{place.name}</strong>
              <div className="plan-meta">{describePlace(place)}</div>
            </div>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setPlace(null)
                setQuery('')
                setResults(null)
              }}
            >
              Cambiar
            </button>
          </div>
        ) : (
          <>
            <label htmlFor="place-q">Buscar por nombre</label>
            <input
              id="place-q"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Ej: Cafe del Molino"
              autoComplete="off"
              aria-describedby="place-q-help"
            />
            <p id="place-q-help" className="note">
              Solo aparecen lugares aprobados y activos. Es la misma regla que aplica al crear el
              plan, asi que no se puede elegir algo que despues sea rechazado.
            </p>

            {searchError && (
              <div className="msg error" role="alert">
                {searchError}
              </div>
            )}
            {searching && <p className="plan-meta">Buscando...</p>}

            {results && !place && (
              <>
                {results.places.length === 0 ? (
                  <p className="plan-meta">Ningun lugar coincide con esa busqueda.</p>
                ) : (
                  <ul className="place-list" aria-label="Lugares encontrados">
                    {results.places.map((p) => (
                      <li key={p.id}>
                        <button
                          type="button"
                          className="place-card"
                          onClick={() => setPlace(p)}
                        >
                          <strong>{p.name}</strong>
                          <span className="plan-meta">{describePlace(p)}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}

                {/*
                 * El tope se declara, no se disimula. Con 63 resultados solo se
                 * ven 20, y el host tiene que poder narrowing con el nombre en vez
                 * de suponer que la app no tiene los otros.
                 */}
                <p className="plan-meta" role="status">
                  {results.truncated
                    ? `Mostrando ${results.places.length} de ${results.total}. Afina la busqueda para ver los otros.`
                    : `${results.total} ${results.total === 1 ? 'lugar' : 'lugares'}`}
                </p>
              </>
            )}
          </>
        )}
      </fieldset>

      <label htmlFor="title">
        Titulo
        <input
          id="title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          minLength={3}
          maxLength={120}
          required
        />
        {fieldErrors.title && <span className="field-error">{fieldErrors.title}</span>}
      </label>

      <label htmlFor="description">
        Descripcion <span className="plan-meta">(opcional)</span>
        <textarea
          id="description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={2000}
          rows={4}
        />
        {fieldErrors.description && <span className="field-error">{fieldErrors.description}</span>}
      </label>

      <div className="row">
        <label htmlFor="startsAt">
          Comienza
          <input
            id="startsAt"
            type="datetime-local"
            value={startsAt}
            min={minDate}
            onChange={(e) => {
              setStartsAt(e.target.value)
              // La hora de fin no puede quedar antes que la de inicio. Si el host
              // ya habia elegido un fin y mueve el inicio mas tarde, se limpia en
              // vez de dejar un formulario con dos horas imposibles y un error
              // que solo aparece al enviar.
              setEndsAt((prev) => {
                if (!prev || !startsAt) return prev
                return new Date(prev) > new Date(e.target.value) ? '' : prev
              })
            }}
            required
          />
          {fieldErrors.startsAt && <span className="field-error">{fieldErrors.startsAt}</span>}
        </label>

        <label htmlFor="endsAt">
          Termina <span className="plan-meta">(opcional)</span>
          <input
            id="endsAt"
            type="datetime-local"
            value={endsAt}
            min={startsAt || minDate}
            onChange={(e) => setEndsAt(e.target.value)}
          />
          {fieldErrors.endsAt && <span className="field-error">{fieldErrors.endsAt}</span>}
        </label>
      </div>

      <label htmlFor="capacity">
        Cuantos caben
        <input
          id="capacity"
          type="number"
          value={capacity}
          min={2}
          max={50}
          step={1}
          onChange={(e) => setCapacity(Number(e.target.value))}
          required
        />
        <span className="plan-meta">Te incluye a vos, que entras confirmado.</span>
        {fieldErrors.capacity && <span className="field-error">{fieldErrors.capacity}</span>}
      </label>

      <button type="submit" disabled={submitting}>
        {submitting ? 'Creando...' : 'Crear plan'}
      </button>
    </form>
  )
}

/**
 * Se exporta para que el test pueda comprobar el formato del `min` sin montar
 * React. `nextQuarterHour` ya tiene sus propios tests; este es el cableado.
 */
export { toLocalInputValue, LIMITE_VISIBLE }
