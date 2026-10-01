import { randomBytes } from 'node:crypto'
import argon2 from 'argon2'

/**
 * argon2id con parametros fijados explicitamente.
 *
 * Por que argon2id y no bcrypt:
 *  - bcrypt trunca silenciosamente todo input de mas de 72 bytes. No da error,
 *    simplemente ignora el resto, asi que "ContrasenaMuyLarga..." y su version
 *    recortada dan el mismo hash. argon2 no tiene ese limite.
 *  - argon2id es memory-hard: caterpillar resistance. bcrypt es CPU-only.
 *
 * Por que se fijan los parametros en vez de usar los defaults de la libreria:
 * para que subirlos mas adelante sea un cambio de codigo explicito y
 * reviewable, no una actualizacion silenciosa de la dependencia.
 *
 * memoryCost=65536 son 64 MiB de RAM por hash. Es deliberado ( OWASP pide
 * >= 19 MiB) pero si el contenedor se queda sin memoria bajo carga, bajalo
 * a 19456 -- no lo pongas por debajo de eso.
 */
const PARAMS = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 4,
} as const

export function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, PARAMS)
}

/**
 * Verifica contra los parametros embebidos en el hash, no contra PARAMS.
 *
 * Es deliberado: argon2 guarda memoryCost/timeCost/parallelism dentro del
 * string del hash ($argon2id$v=19$m=...,t=...,p=...). Leyendolos de ahi, los
 * hashes viejos siguen verificando despues de que subas los parametros, asi
 * que endurecer el costo no invalida las contrasenas existentes. Solo hay que
 * re-hashear en el login siguiente de cada usuario.
 */
export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain)
  } catch {
    // Un hash corrupto o de otro algoritmo no es un error de servidor:
    // es una credencial que no valida.
    return false
  }
}

/**
 * Formato de referencia temporal, para tests y para el doc. NO usar en
 * produccion: sin hash real, un login seria trivial de evadir.
 */
export const HASH_PREFIX = '$argon2id$'

/**
 * Hash ficticio pero REAL, para que un login con email inexistente cueste lo
 * mismo que uno con password incorrecta. Si no, el tiempo de respuesta revela
 * que emails estan registrados: uno inexistente responde en microsegundos y
 * uno existente en ~90 ms.
 *
 * Se GENERA con `hashPassword` en vez de hardcodearse. Un hash escrito a mano
 * en el codigo es facil que quede mal formado, y argon2 ante un hash invalido
 * lanza de inmediato sin hashear nada: el costo cae a ~0 ms y la mitigacion se
 * convierte en decoracion. Se genero esa version primero y la medicion la
 * delato (10 ms vs 95 ms). Ver docs/decisiones-auth.md.
 *
 * La promesa se memoiza porque argon2 es caro por definicion: generar uno por
 * request seria multiplicar el costo por dos.
 */
let dummyHashPromise: Promise<string> | null = null

export function getDummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword(randomBytes(32).toString('base64url'))
  return dummyHashPromise
}
