import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth/session'
import { isCurator } from '@/lib/auth/guard'
import { getPrisma } from '@/lib/db'
import { fail } from '@/lib/http'
import { visiblePlaceWhere } from '@/lib/places'
import type { PlanDetail } from '@/lib/plans'
import { promedioDe, tallyDe } from '@/lib/ratings'

/**
 * GET /api/plans/[planId]
 *
 * EXIGE SESION, y esa es la parte deliberada de este endpoint.
 *
 * El mapa y los lugares son publicos. El detalle de un plan no. Un plan lleva
 * hora, lugar, organizador y lista de participantes, y publicarlo sin sesion
 * arma una agenda de la vida social de gente que no publico nada: "este sabado
 * a las 20:00 hay 4 personas en este bar" es informacion sobre la vida de
 * otras personas, entregada a cualquiera que sepa consultar una API.
 *
 * Por eso el corte esta aca y no en el cliente. Ocultar el link no alcanza.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ planId: string }> }) {
  const gate = await requireUser()
  if (!gate.ok) {
    return NextResponse.json({ error: gate.error }, { status: gate.status })
  }

  const { planId } = await ctx.params
  const viewerId = gate.user.id
  const curator = isCurator(gate.user.roles)

  const plan = await getPrisma().plan.findFirst({
    // `findFirst` y no `findUnique`: el filtro de `deletedAt` es lo que
    // distingue un plan vivo de uno borrado, y `findUnique` solo acepta el id.
    where: {
      id: planId,
      deletedAt: null,
      // `OR` de tres ramas, y no solo la primera. La primera es
      // `visiblePlaceWhere`, la MISMA del listado: este detalle es a donde se
      // navega desde el mapa, asi que si el listado muestra un plan y el detalle
      // da 404, hay un link que no lleva a ningun lado. Y al reves, sin este
      // filtro, un plan cuyo lugar dejo de estar visible se seguia abriendo por
      // URL con el boton "unirme" pintado, y el 409 de §12 aparecia recien
      // despues del click.
      //
      // Las otras dos son la excepcion, y van porque §12 decidio que un lugar
      // que deja de estar disponible NO cancela los planes que ya tiene. Si el
      // filtro se aplicara igual, el organizador y los confirmados perderian el
      // detalle de su propio plan: la URL guardada daria 404, igual que si el
      // plan nunca hubiera existido, sin un mensaje que explique por que. Eso
      // es el mismo dano que cancelar, pero en silencio, que es justo lo que §12
      // queria evitar.
      //
      // La excepcion protege a quien YA INVIERTIO algo: el que organiza y el que
      // tiene lugar guardado. No a quien todavia no llego, que sigue el filtro
      // del mapa y no ve nada. Mismo criterio que el resto del proyecto.
      OR: [
        { place: visiblePlaceWhere(curator) },
        { creatorId: viewerId },
        { participants: { some: { userId: viewerId, status: { in: ['ACCEPTED', 'ATTENDED'] } } } },
      ],
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
        // Los tres que tuvieron o tienen lugar, y el corte de `NO_SHOW` para el
        // resto se hace abajo, en la respuesta. Traerlo y borrarlo es preferible
        // a una segunda consulta: el `where` depende de si el viewer organiza, y
        // eso no se sabe hasta que esta misma query devuelve el `creator`.
        where: { status: { in: ['ACCEPTED', 'ATTENDED', 'NO_SHOW'] } },
        select: { user: { select: { id: true, name: true } }, role: true, status: true },
        orderBy: { joinedAt: 'asc' },
      },
      ratings: {
        // Todo el set es chico (una fila por persona del plan, o sea del orden de
        // `capacity`), as que se trae entero y se decide que se publica en la
        // respuesta, en vez de dos queries con `count` y `sum` que ademas no
        // se puede hacer sin perder el redondeo a un decimal.
        select: {
          authorId: true,
          rating: true,
          tags: true,
          createdAt: true,
          updatedAt: true,
          author: { select: { name: true } },
        },
        orderBy: { createdAt: 'asc' },
      },
    },
  })

  if (!plan) return fail(404, 'Plan no encontrado')

  // La fila del viewer va en una consulta aparte, y no es pereza.
  //
  // El listado resuelve lo mismo en la misma query filtrando `participants` por
  // `userId`. Acá no se puede: esta respuesta necesita TAMBIEN la lista de los
  // confirmados, o sea dos lecturas de la misma relacion con `where` distintos, y
  // `select` de Prisma no admite repetir una clave ni aliasearla. La primera
  // version de esto metio un `mine` que no existe y no compilo.
  //
  // Sale una consulta indexada por el PK compuesto [planId, userId], que es
  // justo el indice que ya existe para frenar el doble join.
  const mine = await getPrisma().planParticipant.findUnique({
    where: { planId_userId: { planId, userId: viewerId } },
    select: { status: true, role: true },
  })

  // `place` se destructura en vez de quedar dentro del spread: sus coordenadas
  // son `Decimal` de Prisma y un Decimal crudo dentro del JSON se serializa
  // como {"s":...,"e":...,"f":...}, no como numero.
  const { place, participants, ratings, startsAt, endsAt, ...rest } = plan
  const remaining = Math.max(0, plan.capacity - plan.acceptedCount)
  const esCreador = plan.creator.id === viewerId

  /*
   * Lo que se publica, que no es lo que se consulto.
   *
   * Las dos listas se filtran acá y no en el `where` de la query porque dependen
   * de si el viewer organiza, y eso recien se sabe con el resultado de la misma
   * consulta. Se podria hacer con dos consultas; se hace con una y un `map`, y
   * el borrado queda en un solo lugar visible.
   */
  const participantesPublicos = participants
    // A quien no organiza no le corresponde saber quien no vino: no solo se le
    // oculta el `status`, la persona directamente no aparece en la lista.
    .filter((p) => esCreador || p.status !== 'NO_SHOW')
    .map((p) => ({
      user: p.user,
      role: p.role,
      status: esCreador ? p.status : null,
    }))

  const mio = ratings.find((r) => r.authorId === viewerId) ?? null
  const votos = ratings.map((r) => ({ rating: r.rating }))
  // La anotacion `PlanDetail` es lo que hace que esta pantalla y esta respuesta
  // no puedan separarse: si el shape cambia, el compilado falla en el endpoint Y
  // en el cliente, porque los dos usan el mismo tipo. Sin ella, el cliente
  // declararia su propia copia y un campo renombrado se veria como `undefined`
  // en pantalla sin error de tipos.
  const body: { plan: PlanDetail } = {
    plan: {
      ...rest,
      // Las fechas se pasan a ISO a mano en vez de confiar en el `JSON.stringify`
      // de `NextResponse.json`. El tipo dice `string`, y el `Date` de Prisma
      // cuelga de que la serializacion siga siendo la de siempre.
      startsAt: startsAt.toISOString(),
      endsAt: endsAt ? endsAt.toISOString() : null,
      participants: participantesPublicos,
      ratings: {
        count: ratings.length,
        average: promedioDe(votos),
        // El conteo de etiquetas va para todos, igual que el promedio: es
        // agregado y anonimo, y sin el la estrella queda sin explicacion. Los ids
        // van sin traducir; el label lo pone el cliente desde el set cerrado.
        tags: tallyDe(ratings.map((r) => ({ tags: r.tags }))),
        mine: mio
          ? { rating: mio.rating, tags: mio.tags, updatedAt: mio.updatedAt.toISOString() }
          : null,
        // Los nombres y las etiquetas son del organizador. El promedio y el
        // conteo ya estan arriba y alcanzan para que quien califico vea que su
        // voto conto.
        detail: esCreador
          ? ratings.map((r) => ({
              user: { id: r.authorId, name: r.author.name },
              rating: r.rating,
              tags: r.tags,
              createdAt: r.createdAt.toISOString(),
            }))
          : null,
      },
      place: {
        id: place.id,
        name: place.name,
        category: place.category,
        latitude: Number(place.latitude),
        longitude: Number(place.longitude),
      },
      // Los mismos nombres y el mismo significado que en el listado, para que
      // las dos pantallas no puedan divergir sobre si el plan va.
      remainingSpots: remaining,
      isFull: remaining === 0,
      // Estado de QUIEN ESTA MIRANDO, no de los demas. Es lo unico que depende
      // del viewer, y sin esto la pagina de detalle no puede distinguir
      // "unirme" de "ya pediste" sin hacer un POST para averiguarlo.
      viewer: {
        isCreator: esCreador,
        participation: mine ? { status: mine.status, role: mine.role } : null,
      },
    },
  }

  return NextResponse.json(body, { headers: { 'cache-control': 'private, no-store' } })
}
