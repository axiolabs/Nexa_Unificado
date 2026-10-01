import { NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { requireUser } from '@/lib/auth/session'
import {
  CHAT_PAGE_SIZE,
  MESSAGE_BODY_MAX,
  ORDEN_CHAT,
  decodeCursor,
  encodeCursor,
  puedeUsarChat,
  whereDespuesDe,
  type ChatPoll,
  type Mensaje,
  type Cursor,
} from '@/lib/chat'
import { getPrisma } from '@/lib/db'
import { assertSameOrigin, fail, readJson } from '@/lib/http'
import { fieldErrors, messageSchema } from '@/lib/validation'

/**
 * El chat de un plan. GET para leer, POST para escribir.
 *
 * **Por que el gate es una lista de estados y no "participa".** La FK
 * `Message(planId, authorId) -> PlanParticipant(planId, userId)` prueba
 * PERTENENCIA, no ESTADO: un participante con `status = 'CANCELLED'` puede
 * insertar mensajes igual, porque la FK se cumple. Si el gate fuera "existe
 * PlanParticipant", el endpoint aceptaria a cualquiera que alguna vez pidio
 * unirse, incluido al que el organizador rechazo y al que le vencio la
 * peticion. Por eso el filtro mira el status, en las dos funciones.
 *
 * Y **por que `ATTENDED` y `NO_SHOW` entran.** El chat no se cierra por status
 * del plan: es decision de producto, esta el porque en `CHAT_ABIERTOS_A` y el
 * disparador para revisarlo tambien. Lo unico que queda afuera es "no sos parte
 * del plan": `REQUESTED`, `DECLINED` y `CANCELLED`.
 *
 * El 403 dice "no sos parte" y no "el plan termino", porque el chat ya no tiene
 * dos finales distintos que explicar.
 */

/**
 * El gate de los dos handlers. Devuelve `null` cuando si se puede.
 */
async function chatPermitido(planId: string, userId: string) {
  const plan = await getPrisma().plan.findFirst({
    where: { id: planId, deletedAt: null },
    select: { id: true },
  })
  // 404 y no 403 para quien no participa: no se distingue "el plan existe pero
  // no sos parte" de "el plan no existe", porque esa distincion ya filtraria
  // la agenda de planes.
  if (!plan) return fail(404, 'Plan no encontrado')

  const participacion = await getPrisma().planParticipant.findUnique({
    where: { planId_userId: { planId, userId } },
    select: { status: true },
  })
  if (!participacion) return fail(404, 'Plan no encontrado')
  if (!puedeUsarChat(participacion.status)) {
    return fail(403, 'El chat es para quienes tienen lugar en el plan')
  }
  return null
}

/**
 * SELECT comun de los dos handlers.
 *
 * El nombre del autor se saca por `participacion.user` y NO por una relacion
 * `author` directa, que no existe: `Message` no tiene `authorId` apuntando a
 * `User`, lo tiene como parte de la PK compuesta contra `PlanParticipant`. El
 * diagrama lo dibuja casi como una relacion a User y por eso parece que se
 * pueda pedir `author`, pero `prisma.message.select({ author: ... })` revienta
 * en ejecucion.
 *
 * Y no se revienta solo por eso: si este objeto se declarara suelto, con un
 * `as const` y sin tipo, TypeScript no lo validaria contra `MessageSelect` y el
 * error pasaria de compilacion a runtime, o sea un 500 en el chat en vez de un
 * error de build. `Prisma.validator` es lo que hace que el nombre de la
 * relacion este verificado al compilar.
 */
const SELECT_MENSAJE = Prisma.validator<Prisma.MessageSelect>()({
  id: true,
  body: true,
  createdAt: true,
  authorId: true,
  deletedAt: true,
  participacion: { select: { user: { select: { name: true } } } },
})

/** Fila de Prisma -> lo que ve el cliente. */
function aMensaje(
  fila: {
    id: string
    body: string
    createdAt: Date
    authorId: string
    deletedAt: Date | null
    participacion: { user: { name: string } }
  },
  userId: string,
): Mensaje {
  return {
    id: fila.id,
    body: fila.body,
    createdAt: fila.createdAt.toISOString(),
    authorId: fila.authorId,
    authorName: fila.participacion.user.name,
    mine: fila.authorId === userId,
    deletedAt: fila.deletedAt ? fila.deletedAt.toISOString() : null,
  }
}

/**
 * GET /api/plans/[planId]/messages?after=<cursor>
 *
 * Trae lo que hay DESPUES del cursor, en orden. Sin `after`, trae desde el
 * principio, que es la primera carga de la pantalla.
 *
 * Paginado por cursor y no por `offset` a proposito: `offset` se rompe en
 * cuanto llega un mensaje nuevo, porque las filas se corren y el cliente
 * vuelve a leer las ultimas. Con cursor, cada poll lee un rango que no se
 * mueve.
 *
 * Pide `CHAT_PAGE_SIZE + 1` filas para poder decir `hasMore` sin un `COUNT`:
 * si la fila extra esta, hay mas; si no, se leyo todo.
 */
export async function GET(req: Request, ctx: { params: Promise<{ planId: string }> }) {
  const gate = await requireUser()
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })
  const { planId } = await ctx.params

  const negado = await chatPermitido(planId, gate.user.id)
  if (negado) return negado

  const url = new URL(req.url)
  const bruto = url.searchParams.get('after')

  let cursor: Cursor | null = null
  if (bruto !== null && bruto.length > 0) {
    cursor = decodeCursor(bruto)
    // Un cursor ilegible es 400 y no "empezar de nuevo". Volver al principio en
    // silencio reenvia el chat entero: el cliente lo agrega al final y duplica
    // la conversacion, que es peor que un error visible.
    if (!cursor) return fail(400, 'El cursor no es valido')
  }

  const filas = await getPrisma().message.findMany({
    where: cursor ? whereDespuesDe(planId, cursor) : { planId },
    orderBy: ORDEN_CHAT,
    take: CHAT_PAGE_SIZE + 1,
    select: SELECT_MENSAJE,
  })

  const hayMas = filas.length > CHAT_PAGE_SIZE
  const pagina = hayMas ? filas.slice(0, CHAT_PAGE_SIZE) : filas
  const ultimo = pagina[pagina.length - 1]

  const cuerpo: ChatPoll = {
    messages: pagina.map((f) => aMensaje(f, gate.user.id)),
    // Cuando vino la pagina completa, el cursor sigue en el ultimo mensaje
    // DEVUELTO, no en el que se corto. Si apuntara al `+1`, ese mensaje se
    // saltaria para siempre en la pagina siguiente.
    nextCursor: ultimo ? encodeCursor({ createdAt: ultimo.createdAt, id: ultimo.id }) : null,
    hasMore: hayMas,
  }

  return NextResponse.json(cuerpo, { headers: { 'cache-control': 'private, no-store' } })
}

/**
 * POST /api/plans/[planId]/messages
 *
 * Publica un mensaje. Sin adjuntos, sin edicion y sin borrado en este corte: el
 * modelo ya tiene `editedAt` y `deletedAt`, pero la moderacion va en otro
 * (§13.4).
 *
 * El `authorId` NO se manda: sale de la sesion. Aceptarlo del body seria una
 * puerta para escribir como otro. La FK compuesta lo taparia en parte (el autor
 * tiene que ser participante de ESE plan), pero no impediria escribir como un
 * participante que no es el que esta escribiendo.
 */
export async function POST(req: Request, ctx: { params: Promise<{ planId: string }> }) {
  const sameOrigin = assertSameOrigin(req)
  if (sameOrigin) return sameOrigin

  const gate = await requireUser()
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })
  const { planId } = await ctx.params

  const negado = await chatPermitido(planId, gate.user.id)
  if (negado) return negado

  const parsed = messageSchema.safeParse(await readJson(req))
  if (!parsed.success) return fail(400, fieldErrors(parsed.error)[0] ?? 'Mensaje invalido')

  // El `trim` y el `max` ya corrieron en `messageSchema`. El corte final es la
  // red que impide guardar mas de lo permitido si el schema cambia y este
  // archivo no.
  const body = parsed.data.body.slice(0, MESSAGE_BODY_MAX)

  const creado = await getPrisma().message.create({
    data: { planId, authorId: gate.user.id, body },
    select: SELECT_MENSAJE,
  })

  return NextResponse.json({ message: aMensaje(creado, gate.user.id) }, { status: 201 })
}
