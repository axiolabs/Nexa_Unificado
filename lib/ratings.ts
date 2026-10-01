/**
 * Calificacion del plan: escala, limites y copy. Todo puro, sin Prisma ni Next.
 *
 * Mismo criterio que `lib/chat.ts` y `lib/plan-join.ts`: las reglas que decide
 * el servidor y las que necesita pintar el cliente estan en el mismo archivo, y
 * se prueban sin base de datos ni DOM.
 *
 * El `Rating` califica **la experiencia, no a la persona** (§5.9 de
 * `docs/modelo-datos.md`): cuelga del `Plan`, no hay `ratedUserId`, y no existe
 * forma de calificar a otro participante. Eso no es una limitacion pendiente, es
 * la decision que evita reproducir el juicio social que el producto existe para
 * eliminar, asi que la UI no ofrece ni insinua calificar a alguien.
 */

/**
 * Escala de 1 a 5. El `Int` del schema no obliga a un rango; esto si.
 *
 * Escala 1 a 5, ratificada. Se habia dejado como supuesto, y un supuesto sin
 * ratificar vuelve tres pantallas mas adelante como pregunta de alcance. Se
 * ratifica asi: cinco estrellas y no diez, porque con diez la gente no usa la
 * mitad de la escala y el promedio se vuelve una medida de cuanto le gusta
 * evaluar; y no es un slider de 0 a 100 porque "0 de 100" y "no califique todavia"
 * se confundirian en el mismo campo. El `0` no existe a proposito: cero estrellas
 * es una opinion fuerte, y el caso de "todavia no voto" es `null`.
 */
export const RATING_MIN = 1
export const RATING_MAX = 5

/**
 * Cuantas etiquetas se pueden marcar.
 *
 * El equivalente del limite de caracteres que ya no existe, y por el mismo motivo:
 * sin tope, "marcar todas" es la accion de menor esfuerzo y la que mas gente
 * hace, y un tally donde todos marcaron todo no dice nada. Tres alcanzan para
 * decir "que es lo que define este lugar" y obligan a elegir.
 */
export const RATING_TAGS_MAX = 3

/**
 * El porque de "que se puede decir" son **etiquetas cerradas**, no texto libre.
 *
 * Este archivo tuvo `RATING_COMMENT_MAX = 500` y un `comment String?`. Se
 * quitaron. El motivo no fue que 500 fuera mucho: fue que un texto libre puede
 * contener lo unico que el modelo entero se propone que no exista.
 *
 * `Rating` no lleva `ratedUserId` porque la decision de §5.9 de
 * `docs/modelo-datos.md` es **estructural**: nada en el esquema puede afirmar que
 * Fulano es un imbecil. Esa garantia la daba la forma de la tabla, no una regla de
 * moderacion. Un campo de texto libre con el nombre del autor al lado la
 * deshace: cualquiera puede escribir ahi exactamente el juicio subjetivo sobre
 * una persona que la columna prohibia, solo que en una celda en vez de en una
 * columna, y sin ninguna regla de negocio que lo impida. Con `ModerationReport`
 * diferido a proposito, no hay ni forma de denunciarlo ni de sacarlo de
 * circulacion: el dano ya ocurrio cuando alguien lo leyo.
 *
 * Agregar moderacion despues no repara eso; lo contiene. Y el tipo de contencion
 * mas chico que se puede agregar (un `hidden`) tiene su propio problema: si un
 * rating oculto sale del promedio, ocultar pasa a ser una forma de curar la nota,
 * y si no sale, ocultar no protege el promedio de la distorsion. Son las dos
 * fuentes de verdad que este proyecto ya pago una vez.
 *
 * Con etiquetas cerradas el vector no existe, no hace falta ninguna contencion, y
 * la garantia estructural vuelve a ser la del principio.
 *
 * **Cada etiqueta es del lugar o de la experiencia, nunca de una persona.** No
 * hay etiqueta que admita "el grupo" como sujeto, porque "grupo chico" habla del
 * lugar y "FULANO es raro" habla de alguien, y la diferencia esta en el
 * vocabulario, no en la intencion de quien marca. Por eso el set es un enum
 * cerrado y el servidor lo valida: un cliente podria mandar cualquier string si
 * el campo fuera texto, y la garantia se perderia en el borde.
 */
export const ETIQUETAS_EXPERIENCIA = [
  { id: 'buena_ubicacion', label: 'Buena ubicacion' },
  { id: 'ambiente_relajado', label: 'Ambiente relajado' },
  { id: 'buena_comida', label: 'Buena comida' },
  { id: 'facil_llegar', label: 'Facil de llegar' },
  { id: 'grupo_chico', label: 'Grupo chico' },
  { id: 'vale_la_pena', label: 'Vale la pena' },
  { id: 'volveria', label: 'Volveria' },
  { id: 'faltaron_espacios', label: 'Faltaron espacios' },
] as const

export type EtiquetaExperiencia = (typeof ETIQUETAS_EXPERIENCIA)[number]['id']

/** Los ids, para validar contra el set sin recorrerlo. */
export const ETIQUETAS_EXPERIENCIA_IDS = ETIQUETAS_EXPERIENCIA.map((e) => e.id) as EtiquetaExperiencia[]

/** El id como tipo, o `undefined` si no existe: el predicado para el enum de zod. */
export function esEtiquetaValida(valor: string): valor is EtiquetaExperiencia {
  return (ETIQUETAS_EXPERIENCIA_IDS as string[]).includes(valor)
}

/** El texto que se ve en pantalla, desde el id. */
export function etiquetaDe(id: string): string {
  return ETIQUETAS_EXPERIENCIA.find((e) => e.id === id)?.label ?? id
}

/**
 * Un voto tiene que ser un numero de estrella, no un integer cualquiera.
 *
 * El `rating Int` de la base acepta `-5` y `9000`, y sin este recorte un promedio
 * de reputation con un solo voto de 9000 rompe la escala de la pantalla. La
 * validacion de verdad esta en el schema de zod del endpoint; esta es la misma
 * regla en forma de predicado, para que la UI pueda decidir que stars prender
 * sin duplicar el rango en un array.
 */
export function esRatingValido(valor: number): boolean {
  return Number.isInteger(valor) && valor >= RATING_MIN && valor <= RATING_MAX
}

/** Los valores que se pueden dibujar como estrellas, del mas malo al mejor. */
export const ESCALA_RATING = Array.from(
  { length: RATING_MAX - RATING_MIN + 1 },
  (_, i) => RATING_MIN + i,
)

/**
 * El voto de una persona, si ya lo dejo.
 *
 * `null` es "todavia no voto" y `0` no existe como rating, asi que el
 * `undefined`/`null` no se confunde con un cero en ningun render. Los `tags` son
 * ids del set cerrado, no texto: llegan de la base y se traducen a pantalla con
 * `etiquetaDe`.
 */
export type VotoPropio = { rating: number; tags: string[]; updatedAt: string } | null

/**
 * El promedio que se muestra, con el caso de cero votos explicito.
 *
 * Un `NaN` en pantalla es peor que un "todavia no califico": el primero parece un
 * bug de calculo, el segundo es informacion. Por eso devuelve `null` en vez de
 * 0 cuando no hay votos, y el promedio se redondea a un decimal para que 4 de 5
 * no se vea como 4.0.
 */
export function promedioDe(votos: { rating: number }[]): number | null {
  if (votos.length === 0) return null
  const suma = votos.reduce((acc, v) => acc + v.rating, 0)
  return Math.round((suma / votos.length) * 10) / 10
}

/**
 * Como se lee el promedio en pantalla, desde los votos.
 *
 * Es un caso particular de `textoDelPromedioConCuenta`, que esta aparte porque el
 * cliente del detalle **no tiene los votos**: la respuesta del `GET` le manda el
 * promedio y el conteo ya calculados, y un promedio hecho con un voto de los dos
 * que hay en pantalla se veria distinto del que quedo guardado.
 */
export function textoDelPromedio(votos: { rating: number }[]): string {
  return textoDelPromedioConCuenta(promedioDe(votos), votos.length)
}

/**
 * El mismo texto, desde el promedio y el conteo.
 *
 * El copy vive **aca** y no en el componente, y no por gusto: es el mismo renglon
 * en el detalle, en el chat del plan y en el futuro promedio del lugar, y tres
 * versiones de la misma frase divergen sin que nada se caiga.
 */
export function textoDelPromedioConCuenta(promedio: number | null, cantidad: number): string {
  if (promedio === null) return 'Todavia no hay calificaciones'
  if (cantidad === 1) return `${promedio} de ${RATING_MAX}, de 1 persona`
  return `${promedio} de ${RATING_MAX}, de ${cantidad} personas`
}

/**
 * Que etiquetas se marcaron, y cuantas.
 *
 * Vive junto a `promedioDe` por la misma razon que el promedio vive en el
 * servidor: el cliente no tiene los votos, y un conteo de etiquetas hecho en
 * pantalla con lo que ve seria distinto del guardado.
 *
 * Ordenado por apariciones y luego por `id`, para que el mismo conjunto siempre
 * se lea igual. El desempate va por `id` y **no** por `label` a proposito: los
 * labels son texto que se traduce, y ordenar por el texto daria dos ordenes
 * distintos segun el idioma de quien lee, para el mismo conjunto de votos.
 *
 * `[]` cuando nadie marco ninguna, que es informacion distinta de `null`.
 */
export function tallyDe(votos: { tags: string[] }[]): { id: string; count: number }[] {
  const cuenta = new Map<string, number>()
  for (const v of votos) {
    for (const t of v.tags) cuenta.set(t, (cuenta.get(t) ?? 0) + 1)
  }
  return [...cuenta.entries()]
    .map(([id, count]) => ({ id, count }))
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id))
}

/**
 * Quien puede calificar, aparte del gate del endpoint.
 *
 * El endpoint exige las dos cosas (participo Y el plan termino). Esta funcion
 * es solo la parte de la participacion, para que la UI no tenga que repetir el
 * filtro de estado del plan.
 */
export function puedeCalificar(participacion: { status: string } | null | undefined): boolean {
  return participacion?.status === 'ATTENDED'
}
