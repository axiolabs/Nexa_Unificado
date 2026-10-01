/**
 * Donde queda la persona despues de iniciar sesion.
 *
 * Puro y en `lib/`, igual que `personality-reminder.ts`, por la misma razon: esto
 * se decide sin DOM y se testea. Si viviera en el componente, la unica forma de
 * comprobarlo seria levantar la pagina entera.
 *
 * Usa el MISMO dato que el recordatorio pasivo de `/explore`
 * (`GET /api/personality` -> `hayResultado`), y no una consulta nueva. Dos
 * consultas para el mismo booleano significa que pueden discrepar, y cuando
 * discrepan el mapa dice una cosa y la redireccion lleva a otra.
 *
 * Lo que NO usa es `tocaRecordar()`. Returns `true` tambien cuando hay resultado
 * de una version vieja, porque para un recordatorio eso es correcto: hay una v2
 * y conviene avisar. Para una redireccion seria la respuesta equivocada: alguien
 * que hizo el test hace seis meses y entra al mapa todos los dias de golpe
 * aterriza en `/personalidad` sin contexto, una vez por publicacion de version.
 * Aca la pregunta es "ya lo hizo o no", y eso es `hayResultado` y nada mas.
 */

import type { TestStatus } from './personality-reminder'

/** A donde va la persona segun si ya hizo el test o no. */
export type DestinoPostLogin = '/personalidad' | '/explore'

/**
 * El destino.
 *
 * `null` (no hay sesion, o el endpoint fallo) NO significa "mandalo al mapa":
 * significa "no opines". El mapa es el default de todos modos, asi que en el
 * peor caso se cae al mismo lado, pero dejar el `null` explícito permite que el
 * llamador distinga "no se" de "si, mandalo a /personalidad" y no escriba una
 * regla de tres ramas donde dos son iguales.
 *
 * Sin test activo el destino es el mapa, por la misma razon que apaga el
 * recordatorio: no hay nada que ofrecer, e insistir en hacer un test que no
 * existe es peor que no insistir. Mandar a `/personalidad` ahi abre una pantalla
 * que va a mostrar que no hay test, y parece un error.
 */
export function destinoPostLogin(test: TestStatus | null): DestinoPostLogin | null {
  if (!test) return null
  if (!test.hayTest) return '/explore'
  return test.hayResultado ? '/explore' : '/personalidad'
}
