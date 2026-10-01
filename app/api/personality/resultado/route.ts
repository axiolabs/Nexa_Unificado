import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth/session'
import { getPrisma } from '@/lib/db'
import { nivelDe, posicionRelativa, rangosDeTest } from '@/lib/personality'

/**
 * GET /api/personality/resultado
 *
 * El resultado de la persona, con los rasgos ya traducidos a niveles.
 *
 * Trae el `value` CRUDO y el nivel derivado, y los dos se devuelven. El crudo
 * porque es el dato y el dia que haya matching se ordena por el; el nivel porque
 * "1.5" no le dice nada a nadie y en la pantalla se muestra una palabra.
 *
 * El nivel se calcula ACa y no en el cliente, por una razon que va mas alla de
 * ahorrar bytes: el rango depende del contenido de la version del test, y si lo
 * calculara el cliente tendria que mandarle el contenido entero. Mandando el
 * nivel ya resuelto, la pantalla no necesita saber quantas preguntas tiene el
 * test ni como se reparten los pesos.
 *
 * Se lee el ULTIMO resultado, no el de la version activa. Ver la nota de version
 * en `GET /api/personality`.
 */
export async function GET() {
  const gate = await requireUser()
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })

  const prisma = getPrisma()
  const resultado = await prisma.personalityResult.findFirst({
    where: { userId: gate.user.id },
    orderBy: { completedAt: 'desc' },
    select: {
      id: true,
      completedAt: true,
      test: {
        select: {
          version: true,
          name: true,
          questions: { select: { traitId: true, options: { select: { scoreDelta: true } } } },
        },
      },
      scores: {
        select: {
          // `traitId` y no solo `trait.key`: el mapa de rangos esta indexado por
          // id de trait, porque es lo que traen las preguntas. Buscar por `key`
          // (que es texto y se parece pero no es el id) haria que el lookup
          // siempre falle y caiga al rango por defecto, en silencio y sin error.
          traitId: true,
          value: true,
          trait: { select: { key: true, label: true, category: true, description: true } },
        },
      },
    },
  })

  // Todavia no lo hizo. No es 404: la pantalla de perfil tiene que poder
  // distinguir "no hay resultado" de "algo fallo", asi que responde 200 con un
  // `resultado: null` y la UI ofrece empezar el test.
  if (!resultado) {
    return NextResponse.json({ resultado: null }, { headers: { 'cache-control': 'private, no-store' } })
  }

  const rangos = rangosDeTest(resultado.test.questions)

  const rasgos = resultado.scores
    .map((s) => {
      const rango = rangos.get(s.traitId) ?? { min: -1.5, max: 1.5 }
      const posicion = posicionRelativa(s.value, rango)
      return {
        traitId: s.traitId,
        key: s.trait.key,
        label: s.trait.label,
        category: s.trait.category,
        description: s.trait.description,
        value: s.value,
        posicion,
        nivel: nivelDe(posicion),
      }
    })
    // De mayor a menor puntaje. El primer rasgo es el que la persona mas
    // "es", y ese es el que tiene que leerse primero.
    .sort((a, b) => b.value - a.value)

  return NextResponse.json(
    {
      resultado: {
        id: resultado.id,
        completadoEn: resultado.completedAt.toISOString(),
        testVersion: resultado.test.version,
        testNombre: resultado.test.name,
        rasgos,
      },
    },
    { headers: { 'cache-control': 'private, no-store' } },
  )
}
