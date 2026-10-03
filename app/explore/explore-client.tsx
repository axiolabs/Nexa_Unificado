'use client'

import dynamic from 'next/dynamic'
import Link from 'next/link'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { DEFAULT_CENTER, DEFAULT_ZOOM } from '@/lib/map-tiles'
import { buildBbox, isSameBbox } from '@/lib/map-bbox'
import { CATEGORY_LABELS, PLACE_CATEGORIES } from '@/lib/enums'
import { formatPlanMoment } from '@/lib/plan-dates'
import type { PlanSummary } from '@/lib/plans'
import {
  mensajeRecordatorio,
  textoEnlaceRecordatorio,
  tocaRecordar,
  type TestStatus,
} from '@/lib/personality-reminder'
import type { PlaceFeature } from '@/lib/places'

/**
 * Leaflet entra por `dynamic(..., { ssr: false })` y NO puede entrar en otro
 * archivo que lo importe directo.
 *
 * La razon es una restriction de Next, no una preferencia: `ssr: false` no esta
 * permitido en un Server Component, tira al compilar. Por eso este wrapper es
 * 'use client' y el mapa real vive aparte, en `explore-map.tsx`. Si el mapa se
 * importara desde `page.tsx` (Server), el build falla; si se importara desde
 * este archivo sin `dynamic`, el render del servidor intenta correr Leaflet y
 * `window` no existe.
 *
 * El nombre es `ExploreMap` y no `Map` a proposito: `Map` es el constructor
 * global de los mapas de JS, y en este archivo se usa `new Map()` para contar
 * planes por lugar. Llamarle `Map` al componente lo sombrea, y el error que sale
 * es "This expression is not constructable" en una linea de conteo, a cuatro
 * pantallas de donde esta la causa.
 *
 * `loading` no es decorativo: sin el, el mapa aparece de golpe y en un movil
 * lento se ve una pantalla blanca que despues salta. El placeholder tiene la
 * misma altura que el mapa para que la pagina no salte al cargar las teselas.
 */
const ExploreMap = dynamic(() => import('./explore-map'), {
  ssr: false,
  loading: () => <div className="map-skeleton" aria-hidden="true" />,
})

/**
 * Los filtros se arman con las listas del dominio, NO con arrays escritos aca.
 *
 * Este archivo tenia su propia copia de los filtros, con valores que
 * **ninguno** existia en el enum del dominio. Elegir uno mandaba una query con
 * un valor invalido y recibia un 400: el filtro estaba roto y el unico test de
 * sincronia comparaba `lib/validation.ts` contra Prisma, donde las dos listas
 * estaban bien. El que mentia era esta copia.
 *
 * Importar hace que la desincronizacion sea imposible en vez de detectable.
 */
const CATEGORIES = [
  { value: '', label: 'Todo' },
  ...PLACE_CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABELS[c] })),
]

export default function ExploreClient() {
  const [center, setCenter] = useState(DEFAULT_CENTER)
  const [zoom, setZoom] = useState(DEFAULT_ZOOM)
  const [bbox, setBbox] = useState(() => buildBbox(DEFAULT_CENTER, DEFAULT_ZOOM))
  const [category, setCategory] = useState('')

  const [places, setPlaces] = useState<PlaceFeature[]>([])
  const [plans, setPlans] = useState<PlanSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [needsLogin, setNeedsLogin] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)

  /**
   * Estado del test de personalidad, para el recordatorio.
   *
   * Va en su propio `useEffect` y NO en `load`, a proposito. `load` se vuelve a
   * correr en cada movimiento del mapa, por el `bbox`; preguntar "ya hice el
   * test" en cada panoramica es pedir lo mismo cientos de veces para obtener la
   * misma respuesta. Ademas `load` mezcla lugares con planes, y este dato es de
   * otra naturaleza: no es del mapa, es de la persona.
   */
  const [test, setTest] = useState<TestStatus | null>(null)
  const [recordatorioOculto, setRecordatorioOculto] = useState(false)

  useEffect(() => {
    // Un 401 aca no es un error: el mapa es publico y las personas sin sesion no
    // tienen test que hacer. No se muestra nada y no se avisa.
    fetch('/api/personality', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: TestStatus | null) => setTest(d))
      .catch(() => setTest(null))
  }, [])

  /**
   * Trae lugares y planes en paralelo, con `Promise.all` y no en serie: son dos
   * consultas independientes y encadenarlas suma latencia sin motivo.
   *
   * Los planes exigen sesion y los lugares no, asi que un 401 en `/api/plans`
   * no es un error de la pantalla: es "entra para ver los planes". Por eso el
   * 401 se maneja por separado del resto y no se muestra como falla.
   */
  const load = useCallback(async () => {
    setLoading(true)
    setError(null)

    const placeQuery = new URLSearchParams({ bbox: bboxString(bbox) })
    if (category) placeQuery.set('category', category)

    try {
      const [placesRes, plansRes] = await Promise.all([
        fetch(`/api/places?${placeQuery}`, { cache: 'no-store' }),
        fetch(`/api/plans?bbox=${encodeURIComponent(bboxString(bbox))}`, {
          cache: 'no-store',
        }),
      ])

      if (!placesRes.ok) {
        const body = await placesRes.json().catch(() => ({}))
        setError(body.error ?? `HTTP ${placesRes.status}`)
        setPlaces([])
        setPlans([])
        return
      }
      setPlaces(((await placesRes.json()) as { places: PlaceFeature[] }).places)

      if (plansRes.status === 401) {
        setNeedsLogin(true)
        setPlans([])
      } else if (!plansRes.ok) {
        const body = await plansRes.json().catch(() => ({}))
        setError(body.error ?? `HTTP ${plansRes.status}`)
        setPlans([])
      } else {
        setNeedsLogin(false)
        setPlans(((await plansRes.json()) as { plans: PlanSummary[] }).plans)
      }
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [bbox, category])

  useEffect(() => {
    void load()
  }, [load])

  /**
   * Los filtros no recargan. Un select dispara el `onchange` una vez sola, pero
   * un control de arrastre lo dispara en cada pixel: sin este corte, decenas de
   * peticiones para un solo filtro.
   */
  const reloadForFilters = useCallback(() => {
    setBbox((prev) => ({ ...prev }))
    void load()
  }, [load])

  const placesWithPlans = useMemo(() => {
    const counts = new Map<string, number>()
    for (const p of plans) counts.set(p.place.id, (counts.get(p.place.id) ?? 0) + 1)
    return counts
  }, [plans])

  return (
    <>
      <div className="shellbar">
        <span className="shellbar-title">Nexa</span>
        <Link className="shellbar-link" href="/">
          Sesion
        </Link>
      </div>

      <main className="explore">
        <h1>Explorar</h1>
        <p className="lede">
          Lugares y planes abiertos en la zona que estas mirando.
        </p>

        {/*
          El recordatorio es una linea, con un enlace y una X. No es un modal, no
          tapa el mapa y no impide hacer nada: el test es saltable y la decision
          de saltarlo tiene que quedar registrada sin pelea.

          La X es lo que lo hace pasivo de verdad. Un recordatorio que vuelve en
          cada visita al mapa se vuelve ruido a la tercera, y el ruido enseña a
          la gente a ignorar el banner entero, incluido el dia que sirva avisar de
          algo que si importa. Cerrarlo es una decision de la persona y se
          respeta.
        */}
        {tocaRecordar(test, recordatorioOculto) && test && (
          <div className="recordatorio" role="status">
            <span>{mensajeRecordatorio(test)}</span>
            <Link className="recordatorio-go" href="/personalidad">
              {textoEnlaceRecordatorio(test)}
            </Link>
            <button
              className="recordatorio-x"
              onClick={() => setRecordatorioOculto(true)}
              aria-label="Cerrar el recordatorio"
            >
              x
            </button>
          </div>
        )}

        <div className="filters" role="group" aria-label="Filtros">
          <label>
            Categoria
            <select value={category} onChange={(e) => setCategory(e.target.value)}>
              {CATEGORIES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <button className="secondary" onClick={reloadForFilters} disabled={loading}>
            {loading ? 'Buscando...' : 'Aplicar'}
          </button>
        </div>

        {error && <p className="msg error">{error}</p>}
        {needsLogin && (
          <p className="note">
            Los lugares son publicos. Los planes necesitan sesion:{' '}
            <Link className="shellbar-link" href="/">
              entra
            </Link>{' '}
            para ver quien organiza.
          </p>
        )}

        <div className="map-wrap">
          <ExploreMap
            places={places}
            plans={plans}
            planCounts={placesWithPlans}
            center={center}
            zoom={zoom}
            selected={selected}
            onSelect={setSelected}
            onMove={(next) => {
              // Solo se recarga si la caja cambio de verdad. `onMove` dispara en
              // cada pixel de arrastre, y recargar en cada uno seria repetir la
              // consulta para una caja que en pantalla dice lo mismo.
              if (!isSameBbox(next.bbox, bbox)) setBbox(next.bbox)
              setCenter(next.center)
              setZoom(next.zoom)
            }}
          />
        </div>

        <p className="note">
          {loading ? 'Consultando...' : `${places.length} lugares, ${plans.length} planes`}
        </p>

        <h2>Planes abiertos</h2>
        {plans.length === 0 ? (
          <p className="note">
            {needsLogin
              ? 'Entra para ver los planes de la zona.'
              : 'No hay planes abiertos en esta zona.'}
          </p>
        ) : (
          <ul className="plan-list">
            {plans.map((p) => (
              <li key={p.id} className={selected === p.id ? 'is-selected' : undefined}>
                <button
                  className="plan-card"
                  onClick={() => {
                    setSelected(p.id)
                    setCenter({ lat: p.place.latitude, lng: p.place.longitude })
                    setZoom(15)
                  }}
                >
                  <strong>{p.title}</strong>
                  <span className="plan-meta">
                    {p.place.name} - {formatPlanMoment(p.startsAt)}
                  </span>
                  <span className="plan-meta">
                    {p.remainingSpots > 0
                      ? `${p.remainingSpots} de ${p.capacity} lugares`
                      : 'Completo'}
                    {p.viewer.isCreator && ' - lo organizas vos'}
                    {!p.viewer.isCreator && p.viewer.participation?.status === 'ACCEPTED' && ' - confirmado'}
                    {!p.viewer.isCreator &&
                      p.viewer.participation?.status === 'REQUESTED' &&
                      ' - pediste, esperando'}
                  </span>
                </button>
                {/*
                  El enlace va FUERA del boton a proposito. Un `Link` adentro de
                  un `button` es HTML invalido: el teclado recorre los dos como
                  uno solo y el click se dispara dos veces. Y el detalle NO se
                  abre desde la tarjeta porque la tarjeta no es un lugar de
                  decision: decide uno que ya sabe que quiere unirse. Ver el plan
                  es un paso explicito, con su propio texto.
                */}
                {/*
                  El enlace va FUERA del boton a proposito. Un `Link` adentro de
                  un `button` es HTML invalido: el teclado recorre los dos como
                  uno solo y el click se dispara dos veces. Y el detalle NO se
                  abre desde la tarjeta porque la tarjeta no es un lugar de
                  decision: decide uno que ya sabe que quiere unirse. Ver el plan
                  es un paso explicito, con su propio texto.
                */}
                <Link className="plan-go" href={`/planes/${p.id}`}>
                  Ver plan
                </Link>
              </li>
            ))}
          </ul>
        )}

        <h2>Lugares</h2>
        {places.length === 0 ? (
          <p className="note">No hay lugares en esta zona.</p>
        ) : (
          <ul className="place-list">
            {places.map((p) => (
              <li key={p.id}>
                <button
                  className="place-card"
                  onClick={() => {
                    setSelected(p.id)
                    setCenter({ lat: p.latitude, lng: p.longitude })
                    setZoom(15)
                  }}
                >
                  <strong>{p.name}</strong>
                  <span className="plan-meta">
                    {p.category.toLowerCase()} - {p.openPlanCount} planes
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </main>
    </>
  )
}

function bboxString(b: { minLng: number; minLat: number; maxLng: number; maxLat: number }) {
  return `${b.minLng},${b.minLat},${b.maxLng},${b.maxLat}`
}

/**
 * Muestra la hora de un plan.
 *
 * Antes eran tres implementaciones distintas de la misma cosa: esta, un
 * `toLocaleString` crudo en el popup del mapa, y el modulo de fechas del
 * formulario de creacion. Se mostraban horas distintas para el MISMO plan
 *dependiendo de donde se mirara, y dos de ellas con el bug de las 12 horas.
 * Ahora las tres salen de `lib/plan-dates`.
 */
