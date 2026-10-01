/**
 * Consulta de lugares para el mapa.
 *
 * Sin imports de Next: este modulo lo usan tanto la API como los tests.
 */
import { getPrisma } from './db'
import type { PlaceCategory, PlaceVerificationStatus, PriceLevel, Prisma } from '@prisma/client'
import type { Bbox } from './validation'

/**
 * Un plan cuenta como "abierto" si esta OPEN, no fue borrado, y todavia no
 * empezo. Un plan que ya arranco no es una invitacion: al mapa no le sirve y a
 * quien lo mira lo confunde.
 *
 * Es una FUNCION y no una constante a proposito. Con `{ gt: new Date() }`
 * evaluado al importar el modulo, el instante queda congelado en el arranque del
 * proceso: un plan que empieza dos horas despues de que el server levanto
 * contaria como abierto para siempre, y el mapa anunciaria planes que ya
 * ocurrieron. En un proceso de larga vida eso es un bug de datos, no un
 * detalle de performance.
 */
function openPlanFilter(now = new Date()) {
  return {
    status: 'OPEN' as const,
    deletedAt: null,
    startsAt: { gt: now },
  }
}

export type PlaceFeature = {
  id: string
  name: string
  description: string | null
  category: string
  priceLevel: string
  latitude: number
  longitude: number
  openPlanCount: number
}

/**
 * Lugares dentro de un rectangulo, con la cantidad de planes abiertos.
 *
 * La consulta filtra por caja y no trae todo: un mapa se panea, y cada paneo
 * pide lo que entra en pantalla. El indice `[latitude, longitude]` cubre
 * exactamente este acceso, con `latitude` como columna leader, que es la que
 * se acota de forma mas selectiva en la mayoria de los movimientos de mapa.
 *
 * `isCurator` no cambia que lugares se devuelven, solo si se incluyen los que
 * aun no fueron revisados. Ver `visibleWhere`.
 */
export async function findPlacesInBbox(
  bbox: Bbox,
  filters: { category?: string; priceLevel?: string } = {},
  opts: { isCurator?: boolean } = {},
): Promise<PlaceFeature[]> {
  const rows = await getPrisma().place.findMany({
    where: {
      ...visibleWhere(opts.isCurator ?? false),
      ...categoryFilter(filters.category),
      ...priceFilter(filters.priceLevel),
      // Prisma traduce esto a un rango sobre el indice `[latitude, longitude]`,
      // con `latitude` como columna leader: es la que se acota de forma mas
      // selectiva en la mayoria de los movimientos de mapa.
      //
      // Los limites son INCLUSIVOS, igual que `between`. Un lugar exactamente
      // sobre el borde aparece en dos cajas adyacentes. Es el comportamiento
      // esperable de un mapa y no un bug; el cliente deduplica por id si hace
      // falta. Lo que si seria un bug es excluir el borde con `lt`/`gt`.
      latitude: { gte: bbox.minLat, lte: bbox.maxLat },
      ...longitudeFilter(bbox),
    },
    select: PLACE_SELECT,
    orderBy: { name: 'asc' },
    take: 500,
  })

  return rows.map(toFeature)
}

/**
 * El `select` de un lugar, compartido por el mapa y por la busqueda.
 *
 * Vive aca y no duplicado en cada consulta por el mismo motivo que los filtros:
 * si el mapa empieza a devolver un campo y la busqueda no, el selector de
 * lugares deja de compilar o peor, muestra un `undefined` en un lugar. Y el
 * `_count` con subquery tiene que ser identico en las dos para que
 * `openPlanCount` signifique lo mismo en cada pantalla.
 */
const PLACE_SELECT = {
  id: true,
  name: true,
  description: true,
  category: true,
  priceLevel: true,
  latitude: true,
  longitude: true,
  _count: { select: { plans: { where: openPlanFilter() } } },
} as const

/**
 * `latitude` y `longitude` son `Decimal` en Prisma porque en el schema son
 * `Decimal`. Si se devolvieran como `Decimal` en el JSON, el cliente recibe un
 * objeto en vez de un numero y el mapa no lo puede usar; por eso el `Number`.
 * El mismo motivo hace que el tipo publico declare `number`: el que consume la
 * API nunca deberia tener que saber que adentro hubo un Decimal.
 */
function toFeature(p: {
  id: string
  name: string
  description: string | null
  category: string
  priceLevel: string
  latitude: unknown
  longitude: unknown
  _count: { plans: number }
}): PlaceFeature {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    category: p.category,
    priceLevel: p.priceLevel,
    latitude: Number(p.latitude),
    longitude: Number(p.longitude),
    openPlanCount: p._count.plans,
  }
}

/**
 * Regla de "aca se puede crear un plan", que es MAS ESTRICTA que
 * `visiblePlaceWhere`.
 *
 * No es lo mismo "este lugar se puede ver" que "este lugar admite un plan nuevo",
 * y por eso son dos funciones y no una con un flag:
 *
 *   - `visiblePlaceWhere` responde a la pregunta de DESCUBRIMIENTO, y por eso un
 *     curador ve los `PENDING`: para revisar necesita verlos.
 *   - Esta responde a la de COMPROMISO. Un plan es una cita con gente, y la
 *     garantia que importa es que el lugar cumple los criterios de seguridad y
 *     vigencia. Un curador no puede crear un plan en un lugar que todavia no
 *     aprueba, ni aunque tenga el rol para verlo: el rol le da visibilidad,
 *     no permiso.
 *
 * Es mas estricta tambien en `isActive` y `deletedAt`, que son los mismos en las
 * dos, pero se repiten para que cada filtro se lea solo.
 *
 * DECISION DE PRODUCTO (ver `docs/decisiones-auth.md`): un lugar que deja de
 * estar `APPROVED` NO cancela los planes que ya tiene. Cierra la puerta a planes
 * nuevos y a joiners nuevos, y no toca los existentes. El razonamiento completo
 * esta en la seccion 12 de ese documento; el resumen es que no hay canal de
 * notificacion, asi que un cancel automatico silencioso deja gente presentada a
 * un plan que se cancelo sin que nadie le dijera.
 */
export function planablePlaceWhere(): Prisma.PlaceWhereInput {
  return {
    verificationStatus: 'APPROVED',
    isActive: true,
    deletedAt: null,
  }
}

function visibleWhere(isCurator: boolean) {
  return visiblePlaceWhere(isCurator)
}

/**
 * Exportada para que el listado de planes use la MISMA regla y no una copia.
 * Duplicar este filtro es la forma mas facil de que el mapa y el listado
 * discrepen sobre que es visible, y que nadie se entere hasta que un curador
 * vea un lugar en un panel y no en el otro.
 */
/**
 * Regla de visibilidad. Esta es la linea que separa "explorar" de "filtrar la
 * moderacion de otra gente", asi que va explicada.
 *
 * Para cualquiera que no sea curador: solo `APPROVED`. Un lugar `PENDING` es
 * un lugar que alguien propuso y nadie reviso todavia; mostrarlo en un mapa
 * publico lo convierte en un lugar. Un `REJECTED` es peor: es algo que se
 * decidio que no va, y publicarlo seria mostrar el proceso interno de
 * curaduria.
 *
 * Para curadores y admin: tambien los `PENDING`, que es justamente su trabajo.
 *
 * `isActive` y `deletedAt` se filtran siempre, sin importar el rol: un lugar
 * desactivado esta fuera de circulacion.
 *
 * Exportada por el mismo motivo que `bboxLongitudeFilter`: el mapa, el listado de
 * planes y la busqueda por nombre tienen que discrepar NUNCA sobre que es
 * visible, y tres copias de un filtro divergen.
 */
export function visiblePlaceWhere(isCurator: boolean) {
  const base = { isActive: true, deletedAt: null } as const
  // El array necesita el tipo explicito: sin el, TS lo infiere como
  // `string[]` y el filtro no es asignable al enum, que es un error de tipos
  // parado en un lugar donde el filtro parece correcto.
  const visibleStatuses: PlaceVerificationStatus[] = isCurator
    ? ['PENDING', 'APPROVED']
    : ['APPROVED']
  return { ...base, verificationStatus: { in: visibleStatuses } }
}

/**
 * Los filtros de la query string entran como `string` y salen como el enum de
 * Prisma. El route handler ya los valido contra la lista cerrada, y el tipo lo
 * confirma con un cast acotado en vez de `as never`.
 *
 * `as never` compila siempre y por eso no sirve para nada aca: apagaria el
 * chequeo de tipos sin agregar seguridad. El cast real, sobre un solo valor,
 * falla si el enum cambia y el filtro se queda viejo.
 */
function categoryFilter(category?: string) {
  return category ? { category: category as PlaceCategory } : {}
}

function priceFilter(priceLevel?: string) {
  return priceLevel ? { priceLevel: priceLevel as PriceLevel } : {}
}

/**
 * Longitude a traves del antimeridiano.
 *
 * Una caja que cruza el meridiano 180 viene con `minLng > maxLng` (por
 * ejemplo, un paneo que muestra a la vez el este de Japon y el oeste de
 * Alaska). Un `AND longitude BETWEEN maxLng AND minLng` no devuelve nada, y el
 * mapa aparece vacio sin ninguna pista de por que.
 *
 * Se parte en dos rangos con un OR en lugar de ampliar la caja a la vuelta
 * entera del planeta, que traeria los lugares del mundo entero.
 */
function longitudeFilter(bbox: Bbox) {
  return bboxLongitudeFilter(bbox)
}

/**
 * Exportada por el mismo motivo que `visiblePlaceWhere`: el antimeridiano es
 * logica, no formato, y dos copias divergen.
 */
export function bboxLongitudeFilter(bbox: Bbox) {
  if (bbox.minLng <= bbox.maxLng) {
    return { longitude: { gte: bbox.minLng, lte: bbox.maxLng } }
  }
  return {
    OR: [
      { longitude: { gte: bbox.minLng, lte: 180 } },
      { longitude: { gte: -180, lte: bbox.maxLng } },
    ],
  }
}

/**
 * Cuantos lugares trae la busqueda por nombre.
 *
 * Es un tope, y por lo tanto es visible: `searchPlaces` devuelve `total` y
 * `truncated` para que la pantalla pueda decir "20 de 57" en vez de mostrar 20
 * resultados y dejar que el usuario crea que son todos.
 *
 * Esto es una correccion deliberada de como funciona `findPlacesInBbox`, que
 * hace `take: 500` sin decir nada. Alli el tope se tolera porque el limite es el
 * viewport: lo que queda fuera esta, por definicion, fuera de pantalla. En un
 * selector de lugares para crear un plan NO hay viewport, y un tope invisible
 * convierte "tu lugar no aparece" en un bug que el usuario no puede
 * diagnosticar: busca, no lo encuentra, y no hay nada en la pantalla que
 * explique por que.
 */
export const PLACE_SEARCH_LIMIT = 20

/**
 * Un resultado de busqueda, con lo que se sabe del total.
 *
 * `total` es la cantidad real de lugares que matchean, antes del tope. Es la
 * diferencia entre "no hay resultados" y "hay 57, te muestro 20".
 */
export type PlaceSearchResult = {
  places: PlaceFeature[]
  total: number
  truncated: boolean
}

/**
 * Lugares por nombre, para elegir donde hacer un plan.
 *
 * Tres diferencias con `findPlacesInBbox`, y las tres son a proposito:
 *   1. **No hay caja.** Se busca sobre toda la base, no sobre un rectangulo: el
 *      host sabe el lugar por nombre, no por donde esta en el mapa.
 *   2. **Case-insensitive, NO accent-insensitive.** `mode: 'insensitive'` resuelve
 *      "cafe" contra "Cafe Tortuga", pero `Café Tortuga` sigue sin aparecer si se
 *      busca "cafe". plegar acentos necesita `unaccent()` o una columna
 *      normalizada, o sea una migracion. Los datos del proyecto hoy son sin
 *      acentos, asi que no se nota; queda anotado como deuda, no escondido.
 *   3. **Orden alfabetico, con una consecuencia conocida.** Buscar "cafe"
 *      muestra "Cafe Bar", "Cafe Tortuga" y "Cafeteria La Ideal" en ese orden, y
 *      el primero no es el que el usuario probablemente buscaba. Rankear por
 *      prefijo de verdad (`ORDER BY CASE WHEN name ILIKE 'q%' THEN 0 ELSE 1 END`)
 *      necesita SQL crudo, y perder el `_count` con subquery de Prisma. No esta
 *      justificado todavia; queda anotado como deuda junto con el
 *      accent-insensitive.
 *
 * El conteo y la lista van en la MISMA transaccion. Con dos consultas sueltas,
 * un lugar curado entre medio hace que `total` y `places` se contradigan: el
 * cliente muestra "3 de 5" con 3 filas y no hay forma de saber cual de los dos
 * numeros es el menor.
 */

export async function searchPlaces(
  q: string,
  filters: { category?: string; priceLevel?: string } = {},
  opts: { isCurator?: boolean; limit?: number; planableOnly?: boolean } = {},
): Promise<PlaceSearchResult> {
  const limit = opts.limit ?? PLACE_SEARCH_LIMIT
  // `planableOnly` cambia QUE lugares, no solo cuantos: son los que aceptan un
  // plan nuevo. El mapa y la busqueda publica usan `visibleWhere`; el selector
  // del formulario de creacion usa esta, porque ofrecer un lugar que el POST
  // va a rechazar es una trampa: el host completa todo el formulario y se
  // entera al final, con un 404 y sin saber cual de los dos lados mintio.
  const where = {
    ...(opts.planableOnly ? planablePlaceWhere() : visibleWhere(opts.isCurator ?? false)),
    ...categoryFilter(filters.category),
    ...priceFilter(filters.priceLevel),
    name: { contains: q, mode: 'insensitive' as const },
  }

  const [total, rows] = await getPrisma().$transaction([
    getPrisma().place.count({ where }),
    getPrisma().place.findMany({
      where,
      select: PLACE_SELECT,
      // Alfabetico, que es lo que Prisma puede ordenar sin SQL crudo. Ver el
      // punto 3 del comentario de arriba: la consequence es que el lugar mas
      // corto no siempre es el primero, y queda anotada como deuda.
      orderBy: { name: 'asc' },
      take: limit,
    }),
  ])

  return {
    places: rows.map(toFeature),
    total,
    truncated: total > rows.length,
  }
}

export type { Bbox }
