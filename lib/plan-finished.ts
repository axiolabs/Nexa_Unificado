/**
 * ¿El plan ya pasó?, en una sola regla, compartida.
 *
 * La necesitan tres cosas — marcar asistencia, calificar, y decidir si el
 * formulario aparece — y la respuesta tiene que ser la misma en las tres. Con
 * tres comparaciones escritas a mano, un `endsAt` mal considerado en una de
 * ellas abre la puerta antes de tiempo o la deja cerrada para siempre, y el
 * síntoma es "no me aparece el botón" sin error en ninguna parte.
 *
 * **Por qué se deriva del reloj y no de `Plan.status = 'COMPLETED'`.** El enum
 * tiene `COMPLETED`, pero nada en el proyecto lo escribe: igual que `ATTENDED` y
 * `NO_SHOW` son valores que existen, se leen, y no tienen productor. Construir
 * la ventana de calificación sobre un estado que nadie pone es construir un
 * feature que no se puede alcanzar. Con la hora de fin no hace falta productor:
 * la regla se cumple sola cuando pasa el tiempo, que es lo que un calendario
 * debería hacer. Cuando exista el job que marque `COMPLETED` (o el organizador
 * cierre el plan a mano), esta funcion se puede apoyar en el estado **además**
 * de la hora, nunca en vez de la hora.
 */

/**
 * Lo minimo que hace falta para responder "¿termino?".
 *
 * `string | Date` y no solo `Date` por un motivo concreto: el servidor tiene
 * `Date` de Prisma y el cliente tiene el ISO del `JSON`. Sin la union, el
 * cliente tendria que convertir a mano en cada llamada, y un `new Date` sobre
 * algo que no es fecha da `NaN`; `NaN <= ahora` es `false`, asi que la seccion
 * no apareceria **nunca y sin error en ninguna parte**. Que la funcion acepte las
 * dos formas y normalice adentro es lo que evita ese fallo silencioso, y por eso
 * hay tests que la llaman con strings.
 */
export type PlanParaSaberSiTermino = { startsAt: Date | string; endsAt: Date | string | null }

/** ISO o `Date` a milisegundos, o `NaN` si no hay fecha. Nunca tira. */
function instante(valor: Date | string): number {
  return valor instanceof Date ? valor.getTime() : new Date(valor).getTime()
}

/**
 * El evento ya paso.
 *
 * Con `endsAt`, cuando la hora de fin ya esta. Sin `endsAt`, cuando la hora de
 * inicio ya esta: es el unico momento del que sabemos algo sin inventar un
 * numero. Podria haberse inventado una duracion por defecto de 2 horas, y seria
 * un parametro mas que alguien tiene que mantener sincronizado con lo que el
 * organizador piensa que dura el plan. Con `startsAt` la regla es cruda pero no
 * puede quedar vieja: nadie la mantiene.
 *
 * El borde es `>=`: en el milisegundo exacto de la hora de fin, el evento
 * termino. Y no mira el status a proposito, porque "termino" y "se cancelo" son
 * dos cosas distintas y confundirlas hace que un plan cancelado sea calificable.
 * Para las dos preguntas juntas esta `planCerrable`.
 *
 * @param ahora Se pasa explícito para poder probar el borde sin esperar al reloj.
 */
export function planTermino(plan: PlanParaSaberSiTermino, ahora: Date = new Date()): boolean {
  return instante(plan.endsAt ?? plan.startsAt) <= ahora.getTime()
}

/** Lo que hace falta para poder marcar asistencia o calificar. */
export type PlanParaCerrar = PlanParaSaberSiTermino & { status: string }

/**
 * El plan se puede cerrar: **termino y no fue cancelado**.
 *
 * Un plan `CANCELLED` paso por la hora de fin como cualquier otro, pero no
 * hubo evento, asi que no hay a quien marcar ni experience que calificar. Sin
 * esta distincion, un plan cancelado abre la ventana de calificacion y el
 * organizador termina aceptando dibujos de un evento que no existio.
 */
export function planCerrable(plan: PlanParaCerrar, ahora: Date = new Date()): boolean {
  return plan.status !== 'CANCELLED' && planTermino(plan, ahora)
}

/**
 * La misma pregunta, pero para pintar el mensaje.
 *
 * Va aparte de `planCerrable` a proposito: si `planCerrable` devolviera
 * "porque no", el que llama tendria que volver a preguntar para poder escribir
 * el mensaje, y el texto se desincroniza del booleano en cuanto uno de los dos
 * cambia. Con esto, el render y el endpoint dicen exactamente lo mismo porque
 * usan la misma funcion.
 */
export function porQueNoSeCierra(plan: PlanParaCerrar, ahora: Date = new Date()): string | null {
  if (plan.status === 'CANCELLED') return 'Este plan se cancelo, asi que no hay nada que cerrar.'
  if (!planTermino(plan, ahora)) return 'El plan todavia no termino. Podes cerrarlo cuando pase la hora de fin.'
  return null
}
