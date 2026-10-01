'use client'

import { formatPlanMoment } from '@/lib/plan-dates'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { useEffect, useRef } from 'react'
import { MapContainer, Marker, Popup, TileLayer, useMap, useMapEvents } from 'react-leaflet'
import { DEFAULT_CENTER, DEFAULT_ZOOM, resolveTileConfig } from '@/lib/map-tiles'
import { buildBbox } from '@/lib/map-bbox'
import type { PlanSummary } from '@/lib/plans'
import type { PlaceFeature } from '@/lib/places'

/**
 * El mapa en si. Se importa solo desde `explore-client.tsx` con
 * `dynamic(..., { ssr: false })`; importarlo desde otro lado rompe el render.
 */

type Props = {
  places: PlaceFeature[]
  plans: PlanSummary[]
  /** Lugares -> cantidad de planes abiertos, para el marker. */
  planCounts: Map<string, number>
  center: { lat: number; lng: number }
  zoom: number
  selected: string | null
  onSelect: (id: string) => void
  onMove: (next: { center: { lat: number; lng: number }; zoom: number; bbox: ReturnType<typeof buildBbox> }) => void
}

const tile = resolveTileConfig()

export default function ExploreMap({
  places,
  plans,
  planCounts,
  center,
  zoom,
  selected,
  onSelect,
  onMove,
}: Props) {
  return (
    <MapContainer
      center={center}
      zoom={zoom}
      scrollWheelZoom
      className="map"
      // Leaflet no sabe el tamano hasta que el contenedor tiene layout, y en un
      // contenedor de altura 0 dibuja en 0x0. `whenReady` mas el invalidate del
      // observer de abajo son las dos piezas que arreglan el "mapa gris".
    >
      <TileLayer url={tile.url} attribution={tile.attribution} maxZoom={tile.maxZoom} />
      <MoveReporter onMove={onMove} />
      <ResizeFixer />
      {places.map((p) => (
        <Marker
          key={p.id}
          position={[p.latitude, p.longitude]}
          eventHandlers={{ click: () => onSelect(p.id) }}
        >
          <Popup>
            <strong>{p.name}</strong>
            <br />
            {p.category.toLowerCase()}
            <br />
            {planCounts.get(p.id) ?? p.openPlanCount} planes abiertos
          </Popup>
        </Marker>
      ))}
      {plans.map((p) => (
        <Marker
          key={`plan-${p.id}`}
          position={[p.place.latitude, p.place.longitude]}
          eventHandlers={{ click: () => onSelect(p.id) }}
        >
          <Popup>
            <strong>{p.title}</strong>
            <br />
            {formatPlanMoment(p.startsAt)}
            <br />
            {p.remainingSpots > 0 ? `${p.remainingSpots} lugares` : 'Completo'}
          </Popup>
        </Marker>
      ))}
      {selected && <FlyToSelection places={places} plans={plans} selected={selected} center={center} />}
    </MapContainer>
  )
}

/**
 * Avisa cuando la vista se movio, con la caja resultante.
 *
 * `moveend` y no `move`: `move` dispara continuo mientras se arrastra, y
 * consultar en cada frame es una peticion por pixel. `moveend` dispara cuando la
 * vista se asienta.
 */
function MoveReporter({ onMove }: { onMove: Props['onMove'] }) {
  const map = useMapEvents({
    moveend: () => {
      const c = map.getCenter()
      const z = map.getZoom()
      onMove({ center: { lat: c.lat, lng: c.lng }, zoom: z, bbox: buildBbox({ lat: c.lat, lng: c.lng }, z) })
    },
  })
  return null
}

/**
 * Leaflet calcula el tamano del mapa una vez, al montarse. Si el contenedor
 * todavia no tiene layout (pestaña cerrada, contenedor con `display:none`, o
 * simplemente el CSS que llega tarde), queda en 0x0 y las teselas no cargan.
 *
 * `invalidateSize` en el primer `ResizeObserver` corrige el caso comun sin
 * tener que hacer un hack de `setTimeout`.
 */
function ResizeFixer() {
  const map = useMap()
  useEffect(() => {
    const el = map.getContainer()
    const ro = new ResizeObserver(() => {
      map.invalidateSize()
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [map])
  return null
}

/** Centra el mapa cuando se elige algo de la lista, sin pelear con el arrastre. */
function FlyToSelection({
  places,
  plans,
  selected,
  center,
}: {
  places: PlaceFeature[]
  plans: PlanSummary[]
  selected: string
  center: { lat: number; lng: number }
}) {
  const map = useMap()
  useEffect(() => {
    const plan = plans.find((p) => p.id === selected)
    const place = places.find((p) => p.id === selected)
    const target = plan?.place ?? place
    if (target) {
      map.flyTo([target.latitude, target.longitude], Math.max(map.getZoom(), 15))
    }
    // `center` no va en las deps a proposito: el efecto corre cuando cambia la
    // seleccion, no cuando el mapa se mueve. Si fuera dependencia, cada arrastre
    // re-dispararia el flyTo y el mapa nunca dejaria que el usuario lo mueva.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, selected, places, plans])
  return null
}

export { DEFAULT_CENTER, DEFAULT_ZOOM }
