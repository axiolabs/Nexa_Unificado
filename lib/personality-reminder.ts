/**
 * Cuando hay que recordar el test de personalidad, y que decir.
 *
 * Puro, en `lib/`, y no dentro del componente: es la misma razon por la que el
 * boton de unirse esta en `lib/plan-join.ts`. Lo que se puede decidir sin DOM se
 * decide aca y se testea; el componente solo pinta. Ademas, cuando esto vivia en
 * `explore-client.tsx` no se podia testear sin levantar el componente entero, que
 * arrastra Leaflet.
 *
 * El recordatorio es pasivo por definicion (§14.7 de `docs/decisiones-auth.md`).
 * Estas dos funciones son las unicas que deciden si aparece.
 */

/** Lo que devuelve `GET /api/personality`. */
export type TestStatus = {
  hayTest: boolean
  hayResultado: boolean
  version: number | null
  resultadoVersion?: number | null
}

/**
 * Si toca recordar el test.
 *
 * Tres condiciones, y el orden importa:
 *
 * - sin test activo no se recuerda nada. `hayTest` va primero a proposito: no hay
 *   nada que ofrecer e insistir en hacer un test que no existe es peor que no
 *   recordar. Que venga primero no es un detalle de estilo, es la condicion que
 *   apaga todo lo demas.
 * - sin resultado, se recuerda: es el caso normal.
 * - con resultado de una version vieja, tambien: publicar una v2 deja disponible
 *   una nueva y el boton de rehacer tiene que seguir ahi. Con solo `hayResultado`
 *   en el condicional este caso no existiria y el boton desapareceria solo, sin que
 *   nadie lo pidiera.
 *
 * `oculto` es la X. Se respeta en el estado de la pantalla y no se persiste: si
 * alguien cerro el banner hoy y manana se publico una v2 que si le interesa, tiene
 * que volver a verlo.
 */
export function tocaRecordar(test: TestStatus | null, oculto: boolean): boolean {
  if (!test || oculto) return false
  if (!test.hayTest) return false
  if (!test.hayResultado) return true

  // `null` y `undefined` se tratan igual a proposito, y no con un `!== null` pelado.
  // `resultadoVersion` es opcional en el tipo, y con la comparacion suelta un
  // `undefined` pasaba los dos tests y daba `true`: alguien con el resultado ya
  // cargado y el campo ausente veia "hay una version nueva" sin que exista.
  const v = test.resultadoVersion
  if (v === null || v === undefined) return false
  return v !== test.version
}

/**
 * El texto del recordatorio.
 *
 * Son dos mensajes y no uno parametrizado porque son para estados distintos: "no
 * lo hiciste" es una invitacion, y "hay una version nueva" es una novedad. Un
 * unico texto con dos partes obliga a leer lo que no aplica.
 */
export function mensajeRecordatorio(test: TestStatus): string {
  return test.hayResultado
    ? 'Hay una version nueva del test de personalidad.'
    : 'Hace el test de personalidad: son ocho preguntas y podes saltearlas.'
}

/** El texto del enlace. */
export function textoEnlaceRecordatorio(test: TestStatus): string {
  return test.hayResultado ? 'Ver la nueva' : 'Hacer el test'
}
