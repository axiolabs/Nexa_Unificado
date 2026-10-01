/**
 * Conversion entre el centro/zoom del mapa y la caja que pide la API.
 *
 * Sin imports de Next: lo usan la pagina y los tests.
 *
 * El detalle importante es `buildBbox`. La API exige una caja, y el mapa solo
 * sabe de centro y zoom, asi que alguien tiene que hacer la cuenta. Si esa
 * cuenta vive dentro del componente del mapa, no se puede testear sin montar
 * Leaflet, y es exactamente la parte donde un error cuesta caro: una caja
 * chiquita hace que el mapa "no encuentre" lugares que estan a la vista, y el
 * sintoma parece un bug de datos.
 */

// Los topes de amplitud de la API. Se importan en vez de repetirlos: si el mapa
// acepta una caja que la API rechaza, el 400 vuelve a la pagina y el sintoma es
// "el mapa no carga", sin relacion aparente con el zoom.
import { MAX_LAT_SPAN, MAX_LNG_SPAN } from './validation'

export type LatLng = { lat: number; lng: number }

export type Bbox = {
  minLng: number
  minLat: number
  maxLng: number
  maxLat: number
}

/** Lado de una tesela en pixels, por definicion del estandar de Leaflet/OSM. */
const TILE_SIZE = 256
/** Ancho de referencia cuando no se conoce el viewport real. */
const DEFAULT_VIEWPORT_PX = 1024
const MAX_ZOOM = 19
/**
 * Holgura para el redondeo de punto flotante, en grados.
 *
 * Un grado de longitud son unos 111 km. Un epsilon de 1e-9 son 0.1 mm, invisible
 * en el mapa, y existe para que una caja que mide "justo" el limite no termine
 * midiendo un pelo mas y rebound 400.
 */
const EPS = 1e-9

/**
 * Latitud, en grados, que corresponde a una coordenada `y` de Web Mercator.
 *
 * `y` va de 0 (latitud +85.0511, arriba) a `worldSize` (abajo). El `sinh` es la
 * inversa de la proyeccion: sin el, la caja sale corrida y el mapa pide lugares
 * que no ve.
 */
function latFromY(y: number, worldSize: number): number {
  const n = Math.PI * (1 - (2 * y) / worldSize)
  return (Math.atan(Math.sinh(n)) * 180) / Math.PI
}

/**
 * Caja que cubre la vista, con un margen.
 *
 * La proyeccion es Web Mercator (la de Leaflet por defecto), que tiene dos
 * consecuencias que hay que tener presentes:
 *
 *   - Los grados de LONGITUD por pixel son constantes en toda la altura. La
 *     proyeccion es conforme: preserva angulos. Por eso el ancho de la caja se
 *     calcula sin ningun factor de latitud.
 *   - Los grados de LATITUD por pixel se COMPRIMEN hacia los polos. Por eso el
 *     alto se saca de la proyeccion y no de una division simple.
 *
 * Confundir las dos cosas produce el error clasico: poner un `cos(lat)` en
 * el ancho. Se ve "bien" en Buenos Aires y trae una caja 20% mas ancha de lo
 * necesario, que no rompe nada visible, asi que pasa desapercibida. El error
 * inverso, olvidarse de comprimir la latitud, si se nota: en el norte la caja
 * se queda corta y faltan lugares que el usuario tiene en pantalla.
 *
 * Y despues esta el recorte contra los topes de amplitud de la API, que es la
 * parte que hace que esta funcion no se pueda "simplificar" a una cuenta de
 * grados por pixel sin que el mapa deje de cargar al hacer zoom out.
 */

export function buildBbox(
  center: LatLng,
  zoom: number,
  opts: { margin?: number; viewportPx?: number } = {},
): Bbox {
  const viewportPx = opts.viewportPx ?? DEFAULT_VIEWPORT_PX
  const z = Math.max(0, Math.min(MAX_ZOOM, Math.round(zoom)))
  const worldSize = TILE_SIZE * Math.pow(2, z)

  // El margen no es cosmetico: sin el, un lugar que cae justo en el borde de la
  // pantalla entra y sale segun el redondeo del subpixel, y el mapa parpadea al
  // arrastrar. Tambien absorbe el error de no saber el ancho real del viewport.
  const margin = opts.margin ?? 0.2
  const halfW = (viewportPx / 2) * (1 + margin * 2)
  const halfH = (viewportPx / 2) * (1 + margin * 2)

  // Longitud: uniforme, lineal.
  let minLng = center.lng - (halfW / worldSize) * 360
  let maxLng = center.lng + (halfW / worldSize) * 360

  // Latitud: a traves de la proyeccion.
  const yCenter = mercatorY(center.lat, worldSize)
  let minLat = latFromY(yCenter + halfH, worldSize)
  let maxLat = latFromY(yCenter - halfH, worldSize)

  // Ajuste a los limites de la API, que son MAS ESTRECHOS que el planeta.
  //
  // Con zoom bajo la caja teorica cubre el mundo entero, y `parseBbox` la
  // rechaza con 400. El sintoma en la pagina es un mapa que no carga nada
  // despues de hacer zoom out, sin ninguna relacion aparente con la causa.
  //
  // El recorte se recentra en el punto que el usuario esta mirando, y NO se
  // encoge desde los dos bordes. Encoger simetricamente en grados esta mal por
  // una razon que no se ve: la caja de Mercator es simetrica en `y`, no en
  // grados de latitud, asi que restar la misma cantidad de los dos bordes
  // desplaza el centro. El resultado es una caja del ancho correcto pegada al
  // ecuador, con el lugar que el usuario mira fuera de ella. Encoger desde el
  // centro del usuario es lo unico que responde a la pregunta que se esta
  // haciendo: "que hay alrededor de donde estoy mirando".
  const lngSpan = lngSpanOf(minLng, maxLng)
  if (lngSpan > MAX_LNG_SPAN) {
    // La longitud es uniforme en Mercator, asi que el centro en grados es el
    // promedio, y alcanza con media amplitud a cada lado.
    const half = MAX_LNG_SPAN / 2 - EPS
    minLng = center.lng - half
    maxLng = center.lng + half
  }

  const latSpan = maxLat - minLat
  if (latSpan > MAX_LAT_SPAN) {
    // El `- EPS` no es cosmetico: `center.lat - 15` y `center.lat + 15` no
    // siempre dan un span de exactamente 30. Con centro en -75, la diferencia
    // da 30.000000000000004, que es mas que 30, y `parseBbox` responde 400 a
    // una caja perfectamente valida. Un epsilon de 1e-9 grados son 0.1
    // milimetros: invisible, y alcanza para absorber el redondeo de IEEE 754.
    const half = MAX_LAT_SPAN / 2 - EPS
    minLat = center.lat - half
    maxLat = center.lat + half
  }

  return {
    minLng: clampLng(minLng),
    minLat: Math.max(-90, minLat),
    maxLng: clampLng(maxLng),
    maxLat: Math.min(90, maxLat),
  }
}

/**
 * Recorta la longitud a [-180, 180] preservando la direccion.
 *
 * Un `Math.max/min` a secas rompe el orden de la caja cerca del antimeridiano:
 * si `minLng` baja de -180 y `maxLng` sube de 180, recortarlos por separado
 * invierte la caja y `parseBbox` la rechaza por tener `minLng > maxLng` cuando
 * en realidad esta cruzando el meridiano.
 */
function clampLng(lng: number): number {
  if (lng >= -180 && lng <= 180) return lng
  const wrapped = ((((lng + 180) % 360) + 360) % 360) - 180
  return wrapped
}

/** Longitud total de una caja, sumando las dos partes si cruza el meridiano. */
function lngSpanOf(minLng: number, maxLng: number): number {
  return minLng <= maxLng ? maxLng - minLng : 180 - minLng + (maxLng + 180)
}

function mercatorY(lat: number, worldSize: number): number {
  const rad = (Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI) / 180
  const y = Math.log(Math.tan(Math.PI / 4 + rad / 2))
  return ((1 - y / Math.PI) / 2) * worldSize
}

/**
 * Comparacion con tolerancia.
 *
 * El `onMove` de Leaflet dispara en cada pixel de arrastre, y las coordenadas
 * que devuelve vienen redondeadas desde el modelo proyectado. Comparar con `===`
 * da "cambio" en casi todos los eventos, y eso significa consultar en cada
 * pixel mientras se arrastra. La tolerancia es la de un metro mas o menos, que
 * es el ruido del redondeo y no un movimiento real del mapa.
 */
export function isSameBbox(a: Bbox, b: Bbox, eps = 1e-6): boolean {
  return (
    Math.abs(a.minLat - b.minLat) < eps &&
    Math.abs(a.maxLat - b.maxLat) < eps &&
    Math.abs(a.minLng - b.minLng) < eps &&
    Math.abs(a.maxLng - b.maxLng) < eps
  )
}
