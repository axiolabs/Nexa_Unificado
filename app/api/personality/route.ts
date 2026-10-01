import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth/session'
import { getPrisma } from '@/lib/db'

/**
 * GET /api/personality
 *
 * El estado de "ya hice el test", y nada mas. Un solo numero, y existe por una
 * razon concreta: el
 * recordatorio de `/explore` necesita saber esto en CADA visita al mapa, y no
 * puede pedir el test entero para averiguarlo. `GET /api/personality/test` son
 * ocho preguntas con cinco opciones cada una, unas 40 filas, y el mapa solo quiere
 * un booleano.
 *
 * O sea: este endpoint es el barato y el otro es el caro. Mezclarlos seria
 * facil y dejaria el mapa descargando el contenido del test cada vez que se
 * abre, que es lo que hace que la app se sienta lenta.
 *
 * `version` es la del test activo, no la del resultado. Si la v2 se publica y la
 * persona hizo la v1, aca va la v2: es la que la UI tiene que ofrecer, y la
 * comparacion entre versiones es un problema de `/perfil`, no de este check.
 */
export async function GET() {
  const gate = await requireUser()
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })

  const prisma = getPrisma()
  const [activo, resultado] = await Promise.all([
    prisma.personalityTest.findFirst({
      where: { isActive: true },
      select: { id: true, version: true, name: true },
    }),
    prisma.personalityResult.findFirst({
      where: { userId: gate.user.id },
      orderBy: { completedAt: 'desc' },
      select: { completedAt: true, test: { select: { version: true } } },
    }),
  ])

  // Sin test activo no hay nada que ofrecer, y `hayTest` lo dice sin obligar a la
  // UI a interpretar un `null`. El recordatorio se apaga por completo en ese
  // caso: insistir en hacer un test que no existe es peor que no insistir.
  if (!activo) {
    return NextResponse.json(
      { hayTest: false, hayResultado: false, version: null },
      { headers: { 'cache-control': 'private, no-store' } },
    )
  }

  return NextResponse.json(
    {
      hayTest: true,
      hayResultado: resultado !== null,
      version: activo.version,
      // La version del ultimo resultado se manda aparte de la version activa,
      // porque "tengo resultado" y "tengo resultado de la version que estas
      // mostrando" son preguntas distintas. Sin las dos, publicar una v2 deja el
      // recordatorio apagado para todos los que hicieron la v1, y el boton de
      // "rehacer el test" desaparece sin que nadie lo haya pedido.
      resultadoVersion: resultado?.test.version ?? null,
      completadoEn: resultado?.completedAt.toISOString() ?? null,
    },
    { headers: { 'cache-control': 'private, no-store' } },
  )
}
