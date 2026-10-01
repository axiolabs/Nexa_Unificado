/**
 * Conversion de fechas del formulario de creacion de plan.
 *
 * Vive en un modulo aparte, sin React, por la razon que ya cobro caro en este
 * proyecto: la conversion de `<input type="datetime-local">` es donde nacen los
 * bugs de zona horaria, y una funcion dentro de un componente de 400 lineas no
 * se puede testear sin montar la pantalla entera.
 *
 * La regla que aplica este modulo es la MISMA que ya usa el listado del
 * explorador (`formatWhen` en `app/explore/explore-client.tsx`): **el instante
 * es absoluto, y la pantalla lo muestra en la zona del que mira**. No se fija
 * `America/Argentina/Buenos_Aires` en ningun lado, y esa decision tiene un
 * motivo concreto.
 *
 * `<input type="datetime-local">` entrega una hora de pared SIN zona:
 * `"2026-10-08T20:00"`. JavaScript la interpreta como hora local del navegador.
 * De ahi hay que decidir que se guarda:
 *
 *   - El host en Buenos Aires elige 20:00 y lo ve a las 20:00.
 *   - `toApiDate` lo pasa a ISO con offset (`toISOString`), que ya no tiene
 *     ambiguedad: 20:00 ART es 23:00Z.
 *   - La API lo pasa por `z.coerce.date()` y Prisma lo escribe en la columna
 *     `timestamp without time zone`.
 *   - El listado lo vuelve a mostrar con `toLocaleString`, que lo reconstituye
 *     como 20:00 para un espectador en la misma zona.
 *
 * Fijar la zona de la app en el formulario daria horas distintas a las que da el
 * listado para el MISMO plan, y ademas rompe la hidratacion de React en
 * cualquier superficie renderizada en el server: el HTML llega con una hora y
 * el navegador calcula otra. Un componente cliente no tiene ese problema, asi que
 * el camino que funciona es no fijar la zona.
 *
 * La consecuencia, asumida y no resuelta aca: un plan de Buenos Aires visto
 * desde Madrid se muestra a la hora de Madrid, no a la de Buenos Aires. Es lo
 * que ya hace el explorador. Arreglarlo de verdad es mostrar la zona del LUGAR
 * junto a la hora, y esa es una decision de producto, no una funcion.
 */

/**
 * Formato exacto que espera `datetime-local`, para comparar contra el valor que
 * el browser produce. No se usa para construir strings: para eso esta
 * `toLocalInputValue`, que es determinista.
 */
const LOCAL_INPUT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/

/**
 * `<input type="datetime-local">` -> string ISO para la API.
 *
 * Devuelve `null` en vez de un string invalido cuando el valor no es una fecha
 * real, para que el formulario distinga "el usuario no escribio nada" de "el
 * usuario escribio algo imposible": son dos mensajes distintos, y el segundo no
 * se puede mandar al servidor para que lo diga.
 */
export function toApiDate(localValue: string): string | null {
  const trimmed = localValue.trim()
  if (!trimmed) return null

  // Sin este chequeo, `new Date('basura')` devuelve un Date INVALIDO y
  // `.toISOString()` sobre un Date invalido lanza un RangeError que tumba el
  // render del componente entero en vez de marcar un campo. El input tiene
  // `type=datetime-local`, que ya filtra, pero la validacion del navegador es
  // una ayuda visual: el valor llega igual desde un autocompletado o un test.
  const d = new Date(trimmed)
  if (Number.isNaN(d.getTime())) return null

  return d.toISOString()
}

/**
 * Muestra un instante del plan con la convencion del listado del explorador:
 * `es-AR`, sin fijar zona, para que use la del runtime.
 *
 * `hourCycle: 'h23'` esta a proposito y no es decorativo. Sin el, `es-AR` con
 * ICU rinde DOCE horas: un plan de las 20:00 se muestra como `08:00 p. m.`, que
 * es exactamente el dato que un horario no puede permitirse. Y no alcanza con
 * `hour12: false`, que en varias combinaciones de locale e ICU rinde `24:00` a
 * la medianoche en vez de `00:00`. `h23` es la unica forma explicita de pedir
 * 00-23 sin depender de cual de los dos fallback aplica.
 */
export function formatPlanMoment(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'Fecha invalida'
  return d.toLocaleString('es-AR', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
}

/**
 * Redondea "ahora" hacia arriba al proximo cuarto de hora, para el `min` de los
 * inputs de fecha.
 *
 * Sin esto el `min` queda en el segundo actual y el navegador marca error en
 * cualquier hora que el usuario escriba, porque el instante ya paso entre que
 * se renderizo y que escribio. Con el redondeo el limite es un punto que se
 * puede leer ("no antes de las 19:15").
 *
 * Se redondea HACIA ARRIBA y no al mas cercano: `19:07` con redondeo al mas
 * cercano da `19:00`, que ya paso, y el `min` invalida el propio valor que el
 * modulo acaba de calcular.
 */
export function nextQuarterHour(now = new Date()): string {
  const d = new Date(now)
  d.setSeconds(0, 0)
  const rest = d.getMinutes() % 15
  if (rest !== 0) d.setMinutes(d.getMinutes() + (15 - rest))
  return toLocalInputValue(d)
}

/**
 * `Date` -> el formato exacto que espera `datetime-local`, que NO es ISO.
 *
 * `toISOString` devuelve UTC con una `Z` y `datetime-local` no la acepta: el
 * control queda vacio y el usuario no ve por que. Ademas hay que copiar la hora
 * local y no la de UTC, o el input muestra una hora desplazada.
 *
 * Se arma a mano con `padStart` en vez de con `toLocaleString`: el formato de
 * `toLocaleString` depende del locale y de que datos de ICU traiga el runtime, y
 * no vale depender de eso para generar el valor de un control. Argentina no
 * tiene horario de verano, asi que `setMinutes` aca nunca cae en un hueco ni en
 * una hora repetida; el modulo no tendria que reescribirse si el pais cambiara
 * esa regla, y por eso el redondeo se hace en la zona local y no en UTC.
 */
export function toLocalInputValue(d: Date): string {
  const y = d.getFullYear()
  const mo = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const h = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${y}-${mo}-${day}T${h}:${mi}`
}

/**
 * Dice si un valor tiene la forma que `datetime-local` acepta, para no confiar
 * en que el tipo del input ya lo valido.
 */
export function isLocalInputValue(v: string): boolean {
  return LOCAL_INPUT_RE.test(v.trim())
}
