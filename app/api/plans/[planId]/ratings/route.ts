import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth/session'
import { getPrisma } from '@/lib/db'
import { assertSameOrigin, fail, readJson } from '@/lib/http'
import { planCerrable, porQueNoSeCierra } from '@/lib/plan-finished'
import { ratingSchema } from '@/lib/validation'

/**
 * POST /api/plans/[planId]/ratings
 *
 * La calificacion de la **experiencia del plan**, no de las personas (§5.9 de
 * `docs/modelo-datos.md`). No hay `ratedUserId`, no hay forma de calificar a
 * otro participante, y la UI no ofrece ni insinua hacerlo: una calificacion
 * publica y permanente entre personas seria exactamente el juicio social que el
 * producto existe para eliminar.
 *
 * **Lo que se puede decir son ocho etiquetas cerradas, no texto.* * Este endpoint
 * hubo con un `comment` de hasta 500 caracteres y quedo como deuda conocida. Se
 * desaparecio, y no por longitud: un texto libre puede contener el juicio sobre
 * una persona que la tabla prohibe, con el nombre del autor al lado y sin
 * ninguna regla que lo impida. Con `ModerationReport` diferido a proposito, no
 * hay contencion posible. El set cerrado de `lib/ratings.ts` y el `z.enum` de
 * `ratingSchema` hacen que lo unico guardable este en una lista revisada. Ver
 * §16.10.
 *
 * **El gate tiene dos partes y las dos importan.**
 *
 *   1. `status = 'ATTENDED'`. Se califica la experiencia vivida: un `NO_SHOW` no
 *      puede calificar la de otros, y un `ACCEPTED` todavia no tiene una
 *      experiencia terminada que juzgar. Notar que **no** es el mismo gate que el
 *      del chat, que si abre a `ATTENDED` y `NO_SHOW` (§15.1): el chat es un
 *      canal y calificar es un juicio con peso reputacional. Que sean distintos
 *      es la decision, y por eso cada uno tiene su propia funcion.
 *   2. El plan tiene que haber terminado (`planCerrable`). Calificar un plan en
 *      curso es juzgar algo que todavia no pasa.
 *
 * **Editar es un upsert, y se puede siempre.** `@@unique([planId, authorId])` y
 * `updatedAt` ya estan en el schema, asi que corregir un voto es escribir encima
 * y no crear una fila nueva (que ademas violaria la unica restriccion del
 * modelo). No hay ventana de cierre: nadie deberia quedar atrapado con lo que
 * escribio, y para una audiencia con ansiedad social la correccion sin friccion
 * es el piso, no el extra. Un voto por persona y plan, ademas, hace que el
 * promedio no se pueda inflar.
 */
export async function POST(req: Request, ctx: { params: Promise<{ planId: string }> }) {
  const originError = assertSameOrigin(req)
  if (originError) return originError

  const gate = await requireUser()
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })

  const { planId } = await ctx.params
  const userId = gate.user.id

  const raw = await readJson(req)
  const parsed = ratingSchema.safeParse(raw)
  if (!parsed.success) return fail(400, parsed.error.issues[0]?.message ?? 'Payload invalido')
  const { rating, tags } = parsed.data

  const prisma = getPrisma()

  const plan = await prisma.plan.findFirst({
    where: { id: planId, deletedAt: null },
    select: { status: true, startsAt: true, endsAt: true },
  })
  if (!plan) return fail(404, 'Plan no encontrado')
  if (!planCerrable(plan)) {
    return fail(403, porQueNoSeCierra(plan) ?? 'Este plan todavia no se puede calificar')
  }

  const participacion = await prisma.planParticipant.findUnique({
    where: { planId_userId: { planId, userId } },
    select: { status: true },
  })
  // Sin fila de participacion no es un 404 de "plan no encontrado": el plan si
  // existe y se esta mirando. Es la misma respuesta que daria alguien de afuera
  // si no vieran la diferencia entre las dos, y el mensaje va a pantalla.
  if (!participacion) return fail(404, 'No participaste de este plan')
  if (participacion.status !== 'ATTENDED') {
    return fail(403, 'Solo quien asistió puede calificar el plan')
  }

  // `upsert` en vez de `find` + `create`/`update`: entre el find y el create, dos
  // toques del mismo boton (o dos pestanas) crean dos filas, y el `unique` hace
  // que el segundo reviente con un 500 en vez de editar. El `upsert` no tiene esa
  // ventana.
  const previo = await prisma.rating.findUnique({
    where: { planId_authorId: { planId, authorId: userId } },
    select: { id: true },
  })

  const guardado = await prisma.rating.upsert({
    where: { planId_authorId: { planId, authorId: userId } },
    create: { planId, authorId: userId, rating, tags },
    update: { rating, tags },
    select: { rating: true, tags: true, updatedAt: true },
  })

  return NextResponse.json(
    {
      rating: guardado.rating,
      tags: guardado.tags,
      updatedAt: guardado.updatedAt,
      // 201 creacion, 200 correccion. No es cosmetico: la pantalla usa esto
      // para decir "guardado" y no "tu calificacion se actualizo", y un test lo
      // fija para que el upsert no empiece a devolver 201 en cada edicion.
      creado: previo === null,
    },
    { status: previo === null ? 201 : 200 },
  )
}
