/**
 * El score de personalidad: como se deriva de las respuestas.
 *
 * Es una funcion pura y sin dependencias, a proposito. `PersonalityScore` esta
 * en su propia tabla justamente para poder **recalcular** con otro algoritmo sin
 * perder las respuestas (§5.6 de `docs/modelo-datos.md`). Un calculo pegado al
 * endpoint no se puede cambiar sin volver a_submitir el test de todos, que es
 * exactamente lo que la separacion de tablas evita.
 *
 * Que este archivo se pueda testear sin base de datos es la consecuencia
 * practica: el algoritmo se prueba en `tests/map/personality-score.test.ts` con
 * arrays, y el endpoint solo tiene que pasarle filas.
 */

/** Una opcion tal como la lee el endpoint: la pregunta ya se resolvio. */
export type OpcionPuntable = {
  questionId: string
  traitId: string
  scoreDelta: number
}

/** Un trait y su puntaje derivado. */
export type Score = {
  traitId: string
  value: number
}

/**
 * Suma los `scoreDelta` de las opciones elegidas, agrupados por trait.
 *
 * Se **suman** y no se promedian. Con el contenido de la v1, dos preguntas de
 * peso 1 y 0.5 dan un rango de [-2.25, +2.25] por trait, y las de un solo par
 * de peso 1 dan [-1.5, +1.5]. Un promedio daria [-1.5, +1.5] para todos los
 * traits, y el peso de la pregunta noeria nada: seria la misma division por
 * dos para todos, o sea no pesar nada.
 *
 * El valor NO esta normalizado a 0..1. No hay consumidor todavia, asi que la
 * eleccion es no inventar una escala que despues hay que deshacer. Cuando
 * exista el matching, la comparacion va a ser por ranking, no por umbral, y ahi
 * el rango importa menos que el orden. Si alguna vez se necesita un 0..1, se
 * normaliza en la lectura y no se toca esta tabla.
 *
 * Un trait sin ninguna respuesta no aparece en el resultado. Un `scoreDelta` en
 * cero SI aparece, con valor cero: son cosas distintas, y para un filtro futuro
 * la diferencia es entre "no contesto" y "contesto que no tiene opinion", que
 * no se pueden tratar igual.
 */
export function sumarScores(opciones: OpcionPuntable[]): Score[] {
  const porTrait = new Map<string, number>()
  for (const o of opciones) {
    porTrait.set(o.traitId, (porTrait.get(o.traitId) ?? 0) + o.scoreDelta)
  }
  return [...porTrait.entries()]
    .map(([traitId, value]) => ({ traitId, value }))
    .sort((a, b) => a.traitId.localeCompare(b.traitId))
}

/**
 * Una respuesta por pregunta, exactamente. La garantia que la base NO da.
 *
 * `PersonalityAnswer` no tiene `questionId`: llega a la pregunta por el
 * `optionId`, y su unico es `@@unique([resultId, optionId])`. Ese unico impide
 * repetir la MISMA opcion, y no impide responder dos veces a la misma pregunta
 * con dos opciones distintas: son filas diferentes y las dos pasan.
 *
 * O sea que la base acepta un resultado con las cuatro opciones de la pregunta 1
 * y ninguna de la 2, y un score que no representa a nadie. Por eso la
 * verificacion es de aca para afuera: se compara el set de preguntas del test
 * contra el set de preguntas efectivamente respondidas.
 *
 * Que sea exactamente una y "al menos una" no es lo mismo: "al menos" deja pasar
 * el caso de la pregunta 1 contestada tres veces, que es justo el que el unico
 * de la base no atrapa.
 */
export type Respuesta = { questionId: string; optionId: string }

export type Faltante = {
  tipo: 'sin_contestar' | 'repetida' | 'fuera_del_test'
  questionId: string
  detalle: string
}

/**
 * Una pregunta del test tal como la lee el calculo de rangos.
 *
 * `options` se llama asi, en ingles y con el nombre de Prisma, a proposito: lo
 * que se pasa aca es el `select` de la consulta tal cual. Si se llamara
 * `opciones` habria que mapear una lista por cada llamada, y ese map es el tipo
 * de codigo donde un campo se copia mal y el rango sale mal sin que se note.
 */
export type PreguntaRango = { traitId: string; options: { scoreDelta: number }[] }

export type Rango = { min: number; max: number }

/**
 * El rango que puede alcanzar cada trait, derivado del contenido del test.
 *
 * Hace falta porque los traits no comparten escala: con el contenido de la v1, los
 * que tienen dos preguntas llegan a 2.25 y los de una sola a 1.5. Un perfil que
 * mostrara "1.5" como si fuera el maximo posible estaria mintiendo sobre la mitad
 * de los traits.
 *
 * El rango es el de la SUMA, no el de una opcion suelta: por trait se suman los
 * minimos de cada pregunta y los maximos de cada pregunta. Tomar el minimo y el
 * maximo de todas las opciones juntas daria el mismo rango para todo trait que
 * tenga una pregunta de peso 1, y el `nivel` mas alto seria inalcanzable en los
 * traits con dos preguntas, sin que nada pareciera roto.
 *
 * Se calcula leyendo el contenido, no guardando una columna: agregar una pregunta
 * cambia el rango solo, y un rango guardado en la base se queda viejo sin que nada
 * avise.
 */
export function rangosDeTest(preguntas: PreguntaRango[]): Map<string, Rango> {
  const porTrait = new Map<string, Rango>()
  for (const p of preguntas) {
    if (p.options.length === 0) continue
    const r = porTrait.get(p.traitId) ?? { min: 0, max: 0 }
    porTrait.set(p.traitId, {
      min: r.min + Math.min(...p.options.map((o) => o.scoreDelta)),
      max: r.max + Math.max(...p.options.map((o) => o.scoreDelta)),
    })
  }
  return porTrait
}

/**
 * Donde cae un valor dentro de su rango, en 0..1.
 *
 * ESTA es la normalizacion, y va en la lectura, no en la tabla. `PersonalityScore`
 * guarda el numero crudo a proposito, asi que recalcular con otro algoritmo
 * despues no tiene que revisar dos formatos distintos.
 *
 * Un rango degenerado (min === max) devuelve 0.5 y no 0 ni NaN: es el caso
 * imposible con el contenido real, pero si passara, un NaN en el perfil se ve
 * como un bug y un 0.5 se ve como un dato.
 */
export function posicionRelativa(value: number, rango: Rango): number {
  if (rango.max === rango.min) return 0.5
  return (value - rango.min) / (rango.max - rango.min)
}

export type Nivel = 'muy_bajo' | 'bajo' | 'medio' | 'alto' | 'muy_alto'

/**
 * Cinco tramos, sobre la posicion relativa. No diez: con ocho preguntas y cinco
 * traits, la precision de mas se lee como exactitud que el dato no tiene.
 */
export function nivelDe(posicion: number): Nivel {
  if (posicion < 0.2) return 'muy_bajo'
  if (posicion < 0.4) return 'bajo'
  if (posicion <= 0.6) return 'medio'
  if (posicion < 0.8) return 'alto'
  return 'muy_alto'
}

export function verificarRespuestas(
  preguntasDelTest: string[],
  respuestas: Respuesta[],
): Faltante[] {
  const problemas: Faltante[] = []
  const delTest = new Set(preguntasDelTest)
  const porPregunta = new Map<string, number>()

  for (const r of respuestas) {
    if (!delTest.has(r.questionId)) {
      problemas.push({
        tipo: 'fuera_del_test',
        questionId: r.questionId,
        detalle: 'La opcion elegida no pertenece a este test',
      })
      continue
    }
    porPregunta.set(r.questionId, (porPregunta.get(r.questionId) ?? 0) + 1)
  }

  for (const q of preguntasDelTest) {
    const veces = porPregunta.get(q) ?? 0
    if (veces === 0) {
      problemas.push({
        tipo: 'sin_contestar',
        questionId: q,
        detalle: 'La pregunta no tiene respuesta',
      })
    } else if (veces > 1) {
      problemas.push({
        tipo: 'repetida',
        questionId: q,
        detalle: `La pregunta tiene ${veces} respuestas y deberia tener una`,
      })
    }
  }

  return problemas
}
