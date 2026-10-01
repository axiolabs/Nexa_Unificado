/**
 * Configuracion de teselas del mapa.
 *
 * Existe como modulo separado, y no inline en el componente, por una sola
 * razon: cambiar de proveedor de teselas tiene que ser editar este archivo.
 * Cuando haga falta, el resto del mapa no se toca.
 *
 * DEUDA TECNICA CON DISPARADOR EXPLICITO
 * ---------------------------------------
 * Las teselas de OpenStreetMap son gratuitas y sin API key, pero su politica de
 * uso NO permite trafico alto ni uso comercial intensivo. Hoy no hay trafico,
 * asi que es la eleccion correcta: cero costo y cero configuracion.
 *
 * DISPARADOR: migrar a un proveedor pagado (MapTiler, Mapbox, Stadia, o el
 * que seija el equipo) ANTES de subir trafico de produccion. No despues.
 *
 * La razon de que el disparador sea "antes" y no "cuando duela": el sintoma de
 * no haberlo hecho a tiempo es un bloqueo de IP desde OSM en produccion, que
 * no se negocia ni se avisa con antelacion. Es de los pocos casos en que
 * "antes de que crezca" es mas barato que "cuando crezca".
 *
 * Migrar es: cambiar `TILE_URL`, `ATTRIBUTION` y `MAX_ZOOM` aca. Si el nuevo
 * proveedor necesita API key, va en `.env` (`NEXT_PUBLIC_TILE_URL`), no en el
 * codigo, y se lee en `resolveTileConfig()`.
 */

/**
 * Atribucion obligatoria.
 *
 * La politica de OSM pide "OpenStreetMap contributors", no "OpenStreetMap": la
 * diferencia es una palabra y es justamente la palabra que hace legal el uso.
 * Con el link a la pagina de copyright, que es lo segundo que la politica pide.
 */
export const OSM_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>'

export type TileConfig = {
  url: string
  attribution: string
  maxZoom: number
}

const DEFAULT_TILE: TileConfig = {
  url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  attribution: OSM_ATTRIBUTION,
  // 19 es el maximo de OSM. Pedir mas devuelve 404 y las teselas salen en
  // blanco, que es el sintoma clasico de "el mapa no carga en mi zona".
  maxZoom: 19,
}

/**
 * Permite sobreescribir la URL por entorno sin recompilar, que es lo que hace
 * falta el dia del cambio a proveedor pago: se cambia la variable en el
 * deploy, no se saca un PR.
 */
export function resolveTileConfig(): TileConfig {
  const override = process.env.NEXT_PUBLIC_TILE_URL
  const attribution = process.env.NEXT_PUBLIC_TILE_ATTRIBUTION
  if (!override) return DEFAULT_TILE
  return {
    url: override,
    attribution: attribution ?? OSM_ATTRIBUTION,
    maxZoom: DEFAULT_TILE.maxZoom,
  }
}

/**
 * Centro del mapa al abrir /explore.
 *
 * Es Manizales porque es la ciudad que el producto tiene en la cabeza, y por
 * coherencia con el seed: si esto fuera otra ciudad y el seed sembrara lugares
 * de esta, el mapa abriria en un vacio y pareceria que no hay nada.
 *
 * Este valor solo define de donde se mira la primera vez. NO acota el mapa: el
 * `bbox` sigue siendo libre y se puede mover a cualquier lado, a proposito. La
 * decision de "esto es de Manizales" se aplica con el filtro de ciudad, no
 * encerrando el mapa: encerrarlo obliga a validar cada escritura de lugar y
 * deja de ser un cambio de coordenadas.
 */
export const DEFAULT_CENTER = { lat: 5.0703, lng: -75.5183 }
export const DEFAULT_ZOOM = 13
