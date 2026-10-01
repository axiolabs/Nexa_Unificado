import { NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { requireRole, isCurator } from '@/lib/auth/guard'
import { requireUser } from '@/lib/auth/session'
import { getPrisma } from '@/lib/db'
import { assertSameOrigin, fail, readJson } from '@/lib/http'
import { isRetryableDbError } from '@/lib/prisma-errors'
import { findPlansInBbox } from '@/lib/plans'
import { planablePlaceWhere } from '@/lib/places'
import { createPlanSchema, fieldErrors, parseBbox } from '@/lib/validation'

/**
 * GET /api/plans?bbox=minLng,minLat,maxLng,maxLat
 *
 * Listado de planes futuros dentro de una caja. EXIGE SESION.
 *
 * El mapa es publico, los lugares son publicos, y este listado no. La diferencia
 * es que un lugar es un dato del lugar: "hay un cafe en Recoleta". Un plan es un
 * compromiso con fecha, hora y personas, y por mas publico que sea el lugar donde
 * pasa, la cita no lo es.
 *
 * Y sin sesion este endpoint no podria fulfill su funcion: `viewer.participation`
 * es lo que le permite a la UI decir "ya pediste" o "estas confirmado" en vez de
 * dejar que el cliente lo deduzca de una lista de participantes que no debe
 * tener. Esa es la razon de que exija sesion y no solo un placeholder anonimo.
 *
 * `bbox` es obligatorio, igual que en `/api/places`: es la caja que se esta
 * viendo, no un listado de todo lo que existe.
 */
export async function GET(req: Request) {
  const gate = await requireUser()
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })

  const url = new URL(req.url)
  const bbox = parseBbox(url.searchParams.get('bbox'))
  if (!bbox.ok) return fail(400, bbox.error)

  // Los roles salen del MISMO gate que ya dio `ok`, y no de un `getViewer()`
  // aparte: releer la sesion dos veces en la misma peticion da dos oportunidades
  // de que una y otra no coincidan, y `requireUser` ya hizo el reread de estado
  // de la cuenta, asi que `gate.user.roles` esta fresco por definicion.
  const plans = await findPlansInBbox(bbox.bbox, {
    userId: gate.user.id,
    isCurator: isCurator(gate.user.roles),
  })

  // `private, no-store` por la misma razon que el detalle: la respuesta depende
  // de quien pregunta.
  return NextResponse.json({ plans }, { headers: { 'cache-control': 'private, no-store' } })
}

/**
 * POST /api/plans
 *
 * Exige rol HOST (o ADMIN). Cualquier usuario registrado puede UNIRSE a un
 * plan, pero no crearlo: crear es la accion de la gente que organiza, y es la
 * que implica comprometer un lugar y una hora. El rol es lo que separa las dos.
 *
 * `requireRole` y no `requireUser`: el detalle de un plan lo lee cualquiera con
 * sesion, pero este endpoint es el que abre el compromiso.
 */
export async function POST(req: Request) {
  const originError = assertSameOrigin(req)
  if (originError) return originError

  const gate = await requireRole(['HOST', 'ADMIN'])
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })

  const body = await readJson(req)
  const parsed = createPlanSchema.safeParse(body)
  if (!parsed.success) {
    return fail(400, 'Datos invalidos', { fields: fieldErrors(parsed.error) })
  }
  const { title, description, placeId, startsAt, endsAt, capacity } = parsed.data

  // Chequeo rapido: si el lugar no esta disponible, 404 sin abrir transaccion.
  // Usa el MISMO predicado que la revalidacion de adentro, no un literal
  // repetido: con dos copias de la regla, cambiar una y olvidar la otra produce
  // un plan que se puede crear aca pero no por el otro camino, y ese bug no
  // aparece en ningun test hasta que alguien lo escribe.
  const place = await getPrisma().place.findFirst({
    where: { id: placeId, ...planablePlaceWhere() },
    select: { id: true },
  })
  if (!place) return fail(404, 'El lugar no existe o no esta disponible')

  try {
    const plan = await getPrisma().$transaction(async (tx) => {
      // La validacion del lugar se repite DENTRO de la transaccion, y no se
      // confía en el `findFirst` de arriba. Ese chequeo abre una ventana entre
      // que corre y que corre el `create`: un curador puede aprobar/rechazar o
      // desactivar el lugar en ese medio segundo, y el plan nace sobre un lugar
      // que ya no sirve. La ventana es chica, pero el symptom es un plan publico
      // en un lugar que Curaduria acaba de sacar de circulacion, que es
      // exactamente el tipo de cosa que el rol existe para evitar.
      //
      // Mismo criterio que el check de cupo: lo que decide una transaccion se
      // valida adentro de la transaccion. Ver `planablePlaceWhere()` para por que
      // esta regla es mas estricta que la de visibilidad.
      const placeLive = await tx.place.findFirst({
        where: { id: placeId, ...planablePlaceWhere() },
        select: { id: true },
      })
      if (!placeLive) throw new PlaceUnavailableError()

      const created = await tx.plan.create({
        data: {
          title,
          description,
          placeId,
          creatorId: gate.user.id,
          startsAt,
          endsAt: endsAt ?? null,
          capacity,
          // El contador arranca en 1 porque el creador entra ACCEPTED. Es un
          // valor desnormalizado a proposito: `join` lo incrementa con un
          // `updateMany` condicional para no permitir overbooking, y eso
          // significa que la capacidad no se puede leer antes de intentar.
          acceptedCount: 1,
          // El creador es el primer participante y queda aceptado de una: si
          // el que organiza tiene que "solicitar" a su propio plan, el flujo
          // tiene un hueco y nadie lo puede cerrar. Es la unica fila que nace
          // ACCEPTED sin pasar por una solicitud.
          //
          // `user: { connect }` y no `userId`: el create anidado usa la variante
          // "checked" de Prisma, que pide la relacion y no el escalar crudo.
          // `PlanParticipant` tiene PK compuesta, asi que tampoco hay un
          // `where` unico por id para el connect.
          // `ORGANIZER` y no `HOST`: el rol dentro del plan y el rol en la
          // plataforma son cosas distintas. `HOST` es de `UserRoleAssignment`
          // (puede crear planes); `ORGANIZER` es de `PlanParticipant` (organiza
          // ESTE plan). Confundirlas es facil porque se parecen, y el enum no
          // tiene `HOST`.
          participants: {
            create: {
              user: { connect: { id: gate.user.id } },
              role: 'ORGANIZER',
              status: 'ACCEPTED',
            },
          },
        },
        select: { id: true, title: true, startsAt: true, capacity: true, acceptedCount: true },
      })
      return created
    })

    return NextResponse.json({ plan }, { status: 201 })
  } catch (err) {
    // Errores de dominio primero: no son de Prisma y tienen su propio status.
    if (err instanceof PlaceUnavailableError) {
      return fail(404, 'El lugar no existe o no esta disponible')
    }

    // Primero la infraestructura: caida de la base o deadlock se traducen a
    // 503, nunca a un mensaje de negocio. Ver `isRetryableDbError`.
    if (isRetryableDbError(err)) {
      return fail(503, 'No pudimos guardar el plan; reintenta en un momento')
    }

    // Despues, codigo por codigo.
    //   P2002 (unique) -> no deberia pasar: no hay unique en Plan. Si aparece, es
    //                     un dato que no migra, y un 404 lo disfraza de "el lugar
    //                     no existe".
    //   P2003 (FK)     -> carrera real: el lugar o el creador se fueron entre el
    //                     chequeo y el create.
    //   P2025 (not found) -> id que no existia. Mismo 404.
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      if (err.code === 'P2002' || err.code === 'P2003' || err.code === 'P2025') {
        return fail(404, 'El lugar no existe o no esta disponible')
      }
    }
    // Cualquier otro error se propaga. Sin `throw`, un error de infraestructura
    // terminaria en el catch de arriba y volveria a mentir sobre la causa.
    throw err
  }
}

/**
 * El lugar dejo de estar disponible entre el chequeo previo y el create.
 *
 * Se tira desde DENTRO de la transaccion para que el rollback sea el de
 * Postgres, no el de un `return` de JavaScript. Un error propio con una clase
 * propia, en vez de un sentinel de string, porque asi el `catch` lo distingue
 * sin adivinar por el mensaje.
 */
class PlaceUnavailableError extends Error {
  constructor() {
    super('El lugar no esta disponible')
    this.name = 'PlaceUnavailableError'
  }
}
