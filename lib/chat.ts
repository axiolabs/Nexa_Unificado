/**
 * Chat dentro del plan: cursor, tipos y formato.
 *
 * Sin imports de Prisma ni de Next a proposito, como `lib/authz.ts`: este
 * modulo lo importan el route handler y el Client Component, y las reglas de
 * `Message` (orden, cursor, cuerpo) son las mismas de los dos lados.
 *
 * La unica excepcion es `import type` de `ParticipationStatus`, que no genera
 * codigo: el gate de abajo tiene que nombrar los estados y no conviene hacerlo
 * con strings sueltos.
 */

import type { ParticipationStatus } from '@prisma/client'

/**
 * Un mensaje, tal como lo ve el cliente.
 *
 * `mine` se calcula en el servidor. La alternativa era que el cliente se
 * bajara su propio id por `/api/auth/me` para comparar, o que adivinara. Ambas
 * son una llamada de mas por abrir el chat, y un `authorId === sesion.id` mal
 * resuelto alinea al revés todas las burbujas sin que nada falle.
 *
 * `deletedAt` se expone aunque hoy nada lo pueda setear. El borrado logico ya
 * esta en el modelo (§13.4) y en la moderacion; si la API no lo devolviera,
 * el dia que se empiece a borrar el cuerpo seguiria saliendo en pantalla y
 * habria que cambiar la respuesta, o sea romper clientes.
 */
export type Mensaje = {
  id: string
  body: string
  createdAt: string
  authorId: string
  authorName: string
  mine: boolean
  deletedAt: string | null
}

/**
 * La posicion del chat: cuanto hay, y desde donde seguir leyendo.
 *
 * `nextCursor` es `null` cuando la pagina vino corta, o sea que se leyo todo lo
 * que habia. El cliente lo usa para NO seguir preguntando: un poll que siempre
 * pide y siempre recibe vacio es una request cada N segundos para siempre, por
 * participating en un plan de la semana pasada.
 */
export type ChatPoll = {
  messages: Mensaje[]
  nextCursor: string | null
  hasMore: boolean
}

/**
 * El cursor es `(createdAt, id)`, no `createdAt` solo.
 *
 * `createdAt` tiene precision de milisegundo, y dos personas escribiendo en el
 * mismo milisegundo es perfectamente posible: dos mensajes seguidos, o dos
 * personas en dos pestanas. Con un cursor de `createdAt` solo, el segundo
 * mensaje cae en el borde y hay dos finales malos: si la consulta es
 * `createdAt > cursor`, el segundo se pierde; si es `>=`, el primero vuelve a
 * aparecer en cada poll y la pantalla duplica la conversacion.
 *
 * El `id` desempata. Es unico, asi que `(createdAt, id)` es un orden TOTAL: no
 * hay dos mensajes con la misma clave, y `>` sobre la tupla nunca se come ni
 * repite una fila. Por eso la consulta se descompone en el `OR` de abajo y no
 * se puede escribir como una comparacion de tuplas en Prisma.
 *
 * El formato es opaco (base64) a proposito: el cliente no arma cursores, los
 * reusa. Si manana el orden cambia, se cambia el encode y no hay que tocar el
 * cliente. Y un cursor invalido es un 400 explicito, no un "empezamos de nuevo":
 * resetear en silencio reenvia el chat entero y el cliente puede duplicarlo.
 */
export type Cursor = { createdAt: Date; id: string }

export function encodeCursor(c: Cursor): string {
  return Buffer.from(`${c.createdAt.toISOString()}|${c.id}`, 'utf8').toString('base64url')
}

export function decodeCursor(bruto: string): Cursor | null {
  let texto: string
  try {
    texto = Buffer.from(bruto, 'base64url').toString('utf8')
  } catch {
    return null
  }
  const corte = texto.indexOf('|')
  if (corte <= 0) return null
  const cuando = new Date(texto.slice(0, corte))
  const id = texto.slice(corte + 1)
  if (Number.isNaN(cuando.getTime()) || id.length === 0) return null
  return { createdAt: cuando, id }
}

/**
 * El `where` de "lo que hay despues de este cursor".
 *
 * `OR` en vez de un `AND` con dos condiciones: `createdAt > c` solo, mas
 * `createdAt = c AND id > id`, es el descompuesto correcto de `(createdAt, id) >
 * (c, id)`. Con `AND` entre las dos ramas no habria ningun mensaje con
 * `createdAt` mayor, o sea que el filtro seria siempre falso.
 */
export function whereDespuesDe(planId: string, cursor: Cursor) {
  return {
    planId,
    OR: [
      { createdAt: { gt: cursor.createdAt } },
      { createdAt: cursor.createdAt, id: { gt: cursor.id } },
    ],
  }
}

/**
 * Orden total del chat. El `id` va explicito aunque hoy no desempate nunca:
 * sin el, el orden de dos mensajes del mismo milisegundo es el que devuelva
 * la base, y puede cambiar entre dos llamadas idénticas.
 */
export const ORDEN_CHAT = [{ createdAt: 'asc' as const }, { id: 'asc' as const }]

/** Cuantos mensajes trae cada poll. */
export const CHAT_PAGE_SIZE = 100

/**
 * Cada cuanto pregunta el cliente si hay algo nuevo.
 *
 * Tres segundos. Es el trade-off explicito de no tener WebSockets: el plan
 * promedio se avisa a si mismo con los ultimos mensajes del mapa, y con menos
 * de 3 segundos un mensaje ajeno tarda en verse y la gente lo manda dos veces.
 * Con mas de 5, dos personas escribiendo se pisan el turno. El costo son
 * requests de un endpoint que devuelve una lista vacia.
 *
 * El costo real esta en el navegador: cada poll mantiene la conexion abierta.
 * Por eso la pagina pausa el poll cuando la pestana deja de estar visible
 * (`document.hidden`), en vez de seguir preguntando por un chat que nadie mira.
 */
export const CHAT_POLL_MS = 3000

/**
 * Cuanto puede mide un mensaje.
 *
 * Vive aca y no en `lib/validation.ts` aunque sea el schema el que lo aplica,
 * porque el cliente tambien lo necesita (contador y bloqueo del envio) y este
 * modulo no importa zod. Ver el comentario del `messageSchema`.
 */
export const MESSAGE_BODY_MAX = 1000

/**
 * Quien tiene el chat: `ACCEPTED`, `ATTENDED` y `NO_SHOW`.
 *
 * **El chat NO se cierra por status del plan.** `ATTENDED` y `NO_SHOW` siguen
 * entrandose a proposito, y la decision es de producto, no mia:
 *
 *   - Un `NO_SHOW` no es el final de la relacion entre esas personas. El
 *     organizador quiere poder preguntarle "¿todo bien? no llegaste" despues, y
 *     quien asiste quiere coordinar otro encuentro con el mismo grupo. Cerrar el
 *     canal en el `ATTENDED` corta justo la continuidad que el producto busca,
 *     que es conectar contextos y no solo eventos puntuales.
 *   - Cerrar obliga a decidir tres cosas que este slice no pidio: que pasa con
 *     los mensajes ya escritos, si se puede leer sin escribir, y que ve el
 *     usuario al intentar escribir en un chat "cerrado". Construir eso ahora es
 *     construir de mas.
 *
 * Lo que si queda 403: `REQUESTED` (todavia no entro), `DECLINED` y `CANCELLED`.
 * Los tres son "no sos parte del plan", que es la unica linea que el gate
 * necesita y que la FK sola NO garantiza (§8.1 de `docs/modelo-datos.md`).
 *
 * **Revisarlo cuando** exista `ModerationReport` real, porque un chat que nunca
 * se cierra es superficie sin limite para reportar, o cuando el volumen de
 * chats abiertos simultaneos se vuelva un problema de producto (por ejemplo,
 * que haga falta archivar).
 *
 * Vive aca y no en el route ni en el `.tsx` porque es la **misma** regla en los
 * dos: el `div` decide que se ve y el API decide que se puede. Con la constante
 * escrita dos veces, un cambio de estado se olvida de uno de los dos y aparece
 * la combinacion que no tiene que existir: ver el chat y que el POST de 403.
 */
export const CHAT_ABIERTOS_A: readonly ParticipationStatus[] = [
  'ACCEPTED',
  'ATTENDED',
  'NO_SHOW',
]

/** El gate, como funcion: se usa en el render del detalle y en el endpoint. */
export function puedeUsarChat(status: ParticipationStatus | null | undefined): boolean {
  return status != null && CHAT_ABIERTOS_A.includes(status)
}

/**
 * Agrega mensajes nuevos al final, sin repetir.
 *
 * Vive aca y no en el Client Component porque es la regla que sostiene toda la
 * pantalla, y una regla que solo existe adentro de un `.tsx` no se puede
 * testear sin DOM. Hay dos caminos por los que un mensaje llega dos veces:
 *
 *   1. Mandaste uno y el proximo poll lo vuelve a traer, porque el cursor todavia
 *      esta antes de el. Es normal y se descarta por id.
 *   2. Dos polls overlapped leen el mismo rango. Tambien se descarta por id.
 *
 * El `id` es el que hace el trabajo, y no "el ultimo mensaje": dos mensajes
 * pueden compartir `createdAt`, asi que comparar por fecha dejaria pasar al
 * duplicado. Ademas `agregarMensajes` es puro y devuelve el MISMO arreglo
 * cuando no hay nada nuevo, para que React no re-renderice por un poll vacio.
 */
export function agregarMensajes(previos: Mensaje[], nuevos: Mensaje[]): Mensaje[] {
  if (nuevos.length === 0) return previos
  const vistos = new Set(previos.map((m) => m.id))
  const unicos = nuevos.filter((m) => !vistos.has(m.id))
  return unicos.length === 0 ? previos : [...previos, ...unicos]
}

/**
 * El cursor siguiente: el del servidor si vino, el de antes si no.
 *
 * `ChatPoll.nextCursor` es `null` cuando la pagina vino vacia, porque no hay un
 * ultimo mensaje del que sacarlo. Si el cliente aceptara ese `null`, el proximo
 * poll partiria desde el principio y reenviaria el chat entero para que la
 * pantalla lo deduplique: todas las request de más y un pico de CPU en cada
 * vuelta. Peor todavia si el que lo escribio es el que deduplica mal, la
 * conversacion se duplica y no se explica.
 *
 * Por eso el `null` del servidor NUNCA reemplaza un cursor que ya tenemos: solo
 * se usa cuando no habia ninguno.
 *
 * La cadena vacia se trata igual que `null` a proposito, aunque el endpoint
 * hoy no puede devolverla: `encodeCursor` de una fila real nunca da vacio. Es
 * que un `after=` vacio en la URL lo interpreta el handler como "sin cursor" y
 * devuelve el chat entero, o sea que la unica forma de que este cliente llegue
 * a esa situacion es que alguien se pase un valor raro. Con `??` a secas eso
 * pasaria y el fallo seria invisible.
 */
export function avanzarCursor(actual: string | null, siguiente: string | null): string | null {
  return siguiente ? siguiente : actual
}

/**
 * `encodeCursor` y `decodeCursor` son de SOLO SERVIDOR.
 *
 * Usan `Buffer`, que el navegador no tiene: Next no lo mete en el bundle, asi
 * que llamarlas desde un Client Component revienta con `Buffer is not defined`
 * en el navegador, no en el build. El cliente no las necesita nunca, porque el
 * cursor es opaco justamente para eso: lo recibe del servidor y lo reusa tal
 * cual. Si alguna vez hay que armarlo del lado del cliente, el cambio es
 * `btoa`/`atob` mas la conversion de base64url, no un import.
 */
