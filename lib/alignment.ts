/**
 * Alineacion entre los rasgos de una persona y los rasgos de un lugar.
 *
 * Es la operacion que el spec (`modelo-datos.md` §5.1) describe como el corazon
 * del producto: el test de personalidad y la curaduria de lugares comparten los
 * MISMOS ejes (`Trait`), asi que "esta persona y este lugar" se responde con una
 * suma, sin IA.
 *
 * `PersonalityScore.value` y `PlaceTrait.weight` son los dos operandos, y los
 * dos son datos ya persistidos: no se inventa nada para calcular esto.
 *
 * **Por que vive en `lib/` y no en el endpoint.** Misma razon que
 * `lib/plan-join.ts` y `lib/personality.ts`: si el calculo vive adentro del
 * route handler, la unica forma de probarlo es levantando la base y las
 * sesiones. Adentro no hay nada que testear. Ademas el numero se muestra en la
 * pantalla de aprobaciones, que es una decision de producto: cuando cambie la
 * formula tiene que cambiar en un lugar, no en tres.
 *
 * **Por que `null` y no `0`.** Es el mismo principio que `reliabilityFor`: "no
 * tengo datos" y "el numero dio cero" son cosas distintas, y confundirlas
 * hace que un postulante sin test parezca alguien cuyos rasgos no encajan con el
 * lugar. Un `0` aqui significa que se compararon rasgos de verdad y la
 * ponderacion dio cero. Un `null` significa que no hay nada que decir. En la
 * pantalla se ven distinto.
 */
export type Alineacion = {
  /**
   * Suma cruda de `valor * peso`. Es exactamente la formula del spec (§5.1).
   * Se expone aparte porque es lo auditable: el `normalizado` sale de el.
   */
  score: number
  /**
   * `score` dividido por la suma de los VALORES ABSOLUTOS de los pesos.
   *
   * Es lo que hace comparables a dos postulantes del mismo plan: el `score`
   * crudo depende de cuantos rasgos tenga el lugar, y dos lugares con tres y
   * con cinco rasgos no dan numeros comparables entre si. Dividir por la masa
   * (siempre positiva, por eso el valor absoluto) lo convierte en un promedio
   * ponderado, que queda en las mismas unidades que los rasgos.
   *
   * Se usa `|peso|` y no `peso` a proposito: un lugar puede tener peso
   * negativo en un rasgo ("este bar no es de ambiente calmo"). Si el
   * denominador fuera la suma de los pesos, dos pesos de signo contrario casi
   * se cancelarian y la alineacion explotaria a infinito o daria NaN.
   */
  normalizado: number
  /**
   * Cuantos rasgos se compararon de verdad: los que el lugar tiene con peso
   * distinto de cero **y** la persona tiene puntaje.
   *
   * Se expone porque es la cobertura del numero. Una alineacion sobre 1 rasgo
   * no es la misma señal que una sobre 5, y sin este numero la pantalla los
   * muestra igual y el organizador los lee igual.
   */
  traits: number
}

/**
 * Calcula la alineacion, o `null` si no hay nada comparable.
 *
 * Los dos mapas van por `traitId` (el `Trait` compartido), no por el `key` del
 * trait: el `key` es texto legible para humanos y la base lo garantiza unico
 * como strings, mientras que las dos relaciones ya apuntan a `Trait.id`. Usar
 * `key` aca seria el mismo bug que ya se cometio una vez al indexar rangos por
 * una columna y consultarlos por otra (ver seccion 14.10).
 *
 * @param valores `traitId` -> `PersonalityScore.value` de la persona.
 * @param pesos   `traitId` -> `PlaceTrait.weight` del lugar.
 */
export function alineacionDe(
  valores: ReadonlyMap<string, number>,
  pesos: ReadonlyMap<string, number>,
): Alineacion | null {
  let score = 0
  let masa = 0
  let traits = 0

  // Se recorre en orden de `traitId` y no en el del mapa a mano. La suma de
  // flotantes no es asociativa: sobre los mismos datos, `1.55` y
  // `1.5499999999999998` son el mismo numero matematicamente y distinto bit a
  // bit, y el resultado dependeria de en que orden devolvio las filas la base.
  // Como este numero se muestra en pantalla y va a terminar en snapshots de
  // tests, un orden fijo evita un test que pasa un dia y falla otro por el orden
  // de filas. Cuestion de reproducibilidad, no de precision.
  for (const traitId of [...pesos.keys()].sort()) {
    const peso = pesos.get(traitId)
    if (peso === undefined) continue
    const valor = valores.get(traitId)
    // Un peso de cero no aporta nada y ademas falsearia el contador de
    // cobertura: "este rasgo pesa 0 aca" no es un rasgo comparado.
    if (valor === undefined || peso === 0) continue
    // Un `NaN` o un `Infinity` en la base envenena la suma para siempre y el
    // resultado sale `NaN` en pantalla, que se renderiza como "NaN" y no como
    // un error. Se filtra aca, en el borde, y no en la vista.
    if (!Number.isFinite(valor) || !Number.isFinite(peso)) continue

    score += valor * peso
    masa += Math.abs(peso)
    traits += 1
  }

  // Sin rasgos comparados, o con toda la masa en cero, no hay promedio que
  // calcular. Devolver 0 seria mentir: daria un "no encaja" donde en realidad no
  // se sabe nada.
  if (traits === 0 || masa === 0) return null

  return { score, normalizado: score / masa, traits }
}
