import { NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { requireUser } from '@/lib/auth/session'
import { getPrisma } from '@/lib/db'
import { assertSameOrigin, fail, readJson } from '@/lib/http'
import { sumarScores, verificarRespuestas } from '@/lib/personality'
import { isRetryableDbError } from '@/lib/prisma-errors'
import { fieldErrors, personalitySubmissionSchema } from '@/lib/validation'

/**
 * GET /api/personality/test
 *
 * El test activo para responder. Exige sesion: el resultado va a una tabla
 * indexada por `userId`, asi que un GET anonimo no tiene a quien devolverle nada
 * util, y un endpoint que existe para todos pero solo significa algo para los
 * que tienen cuenta es un endpoint que invita a enlazar.
 *
 * `scoreDelta` NO viaja en la respuesta. Es el algoritmo de `lib/personality.ts`,
 * y mandarlo haria que el cliente pudiera calcular el score por su cuenta. Hoy eso
 * no cambia nada porque no hay matching, pero el dia que lo haya, el score que se
 * guarda tiene que ser el que calculo el servidor, no el que recalculo el cliente
 * al vuelo. Mandar el dato y que el cliente lo repita es la forma facil de que los
 * dos dejen de coincidir sin que nada falle.
 */
export async function GET() {
  const gate = await requireUser()
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })

  const prisma = getPrisma()
  const test = await prisma.personalityTest.findFirst({
    where: { isActive: true },
    select: {
      id: true,
      version: true,
      name: true,
      questions: {
        orderBy: { order: 'asc' },
        select: {
          id: true,
          prompt: true,
          order: true,
          trait: { select: { key: true, label: true } },
          options: {
            orderBy: { order: 'asc' },
            // `scoreDelta` se deja afuera a proposito. Ver el comentario de
            // arriba del handler.
            select: { id: true, label: true, order: true },
          },
        },
      },
    },
  })

  if (!test) return fail(404, 'No hay ningun test de personalidad activo')

  // Si ya hay resultado de ESTE test, se dice. La UI usa esto para no dejar
  // responder dos veces, pero igual valida en el POST: un check en el GET es una
  // cortesia para la pantalla, no una garantia.
  const resultado = await prisma.personalityResult.findUnique({
    where: { userId_testId: { userId: gate.user.id, testId: test.id } },
    select: { id: true, completedAt: true },
  })

  return NextResponse.json(
    {
      test,
      resultado: resultado
        ? { id: resultado.id, completadoEn: resultado.completedAt.toISOString() }
        : null,
    },
    { headers: { 'cache-control': 'private, no-store' } },
  )
}

/**
 * POST /api/personality/test
 *
 * Guardar el resultado. Escribe `Result + Answer + Score` en UNA transaccion.
 *
 * La transaccion no es por prolijidad. El schema separa las tres tablas
 * justamente para poder recalcular scores, y esa separacion abre la posibilidad
 * de que un `Result` quede sin `Answer`, o con `Answer` y sin `Score`: estados
 * que la base permite porque cada uno es valido por separado, y que un lector
 * interpretaria como "esta persona no contesto" cuando en realidad la escritura
 * se corto a mitad. O se escribe el set entero, o no se escribe nada.
 *
 * `Score` se calcula adentro, con las filas recien leidas, y no con lo que mando
 * el cliente: el cliente manda opciones, nunca numeros.
 */
export async function POST(req: Request) {
  const originError = assertSameOrigin(req)
  if (originError) return originError

  const gate = await requireUser()
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })

  const body = await readJson(req)
  const parsed = personalitySubmissionSchema.safeParse(body)
  if (!parsed.success) {
    return fail(400, 'Datos invalidos', { fields: fieldErrors(parsed.error) })
  }
  const { testId, answers } = parsed.data

  try {
    const resultado = await getPrisma().$transaction(async (tx) => {
      const test = await tx.personalityTest.findUnique({
        where: { id: testId },
        select: {
          id: true,
          version: true,
          isActive: true,
          questions: {
            orderBy: { order: 'asc' },
            select: {
              id: true,
              traitId: true,
              options: { select: { id: true, questionId: true, scoreDelta: true } },
            },
          },
        },
      })
      if (!test) throw new TestDesconocidoError()

      // La version tiene que ser la activa. No por purismo de version, sino
      // porque el score se calcula con el `scoreDelta` de ESTA version: si
      // aceptamos una v1 mientras la v2 esta publicada, se guarda un score con
      // la escala vieja y queda guardado, que es el peor de los dos mundos. La
      // UI recibe el 409, recarga y arranca la version nueva.
      if (!test.isActive) throw new TestDesactualizadoError()

      const yaHecho = await tx.personalityResult.findUnique({
        where: { userId_testId: { userId: gate.user.id, testId: test.id } },
        select: { id: true },
      })
      if (yaHecho) throw new YaCompletadoError()

      // Mapa opcion -> pregunta y trait, para puntuar sin volver a consultar.
      // `scoreDelta` se lee aca y no se acepta del cliente: es el unico lugar
      // del que sale el numero que se guarda.
      type Puntable = { questionId: string; optionId: string; traitId: string; scoreDelta: number }
      const porOpcion = new Map<string, Puntable>()
      for (const q of test.questions) {
        for (const o of q.options) {
          porOpcion.set(o.id, {
            questionId: q.id,
            optionId: o.id,
            traitId: q.traitId,
            scoreDelta: o.scoreDelta,
          })
        }
      }

      // Una opcion que no sea de ESTE test se descarta antes de contar. Sin esto,
      // un POST manipulado podria responder con un `optionId` de la v2 y
      // puntuar traits que la persona nunca vio contestados.
      const propias: Puntable[] = answers.flatMap((a) => {
        const o = porOpcion.get(a.optionId)
        // La `questionId` que vino tiene que ser la misma que la de la opcion:
        // si no coinciden, el body esta describiendo algo que no existe, y
        // aceptarlo seria confiarle al cliente la estructura del test.
        if (!o || o.questionId !== a.questionId) return []
        return [o]
      })

      const preguntasDelTest = test.questions.map((q) => q.id)
      const problemas = verificarRespuestas(preguntasDelTest, propias)
      if (propias.length !== answers.length) {
        // Habia opciones mandadas que no son de este test. Se dice explicitamente
        // y no como `sin_contestar`: son dos errores distintos para quien lo
        // provoco, y uno es un bug del cliente y el otro es un POST manipulado.
        problemas.push({
          tipo: 'fuera_del_test',
          questionId: '?',
          detalle: 'Alguna opcion no pertenece a este test',
        })
      }
      if (problemas.length > 0) throw new RespuestasInvalidasError(problemas)

      const scores = sumarScores(propias)
      const created = await tx.personalityResult.create({
        data: {
          userId: gate.user.id,
          testId: test.id,
          answers: { create: propias.map((a) => ({ optionId: a.optionId })) },
          scores: { create: scores.map((s) => ({ traitId: s.traitId, value: s.value })) },
        },
        select: {
          id: true,
          completedAt: true,
          test: { select: { version: true } },
          scores: { select: { traitId: true, value: true, trait: { select: { key: true, label: true } } } },
        },
      })

      return created
    })

    return NextResponse.json({ resultado }, { status: 201 })
  } catch (err) {
    if (err instanceof TestDesconocidoError) return fail(404, 'El test no existe')
    if (err instanceof TestDesactualizadoError) {
      // 409 y no 400: el body era valido, lo que cambio fue el mundo. La UI
      // distingue este caso de los errores de validacion por el status y
      // recarga el test en vez de mostrar un formulario de errores.
      return fail(409, 'Este test ya no es la version activa', { code: 'test_desactualizado' })
    }
    if (err instanceof YaCompletadoError) {
      return fail(409, 'Ya completaste este test', { code: 'ya_completado' })
    }
    if (err instanceof RespuestasInvalidasError) {
      return fail(400, 'Las respuestas no son validas', { problemas: err.problemas })
    }

    if (isRetryableDbError(err)) {
      return fail(503, 'No pudimos guardar el resultado; reintenta en un momento')
    }

    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      // P2002 en `@@unique([userId, testId])`: dos POST a la vez. El chequeo de
      // `yaHecho` esta adentro de la transaccion pero no bloquea la fila que no
      // existe todavia, asi que la carrera es real y la resuelve la base. Que
      // llegue aca es lo esperado, no una sorpresa.
      if (err.code === 'P2002') {
        return fail(409, 'Ya completaste este test', { code: 'ya_completado' })
      }
      // P2003: un `optionId` o `traitId` valido en el schema pero que se fue
      // (se borro una opcion entre la lectura y el create).
      if (err.code === 'P2003') {
        return fail(400, 'Las respuestas no son validas')
      }
    }

    throw err
  }
}

class TestDesconocidoError extends Error {
  constructor() {
    super('El test no existe')
    this.name = 'TestDesconocidoError'
  }
}

class TestDesactualizadoError extends Error {
  constructor() {
    super('El test no es la version activa')
    this.name = 'TestDesactualizadoError'
  }
}

class YaCompletadoError extends Error {
  constructor() {
    super('El test ya fue completado')
    this.name = 'YaCompletadoError'
  }
}

class RespuestasInvalidasError extends Error {
  constructor(public readonly problemas: { tipo: string; questionId: string; detalle: string }[]) {
    super('Las respuestas no son validas')
    this.name = 'RespuestasInvalidasError'
  }
}
