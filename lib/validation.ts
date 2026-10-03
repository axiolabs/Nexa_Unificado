import { z } from 'zod'
import { MESSAGE_BODY_MAX } from './chat'
import { ETIQUETAS_EXPERIENCIA_IDS, RATING_MAX, RATING_MIN, RATING_TAGS_MAX } from './ratings'

/**
 * El email se normaliza ANTES de validar y no dentro del schema.
 *
 * Razon: `@unique` de Postgres es case-sensitive, asi que sin normalizar
 * "Ana@x.com" y "ana@x.com" serian dos usuarios distintos con la misma
 * direccion. Normalizar en la escritura hace que el indice unico de la base
 * cumpla su trabajo. (La alternativa seria `citext`, que es una migracion
 * adicional; con normalizar en la escritura alcanza y es mas portable.)
 */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase()
}

/**
 * El password NO se normaliza: ni trim ni lowercase.
 *
 * Cualquier transformacion destruye entropia y hace que "Contrasena" y
 * "contrasena" colisionen. Se comparan byte a byte con el que el usuario
 * escribio. Solo se acotan los extremos.
 */
const password = z
  .string({ error: 'La contrasena es obligatoria' })
  .min(12, 'La contrasena debe tener al menos 12 caracteres')
  // Tope para que un POST con un cuerpo de 10 MB no se convierta en un
  // hashing de 10 MB. 128 cubre de sobra cualquier contrasena razonable.
  .max(128, 'La contrasena no puede superar los 128 caracteres')

const name = z
  .string({ error: 'El nombre es obligatorio' })
  .trim()
  .min(2, 'El nombre debe tener al menos 2 caracteres')
  .max(80, 'El nombre no puede superar los 80 caracteres')

const email = z
  .string({ error: 'El email es obligatorio' })
  .max(254, 'Email demasiado largo')
  .pipe(z.email('El email no tiene un formato valido'))

export const registerSchema = z.object({
  name,
  email,
  password,
})

export const loginSchema = z.object({
  email,
  password: z.string({ error: 'La contrasena es obligatoria' }).min(1).max(128),
})

export type RegisterInput = z.infer<typeof registerSchema>
export type LoginInput = z.infer<typeof loginSchema>

/** Errores de validacion aplanados a { campo: mensaje } para el JSON de la API. */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {}
  for (const issue of error.issues) {
    const key = issue.path.join('.') || '_'
    if (!(key in out)) out[key] = issue.message
  }
  return out
}

/**
 * Parseo de la caja delimitadora del mapa.
 *
 * El `bbox` de la query string llega como texto en el orden de GeoJSON y de
 * `map.getBounds().toBBoxString()` de Leaflet: minLng,minLat,maxLng,maxLat. Se
 * reusa ese orden a proposito, para que el cliente mande la cadena que Leaflet
 * ya produce sin reordenarla.
 *
 * La forma de PARSEO es una tupla, porque es lo que sale de un `split(',')`.
 * La forma de TRABAJO es un objeto con nombre, porque abajo se lee `minLat` y
 * no `tuple[1]`. Confundir las dos es la forma mas comun de arruinar un
 * parser: la tupla nunca debió pasar de esta funcion.
 */
const bboxTupleSchema = z
  .tuple([z.number(), z.number(), z.number(), z.number()])
  .superRefine(([minLng, minLat, maxLng, maxLat], ctx) => {
    // Los cuatro valores tienen que estar en rango, no solo dos. Un chequeo
    // unilateral (`minLat < -90` y `maxLng > 180`) deja pasar el extremo
    // opuesto, y esos casos igual terminarian rechazados por el tope de
    // amplitud de mas abajo, pero con un mensaje que no dice la causa real.
    if (minLat < -90 || maxLat < -90 || minLat > 90 || maxLat > 90) {
      ctx.addIssue({ code: 'custom', message: 'La latitud debe estar entre -90 y 90' })
    }
    // minLng > maxLng es valido y significa "cruza el antimeridiano", asi que
    // aca NO se valida el orden de longitud. Solo que los valores entren en
    // rango.
    if (minLng < -180 || maxLng < -180 || minLng > 180 || maxLng > 180) {
      ctx.addIssue({ code: 'custom', message: 'La longitud debe estar entre -180 y 180' })
    }
    if (minLat > maxLat) {
      ctx.addIssue({ code: 'custom', message: 'minLat no puede ser mayor que maxLat' })
    }
    if (lngSpan(minLng, maxLng) > MAX_LNG_SPAN) {
      ctx.addIssue({
        code: 'custom',
        message: `La caja abarca mas de ${MAX_LNG_SPAN} grados de longitud; achicarla`,
      })
    }
    if (latSpan(minLat, maxLat) > MAX_LAT_SPAN) {
      ctx.addIssue({
        code: 'custom',
        message: `La caja abarca mas de ${MAX_LAT_SPAN} grados de latitud; achicarla`,
      })
    }
  })

export type Bbox = {
  minLat: number
  maxLat: number
  minLng: number
  maxLng: number
}

/**
 * Tope de amplitud. Sin esto, `bbox=-90,-180,90,180` devuelve el mundo entero.
 *
 * Exportados porque el calculo inverso (de centro y zoom a caja) tiene que
 * respetar el mismo tope. Ver `lib/map-bbox.ts`: si el mapa construye una caja
 * mas ancha que la que la API acepta, la pagina pide algo que vuelve con 400 y
 * el sintoma es "el mapa no carga", sin relacion aparente con el zoom.
 */
export const MAX_LNG_SPAN = 60
export const MAX_LAT_SPAN = 30

function lngSpan(minLng: number, maxLng: number) {
  // Al cruzar el antimeridiano, la longitud total es la suma de las dos partes.
  return minLng <= maxLng ? maxLng - minLng : 180 - minLng + (maxLng + 180)
}

const latSpan = (minLat: number, maxLat: number) => maxLat - minLat

/**
 * Interpreta el parametro `bbox` de la query string.
 *
 * Devuelve un resultado discriminado en vez de tirar la excepcion: el route
 * handler la convierte en 400 con el mensaje, sin try/catch.
 */
export function parseBbox(
  raw: string | null | undefined,
): { ok: true; bbox: Bbox } | { ok: false; error: string } {
  if (!raw) return { ok: false, error: 'Falta el parametro bbox (minLng,minLat,maxLng,maxLat)' }

  const parts = raw.split(',').map((s) => s.trim())
  if (parts.length !== 4) {
    return { ok: false, error: 'bbox necesita exactamente 4 valores: minLng,minLat,maxLng,maxLat' }
  }

  // Number('') es 0 y Number('abc') es NaN: ambos tienen que quedar afuera
  // antes de que el schema los compare, o "abc" pasaria como 0.
  const nums: number[] = []
  for (const p of parts) {
    if (p === '') return { ok: false, error: `bbox tiene un valor vacio: "${raw}"` }
    const n = Number(p)
    if (!Number.isFinite(n)) return { ok: false, error: `bbox no es numerico: "${p}"` }
    nums.push(n)
  }

  const parsed = bboxTupleSchema.safeParse(nums as [number, number, number, number])
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'bbox invalido' }

  const [minLng, minLat, maxLng, maxLat] = parsed.data
  return { ok: true, bbox: { minLat, maxLat, minLng, maxLng } }
}


/**
 * Listas cerradas que la query string no puede exceder.
 *
 * Duplican los enums de Prisma a proposito, y eso tiene un costo que conviene
 * conocer: si se agrega una categoria al enum y no se agrega aca, el filtro de
 * esa categoria devuelve 400 en vez de resultados. Se acepta, porque el otro
 * extremo -- castear el input a enum sin validar y dejar que lo rechace
 * Postgres -- produce un 500 con un mensaje que no sirve para nada.
 * `checkEnumListsAreInSync` en los tests falla si se desincronizan.
 *
 * Ahora viven en `lib/enums.ts` y se re-exportan desde aca. La mudanza no fue
 * estetica: el explorador importaba estas listas de un solo lugar y por eso
 * jamas vio que las suyas no cuadraran. Ver el comentario de `lib/enums.ts`.
 */
export { PLACE_CATEGORIES, CATEGORY_LABELS } from './enums'
// El `export ... from` de arriba NO deja los nombres en el ambito local, asi que
// los type guards de abajo necesitan su propio import. Sin esto compila el
// re-export y revienta en la firma del guard.
import { PLACE_CATEGORIES } from './enums'

/**
 * Type guards sobre las listas cerradas.
 *
 * Devuelven `v is <union>` para que el valor narrowede en el punto de uso. Sin
 * el predicado hay que castear a mano en cada handler, y un cast a mano es un
 * `any` disfrazado: no avisa cuando la lista y el enum se desincronizan.
 */
export function isPlaceCategory(v: string): v is (typeof PLACE_CATEGORIES)[number] {
  return (PLACE_CATEGORIES as readonly string[]).includes(v)
}

/**
 * Crear un plan.
 *
 * `placeId` es obligatorio y el modelo lo exige igual (`Plan.placeId` no es
 * nullable y la FK es `Restrict`): no existen planes virtuales. Si en el futuro
 * se quisiera "salir a caminar sin destino fijo", es otro modelo, no un `placeId`
 * opcional.
 *
 * `capacity` tiene piso 2 y no 1: un plan de una persona no es un plan, es una
 * cita, y el modelo de participacion (solicitar, ser aceptado, calificar) no
 * tiene nada que hacer ahi.
 */
export const createPlanSchema = z
  .object({
    title: z
      .string({ error: 'El titulo es obligatorio' })
      .trim()
      .min(3, 'El titulo debe tener al menos 3 caracteres')
      .max(120, 'El titulo no puede superar los 120 caracteres'),
    description: z.string().trim().max(2000, 'La descripcion es demasiado larga').optional(),
    placeId: z.string({ error: 'El lugar es obligatorio' }).min(1, 'El lugar es obligatorio').max(64),
    startsAt: z.coerce.date({ error: 'La fecha de inicio es obligatoria' }),
    endsAt: z.coerce.date().optional(),
    capacity: z.coerce
      .number({ error: 'La capacidad es obligatoria' })
      .int('La capacidad debe ser un numero entero')
      .min(2, 'Un plan necesita al menos 2 personas')
      .max(50, 'La capacidad no puede superar las 50 personas'),
  })
  .refine((p) => p.startsAt.getTime() > Date.now(), {
    message: 'La fecha de inicio tiene que estar en el futuro',
    path: ['startsAt'],
  })
  .refine((p) => !p.endsAt || p.endsAt.getTime() > p.startsAt.getTime(), {
    message: 'La hora de fin tiene que ser posterior a la de inicio',
    path: ['endsAt'],
  })
  .refine((p) => !p.endsAt || p.endsAt.getTime() - p.startsAt.getTime() <= 24 * 3600 * 1000, {
    message: 'Un plan no puede durar mas de 24 horas',
    path: ['endsAt'],
  })

/**
 * Enviar el test de personalidad.
 *
 * `testId` va en el body a proposito, aunque el servidor sabe cual es la version
 * activa. Sin el, no hay forma de distinguir "la persona respondio mal" de "mientras
 * contestaba se publico la v2 y sus respuestas son de la v1", y las dos cosas no
 * pueden terminar igual: la primera se rechaza, la segunda se vuelve a empezar.
 * El endpoint compara contra la activa y devuelve 409 si no coinciden.
 *
 * El cliente manda `questionId` ademas de `optionId` aunque `questionId` se pueda
 * deducir del `optionId`. Mandandolo, la base puede rechazar un `optionId` de otro
 * test en la misma consulta y el chequeo no depende de una deduccion.
 *
 * `answers` tiene max 200 y no el numero de preguntas del test: el numero
 * verdadero lo valida `verificarRespuestas` contra el contenido real, y un teto
 * fijo aca frena el body gigante antes de tocar la base.
 */
export const personalitySubmissionSchema = z.object({
  testId: z.string({ error: 'Falta el test' }).min(1, 'Falta el test').max(64),
  answers: z
    .array(
      z.object({
        questionId: z.string().min(1, 'Falta la pregunta').max(64),
        optionId: z.string().min(1, 'Falta la opcion').max(64),
      }),
    )
    .min(1, 'Contesta al menos una pregunta')
    .max(200, 'Demasiadas respuestas'),
})

/**
 * El cuerpo de un mensaje de chat.
 *
 * `MESSAGE_BODY_MAX = 1000` es un tope de discusion, no de base: con el tope
 * alto, "escribime el numero" se resuelve por DM en un mensaje de 40
 * caracteres y el chat del plan deja de ser el lugar del plan. El limite corto
 * tambien hace que el `max` del schema sea una defensa real y no decorativa.
 *
 * `.trim()` antes del `min(1)`: sin eso, un cuerpo de puros espacios pasa el
 * `min(1)` y se guarda un mensaje que en pantalla es una linea en blanco, y el
 * conteo de mensajes del plan dice que hay uno mas.
 *
 * El numero vive en `lib/chat.ts` y no aca, aunque el schema sea lo que lo
 * aplica. Motivo concreto: el cliente necesita el tope para el contador de
 * caracteres y para bloquear el envio, y este archivo importa zod. Si el limite
 * viviera aca, el contador obligaria a meter el validador entero en el bundle
 * del cliente para leer una constante. En `lib/chat.ts`, que no depende de
 * nada, el limite se importa de los dos lados sin arrastrar zod.
 */
export const messageSchema = z
  .object({
    body: z
      .string({ error: 'Falta el mensaje' })
      .trim()
      .min(1, 'El mensaje no puede estar vacio')
      .max(MESSAGE_BODY_MAX, `El mensaje puede tener hasta ${MESSAGE_BODY_MAX} caracteres`),
  })
  .strict()

/**
 * El voto de una calificacion.
 *
 * El rango 1..5 no se puede escribir con `z.number().int()` solamente: eso
 * acepta `-5` y `9000`, y un `Int` de la base tambien. La combinacion con
 * `RATING_MIN`/`RATING_MAX` de `lib/ratings.ts` es la que hace que el endpoint y
 * la pantalla compartan el mismo rango, y si uno de los dos se mueve, el otro
 * se cae en el typecheck.
 *
 * **`tags` es un enum cerrado, no un `string`.** Este es el punto donde se decide
 * si el producto puede guardar un juicio sobre una persona, y por eso el enum
 * esta en el schema y no solo en la UI. Si el campo fuera un texto, el cliente
 * mandaria lo que quisiera y la garantia de "nada en el modelo puede afirmar que
 * Fulano es tal" (§5.9 de `docs/modelo-datos.md`) se perderia en el borde, que es
 * donde se pierden las garantias. Con `z.enum` sobre el set de
 * `lib/ratings.ts`, lo unico que se puede guardar esta en la lista, y la lista
 * esta revisada.
 *
 * El `.strict()` hace que mandar `comment` — el campo de texto libre que existio
 * hasta §16.10 — sea un 400 y no un dato ignorado. El endpoint viejo tiene que
 * morir, no volverse opcional: un campo que el servidor acepta y descarta deja
 * la sensacion de que el texto se guardo.
 */
export const ratingSchema = z
  .object({
    // **Sin `coerce`, a diferencia de las fechas y el cupo.** Ahi tiene sentido:
    // llegan de un `<input>`, que manda texto. Aca las estrellas llegan de un
    // click, o sea un numero de verdad, y coercionar abre la puerta a que
    // `true` se guarde como una estrella (`Number(true) === 1`), o que un array
    // `[5]` se guarde como cinco estrellas. Un endpoint que acepta cualquier
    // cosa que se pueda convertir en numero no esta validando la calificacion:
    // esta adivinando.
    rating: z
      .number({ error: 'Falta la calificacion' })
      .int('La calificacion tiene que ser un numero entero de estrellas')
      .min(RATING_MIN, `La calificacion va de ${RATING_MIN} a ${RATING_MAX} estrellas`)
      .max(RATING_MAX, `La calificacion va de ${RATING_MIN} a ${RATING_MAX} estrellas`),
    // `default([])` para que "no marco ninguna" no dependa de que el cliente
    // recuerde mandar el campo. El `max` evita el "marco todas": sin tope, la
    // accion de menor esfuerzo es la que mas gente hace y el conteo deja de
    // decir algo. Y el `refine` evita que la misma etiqueta cuente dos veces en
    // el tally: la UI no lo permite, pero el endpoint no puede confiar en la UI.
    tags: z
      .array(z.enum(ETIQUETAS_EXPERIENCIA_IDS, { error: 'Esa etiqueta no existe' }))
      .max(RATING_TAGS_MAX, `Se pueden marcar hasta ${RATING_TAGS_MAX} etiquetas`)
      .default([])
      .refine((v) => new Set(v).size === v.length, 'No se puede repetir una etiqueta'),
  })
  .strict()

export type RatingInput = z.infer<typeof ratingSchema>

/**
 * Marcar asistencia. El organizador dice quien estuvo.
 *
 * Solo `ATTENDED` y `NO_SHOW`, y no `ACCEPTED`: volver a `ACCEPTED` seria decir
 * "no se", que el schema no tiene forma de representar, y ademas sacaria a la
 * persona del numerador **y** del denominador de la reliability de un plumazo.
 * Entre los dos valores si se puede corregir, porque una lista de asistencia se
 * arma a ojo y se corrige: eso es una decision sobre un hecho pasado y las dos
 * respuestas son las dos unicas.
 */
export const attendanceSchema = z
  .object({
    userId: z.string({ error: 'Falta la persona' }).min(1, 'Falta la persona').max(64),
    attendance: z.enum(['ATTENDED', 'NO_SHOW'], {
      error: 'La asistencia debe ser ATTENDED o NO_SHOW',
    }),
  })
  .strict()

/**
 * Los conjuntos cerrados de reportes, duplicados de los enums de Prisma.
 *
 * Mismo criterio que `PLACE_CATEGORIES`: `z.enum` sobre una lista que uno escribio
 * a mano castea el input a un enum real y no deja que llegue basura a Postgres,
 * y el `.default()`/`z.enum` es lo que evita un 500 por un valor inventado. La
 * alternativa, castear sin validar, produce un error de Postgres que no se puede
 * traducir a un mensaje de pantalla.
 *
 * Lo que NO se re-deriva aca es `ReportReason` por objetivo, que vive en
 * `lib/reports.ts` como `MOTIVOS_POR_OBJETIVO`. Esa tabla es logica de negocio --
 * "no se presento" no es un motivo de lugar -- y `motivoValido` la consulta. Si
 * el schema la aceptara entera, el endpoint tendria que volver a chequearla, y
 * quedarian dos reglas del mismo predicado en dos lugares.
 */

/** Los cuatro objetivos que se pueden denunciar. */
const REPORT_TARGETS = ['PLACE', 'PLAN', 'USER', 'MESSAGE'] as const

/** Los diez motivos del enum. El subconjunto por objetivo lo decide `reports.ts`. */
const REPORT_REASONS = [
  'CLOSED',
  'WRONG_INFO',
  'UNSAFE',
  'NO_SHOW_RISK',
  'MISLEADING',
  'HARASSMENT',
  'SPAM',
  'IMPERSONATION',
  'OFF_TOPIC',
  'OTHER',
] as const

/**
 * El cuerpo de una denuncia.
 *
 * **El id del objetivo va como `targetId`, no como `placeId`/`planId`/...**
 * cuatro campos opcionales. El motivo es que la base exige exactamente una FK
 * informada (`ModerationReport_exactamente_un_objetivo`), asi que un payload con
 * cuatro opcionales puede describir tres estados invalidos: ninguno, dos, o uno
 * que no corresponde al `target`. Con un solo `targetId` + `target` esos tres
 * casos no se pueden escribir, y la columna de la FK la elige el endpoint con un
 * `switch` que es el unico lugar donde se decide eso.
 *
 * `.strict()`: mandar `placeId` a mano tiene que ser un 400, no un campo
 * ignorado en silencio. Si el servidor acepta una forma y descarta la otra, la
 * UI da la sensacion de que el destino elegido es el que se guardo.
 *
 * `detail` es opcional y sin tope de vacio: `motivoValido` + `puedeReportar`
 * deciden si el motivo pedido exige texto. Acotarlo a 2000 es lo que evita que un
 * POST con un cuerpo de 10 MB se convierta en un reporte de 10 MB en la cola.
 */
export const reportSchema = z
  .object({
    target: z.enum(REPORT_TARGETS, { error: 'Ese tipo de denuncia no existe' }),
    targetId: z.string({ error: 'Falta el objetivo de la denuncia' }).min(1).max(64),
    reason: z.enum(REPORT_REASONS, { error: 'Ese motivo no existe' }),
    // `.optional()` y no `.default('')`: el endpoint tiene que poder distinguir
    // "no mande detalle" de "mande detalle vacio", porque `OTHER` exige texto y
    // los otros motivos no. Un `''` de relleno convertsiria el segundo en el
    // primero.
    detail: z.string().trim().max(2000, 'El detalle es demasiado largo').optional(),
  })
  .strict()

export type ReportInput = z.infer<typeof reportSchema>

/**
 * Cerrar un reporte de la cola.
 *
 * `OPEN` NO esta: volver a abrir un reporte ya cerrado no es una operacion que el
 * producto ofrezca, y aceptarla dejaria filas que cambian de estado sin que nadie
 * las mire, que es exactamente lo que `resolvedById` y `resolvedAt` existen para
 * evitar. Si aparece el caso, se decide el modelo, no se afloja el enum.
 *
 * `note` es opcional, pero el endpoint lo pide cuando el cierre es `DISMISSED`:
 * "estaba bien" es un juicio sobre algo que alguien|reporto, y un juicio sin
 * motivo escrito no deja aprender nada ni sirve para contar cuantos reportes eran
 * falsos. El numero de falsos es el que avisa si el producto genera ruido.
 */
export const reportResolutionSchema = z
  .object({
    status: z.enum(['RESOLVED', 'DISMISSED'], {
      error: 'El cierre debe ser RESOLVED o DISMISSED',
    }),
    note: z.string().trim().max(500, 'La nota es demasiado larga').optional(),
  })
  .strict()

export type ReportResolutionInput = z.infer<typeof reportResolutionSchema>

