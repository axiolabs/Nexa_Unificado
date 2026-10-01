/**
 * Contenido del test de personalidad, version 1.
 *
 * Vive aparte de `prisma/seed.mjs` y aparte de los tests por una razon concreta:
 * **la misma fuente tiene que alimentar a los dos**. Si el test de API crea su
 * propio test de juguete y el seed crea otro, uno de los dos miente, y el que
 * miente es el que los tests dicen cubrir. Importando de aca, el test de API
 * ejercita el contenido real, incluido el caso de dos preguntas del mismo trait
 * que se suman.
 *
 * ## Que NO decide este archivo
 *
 * El score. `scoreDelta` es el dato; la suma es de `lib/personality.ts`. Esta
 * separacion es la que hace que el algoritmo se pueda cambiar sin perder
 * respuestas (§5.6 de `docs/modelo-datos.md`).
 *
 * ## Escala de las opciones: cinco, y la del medio vale cero
 *
 * Cada pregunta tiene cinco opciones con `scoreDelta` en
 * `[-1.5, -0.5, 0, +0.5, +1.5]` multiplicado por el peso de la pregunta.
 *
 * La de en medio vale **cero de verdad**, y no es un detalle. Con cuatro
 * opciones no hay neutral, asi que alguien que genuinamente no sabe --o que no
 * quiere inclinarse hacia ningun lado-- tiene que mentir un poco para poder
 * avanzar. La audiencia de Nexa tiene ansiedad social por definicion (§0 del
 * documento); un test que obliga a emitir una opinion que no tiene es un test
 * que empieza mal.
 *
 * Que ninguna pregunta pese lo mismo es intencional: `weight` es el mecanismo de
 * peso, y dos preguntas del mismo trait miden cosas distintas. Una pregunta de
 * peso 1 y otra de peso 0.5 no promedian: **suman**, asi que la segunda mueve la
 * puntua la mitad. Ver `sumarScores` para el rango que sale de esto.
 *
 * ## Por que 8 preguntas y 5 traits
 *
 * Un trait con una sola pregunta no necesita una tabla de scores: el score seria
 * el `scoreDelta` copiado. Cuatro de los cinco traits tienen dos preguntas para
 * que la suma tenga que hacer algo, y `improvisar` y `ambiente_calmo` tienen una
 * sola porque son mas binarios. Si se agrega un trait con una sola pregunta, la
 * `suma` no cambia pero el rango de puntajes si, y hay que anotarlo en §14.
 */

/** Los rasgos que mide el test. `key` es el vocabulario compartido con `PlaceTrait`. */
export const TRAITS_V1 = [
  {
    key: 'nueva_gente',
    label: 'Gente nueva',
    category: 'social',
    description: 'Cuanto le importa a la persona Plan con gente que no conoce.',
  },
  {
    key: 'charlas',
    label: 'Conversar',
    category: 'social',
    description: 'Si lo que busca es hablar o simplemente estar.',
  },
  {
    key: 'actividad',
    label: 'Algo para hacer',
    category: 'plan',
    description: 'Prefiere planes con una actividad o planes de quedarse quieto.',
  },
  {
    key: 'improvisar',
    label: 'Improvisar',
    category: 'plan',
    description: 'Como se relaciona con los cambios de ultimo momento.',
  },
  {
    key: 'ambiente_calmo',
    label: 'Ambiente tranquilo',
    category: 'ambiente',
    description: 'Prefiere lugares tranquilos o movidos.',
  },
]

/**
 * Las preguntas, en orden. `weight` multiplica los `scoreDelta` de sus opciones.
 *
 * Opciones de menos a mas: el `scoreDelta` se deriva de la POSICION, no se
 * escribe en cada linea. Escribirlo a mano en 40 opciones es 40 oportunidades de
 * que una quede corrida, y una sola opcion corrida cambia el resultado de
 * todas las personas que la eligieron.
 */
export const TEST_V1 = {
  version: 1,
  name: 'Test de personalidad v1',
  /** Multiplicador de cada posicion: 5 opciones, la del medio en cero. */
  escala: [-1.5, -0.5, 0, 0.5, 1.5],
  questions: [
    {
      trait: 'nueva_gente',
      weight: 1,
      prompt: 'Llegas a un plan y no conoces a nadie mas.',
      options: [
        'Prefiero ir siempre acompanado',
        'Me incomoda, pero voy igual',
        'Ni me gusta ni me molesta',
        'Me resulta bien',
        'Es justo lo que busco',
      ],
    },
    {
      trait: 'nueva_gente',
      weight: 0.5,
      prompt: 'El plan es en un lugar del que nunca escuchaste.',
      options: [
        'Prefiero lugares que ya conozco',
        'Me da un poco de cosa, pero voy',
        'Me es indiferente',
        'Me gusta',
        'Es la parte que mas me anima',
      ],
    },
    {
      trait: 'charlas',
      weight: 1,
      prompt: 'El plan es en un lugar con buena comida y poco para charlar.',
      options: [
        'No me interesa, yo quiero comer',
        'Prefiero la comida: charlar no es lo mio',
        'Me da igual',
        'Me sirve charlar un rato',
        'La charla es lo que voy a buscar',
      ],
    },
    {
      trait: 'charlas',
      weight: 0.5,
      prompt: 'En el plan, la gente ya se conoce entre si.',
      options: [
        'Me incomoda',
        'Me hace ruido',
        'Me da igual',
        'Me gusta',
        'Es lo que hace que me anime',
      ],
    },
    {
      trait: 'actividad',
      weight: 1,
      prompt: 'El plan es sentarse a tomar algo y nada mas.',
      options: [
        'Prefiero un plan tranquilo, sin actividades',
        'Me aburre un poco',
        'Ni una cosa ni la otra',
        'Me gusta que haya algo para hacer',
        'Busco planes con algo que hacer',
      ],
    },
    {
      trait: 'actividad',
      weight: 0.5,
      prompt: 'El plan incluye caminar un rato.',
      options: [
        'No me aplica',
        'Lo hago sin quejarme',
        'Me da igual',
        'Me gusta',
        'Es lo que mas me mueve',
      ],
    },
    {
      trait: 'improvisar',
      weight: 1,
      prompt: 'El organizador cambio la hora del plan a ultimo momento.',
      options: [
        'Me molesta mucho',
        'Me incomoda',
        'Me da igual',
        'Prefiero que avisen con tiempo',
        'Me adapto sin problema',
      ],
    },
    {
      trait: 'ambiente_calmo',
      weight: 1,
      prompt: 'El lugar esta lleno y hay musica fuerte.',
      options: [
        'No vuelvo',
        'Me cuesta quedarme',
        'Ni bien ni mal',
        'No me molesta',
        'Me divierte',
      ],
    },
  ],
}

/**
 * Inserta traits y test en una transaccion, y es idempotente.
 *
 * Idempotente por `key` y por `version`, no por "borro y recreo": un
 * `deleteMany` al principio destruiria los `PersonalityResult` que el Cascade
 * lleva con el, y con ellos las respuestas de todos los que ya lo completaron.
 * Publicar una v2 tiene que SER agregar filas.
 *
 * @param tx cliente de Prisma (el del seed o el de un test)
 * @returns {{ testId: string, questions: number, options: number }}
 */
export async function sembrarTestV1(tx) {
  for (const t of TRAITS_V1) {
    await tx.trait.upsert({
      where: { key: t.key },
      create: { key: t.key, label: t.label, category: t.category, description: t.description },
      update: { label: t.label, category: t.category, description: t.description },
    })
  }

  const existing = await tx.personalityTest.findUnique({ where: { version: TEST_V1.version } })
  if (existing) {
    return { testId: existing.id, questions: TEST_V1.questions.length, options: 0, yaExistia: true }
  }

  let preguntas = 0
  let opciones = 0

  const test = await tx.personalityTest.create({
    data: {
      version: TEST_V1.version,
      name: TEST_V1.name,
      isActive: true,
      publishedAt: new Date(),
    },
  })

  for (const [i, q] of TEST_V1.questions.entries()) {
    const trait = await tx.trait.findUnique({ where: { key: q.trait } })
    // Un `key` mal escrito en el contenido tiene que romper el seed, no crear una
    // pregunta sin trait: la FK lo va a rechazar igual, pero el mensaje de
    // Postgres no dice cual de las ocho preguntas es la culpable.
    if (!trait) throw new Error(`El contenido declara el trait "${q.trait}", que no existe`)

    const escala = TEST_V1.escala
    if (q.options.length !== escala.length) {
      throw new Error(
        `La pregunta ${i + 1} tiene ${q.options.length} opciones y la escala tiene ${escala.length}. ` +
          'Todas las preguntas tienen que tener la misma cantidad, o el score deja de ser comparable.',
      )
    }

    const creada = await tx.personalityQuestion.create({
      data: { testId: test.id, prompt: q.prompt, order: i + 1, traitId: trait.id },
    })
    preguntas++

    for (const [j, label] of q.options.entries()) {
      await tx.personalityOption.create({
        data: {
          questionId: creada.id,
          label,
          // La posicion ES el score. Ver el comentario del archivo.
          scoreDelta: escala[j] * q.weight,
          order: j + 1,
        },
      })
      opciones++
    }
  }

  return { testId: test.id, questions: preguntas, options: opciones, yaExistia: false }
}
