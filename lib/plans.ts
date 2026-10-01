/**
 * Consulta de planes para la vista de exploracion.
 *
 * Sin imports de Next, como `lib/places.ts`: lo usan la API y los tests.
 */
import { getPrisma } from './db'
import { bboxLongitudeFilter, visiblePlaceWhere } from './places'
import type { Bbox } from './validation'
import type { PlaceCategoryValue } from './enums'
import type { ParticipationStatus } from '@prisma/client'

/**
 * Estado de un plan. Es el enum de Prisma, escrito aca para que el cliente lo
 * pueda usar sin importar el cliente generado.
 *
 * El endpoint del detalle ANOTA su respuesta con `PlanDetail`, asi que agregar un
 * estado en el schema rompe el build hasta que se agregue aca. Eso y el test de
 * sincronia contra Prisma apuntan al mismo lugar: la lista cerrada no puede
 * quedar vieja sin que algo se rompa.
 */
export type PlanStatusValue = 'OPEN' | 'CANCELLED' | 'COMPLETED'

/**
 * Que se ve de un plan en el listado.
 *
 * El listado EXIGE SESION (a diferencia de los lugares, que son publicos), y
 * aun asi NO trae la lista de participantes. El detalle de cada plan los trae,
 * tambien con sesion, pero una pantalla con 20 resultados no necesita 20 listas
 * de gente: lo que necesita es saber si el plan va, y cuantos lugares hay.
 *
 * Lo que NO puede aparecer aca, aunque haya sesion: emails, y el historial de
 * reliability de terceros (`lib/reliability.ts`). El reliability es del
 * organizador y vive en `/api/plans/[id]/requests`.
 */
export type PlanSummary = {
  id: string
  title: string
  description: string | null
  startsAt: string
  endsAt: string | null
  capacity: number
  acceptedCount: number
  /** Positivo o cero. Nunca negativo: si el contador se pasara, es un bug. */
  remainingSpots: number
  status: PlanStatusValue
  isFull: boolean
  place: {
    id: string
    name: string
    category: PlaceCategoryValue
    latitude: number
    longitude: number
  }
  creator: { id: string; name: string }
  /**
   * Estado de QUIEN ESTA MIRANDO, no de los demas. Es lo unico que depende del
   * viewer en esta respuesta, y se calcula en el servidor: el cliente no tiene
   * que inferirlo de los participantes.
   */
  viewer: {
    isCreator: boolean
    /**
     * `status` es `ParticipationStatus` y no `string` a proposito. Con `string`,
     * el gate del chat (`puedeUsarChat`) recibia cualquier cosa y habia que
     * castear: el tipo debil hace que un estado mal escrito pase el typecheck y
     * termine en un `includes` que devuelve `false` sin avisar, o sea el chat
     * disappears en runtime y no en el build. `role` sigue en `string` porque
     * ningun gate depende de el todavia.
     */
    participation: null | { status: ParticipationStatus; role: string }
  }
}

/**
 * Lo que ve un plan en su detalle, que es el listado MAS los confirmados.
 *
 * Es `PlanSummary` con un campo mas, y a proposito: las dos pantallas comparten
 * todo lo demas, asi que la unica forma de que el mapa y el detalle discrepen
 * sobre el plan (cupos, fullness, estado del viewer) es que se escriba el campo
 * en los dos lados.
 *
 * El endpoint ANOTA lo que devuelve con este tipo, y la pagina importa este
 * tipo. Eso convierte el `{ plan: ... }` del servidor y el `setPlan` del
 * cliente en la misma forma: renombrar un campo rompe los dos compilados a la
 * vez, en vez de dejar al cliente leyendo `undefined` en pantalla.
 */
export type PlanDetail = PlanSummary & {
  /**
   * Los que tienen (o tuvieron) lugar en el plan.
   *
   * `status` viene **solo para el organizador** y es `null` para el resto, y no
   * por descuido de la query sino por una decision: la lista de quien no vino
   * es contabilidad privada del organizador. Publicar "Ana no vino" en la
   * pantalla del plan es exactamente el juicio social entre personas que el
   * producto existe para eliminar, y es peor que un `DECLINED` — que al menos
   * no esta entre los confirmados.
   *
   * Por eso el endpoint trae el status de todos y lo borra en la respuesta: una
   * consulta sola, y el borrado en un solo lugar que un test puede fijar.
   *
   * Para todos: solo `ACCEPTED` y `ATTENDED`, mas `NO_SHOW` unicamente cuando el
   * viewer organiza (si no, se filtra de la lista entera). Un `REQUESTED` todavia
   * no se sabe si va, y un `DECLINED` no va a ESTE plan: sigue siendo usuario del
   * lugar.
   */
  participants: {
    user: { id: string; name: string }
    role: string
    /** `null` = "no te toca saberlo". No es "estado desconocido". */
    status: ParticipationStatus | null
  }[]
  /**
   * Las calificaciones de la experiencia, con tres niveles de detalle.
   *
   * `count`/`average` son para cualquiera que abra el plan, y son anonimos a
   * proposito: el promedio es la senal de si el lugar valio la pena, sin exponer
   * quien dijo que no. `mine` es el voto de quien mira, para que el formulario
   * se pueda precargar y no haga falta acordarse de lo que puso. `detail` con
   * nombre y etiquetas es **solo del organizador**, que es quien organizo y
   * tiene feedback que leer; el `null` es "no te toca", igual que arriba.
   *
   * `tags` son ids de `ETIQUETAS_EXPERIENCIA`, nunca texto. Vienen como ids y
   * no como el label para que el cliente no tenga el criterio de traducción, y
   * para que cambiar el texto de una etiqueta no cambie lo guardado.
   *
   * Lo que NO esta y es la proxima pantalla: el promedio del LUGAR, agregado
   * a traves de los planes de ese lugar. Es lo que quiere §5.9, y es otro corte.
   */
  ratings: {
    count: number
    average: number | null
    mine: { rating: number; tags: string[]; updatedAt: string } | null
    /**
     * Que se marco mas veces, ordenado, **anonimo**.
     *
     * Es el mismo criterio que `average`: un conteo agregado no expone a quien
     * marcos que, y "el 80% dice buena comida" es informacion que el siguiente
     * que va puede usar sin que nadie quede expuesto. Sin las etiquetas, quien
     * califica no tiene forma de decir por que dio las estrellas que dio, y el
     * promedio queda como un numero sin explicación.
     */
    tags: { id: string; count: number }[]
    detail: {
      user: { id: string; name: string }
      rating: number
      tags: string[]
      createdAt: string
    }[] | null
  }
}

/**
 * Planes futuros dentro de una caja, para alguien con sesion.
 *
 * Filtra por el LUGAR y no por el plan: el indice `[latitude, longitude]` esta
 * en `Place`, asi que acotar por ahi es lo que hace que la consulta use indice.
 * Un plan es visible si su lugar es visible, con la misma regla de curaduria
 * que el mapa.
 *
 * Solo planes `OPEN` y que todavia no empezaron. Un plan `CANCELLED` no es una
 * invitacion, y uno que ya arranco ya no se puede unir.
 */
export async function findPlansInBbox(
  bbox: Bbox,
  viewer: { userId: string; isCurator: boolean },
  opts: { limit?: number } = {},
): Promise<PlanSummary[]> {
  const now = new Date()

  const rows = await getPrisma().plan.findMany({
    where: {
      deletedAt: null,
      status: 'OPEN',
      startsAt: { gt: now },
      place: {
        ...visiblePlaceWhere(viewer.isCurator),
        // Mismo criterio de borde que `findPlacesInBbox`: limites INCLUSIVOS, y
        // el antimeridiano partido en dos rangos por `bboxLongitudeFilter`.
        latitude: { gte: bbox.minLat, lte: bbox.maxLat },
        ...bboxLongitudeFilter(bbox),
      },
    },
    select: {
      id: true,
      title: true,
      description: true,
      startsAt: true,
      endsAt: true,
      capacity: true,
      acceptedCount: true,
      status: true,
      place: {
        select: { id: true, name: true, category: true, latitude: true, longitude: true },
      },
      creator: { select: { id: true, name: true } },
      participants: {
        where: { userId: viewer.userId },
        select: { status: true, role: true },
      },
    },
    orderBy: { startsAt: 'asc' },
    take: opts.limit ?? 100,
  })

  return rows.map((p) => {
    // La participacion del viewer es lo unico que puede haber en la lista: el
    // filtro de arriba la limita a el, asi que `participants` tiene 0 o 1 fila.
    const mine = p.participants[0] ?? null
    const remaining = Math.max(0, p.capacity - p.acceptedCount)
    return {
      id: p.id,
      title: p.title,
      description: p.description,
      startsAt: p.startsAt.toISOString(),
      endsAt: p.endsAt ? p.endsAt.toISOString() : null,
      capacity: p.capacity,
      acceptedCount: p.acceptedCount,
      remainingSpots: remaining,
      status: p.status,
      isFull: remaining === 0,
      place: {
        id: p.place.id,
        name: p.place.name,
        category: p.place.category,
        latitude: Number(p.place.latitude),
        longitude: Number(p.place.longitude),
      },
      creator: { id: p.creator.id, name: p.creator.name },
      viewer: {
        isCreator: p.creator.id === viewer.userId,
        participation: mine ? { status: mine.status, role: mine.role } : null,
      },
    }
  })
}

/**
 * Reexportado para que el route handler no tenga que importar de dos lugares.
 */
export { bboxLongitudeFilter }
