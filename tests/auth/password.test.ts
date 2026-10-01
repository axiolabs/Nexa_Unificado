import { describe, expect, it } from 'vitest'
import argon2 from 'argon2'
import { getDummyHash, hashPassword, verifyPassword } from '../../lib/auth/password'

/**
 * El bug que estos tests existen para que no vuelva.
 *
 * La primera version de la mitigacion de timing comparaba contra un hash
 * argon2 escrito a mano en el codigo. Estaba malformado, argon2 lanzaba en
 * ~0.3 ms, y el `catch { return false }` de verifyPassword se tragaba el
 * excepcion. El flujo se leia correcto y la mitigacion no mitigaba nada:
 * login con email inexistente tardaba 10 ms contra 95 ms de uno real.
 *
 * Estos asserts son deterministas y NO dependen de medir tiempos. Si alguien
 * vuelve a hardcodear un hash, `getDummyHash` deja de ser valido y estos
 * tests se rompen al instante.
 */

/**
 * Parsea los parametros de un hash argon2 sin asumir el orden en que argon2
 * los emite (`m=...,p=...,t=...`, no `m=...,t=...,p=...`).
 *
 * Un regex con el orden fijo habria fallado por una cuestion de formato y
 * enviado a buscar un bug que no existe.
 */
function argonParams(hash: string) {
  const m = /\$argon2id\$v=19\$m=(\d+),p=(\d+),t=(\d+)\$/.exec(hash)
  if (!m) throw new Error(`no parece un hash argon2id con parametros: ${hash.slice(0, 40)}`)
  return { memoryCost: +m[1], parallelism: +m[2], timeCost: +m[3] }
}

describe('hashPassword', () => {
  it('produce un hash argon2id con los parametros fijados', async () => {
    const hash = await hashPassword('correcto-caballo-grapa-42')
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=\d+,p=\d+,t=\d+\$/)
    expect(argonParams(hash)).toEqual({ memoryCost: 65536, parallelism: 4, timeCost: 3 })
  })

  it('nunca guarda la contrasena en claro', async () => {
    const hash = await hashPassword('correcto-caballo-grapa-42')
    expect(hash).not.toContain('correcto-caballo-grapa-42')
  })

  it('dos llamadas con la misma contrasena dan hashes distintos (salt aleatorio)', async () => {
    const a = await hashPassword('misma-contrasena-123')
    const b = await hashPassword('misma-contrasena-123')
    expect(a).not.toBe(b)
    expect(await verifyPassword(a, 'misma-contrasena-123')).toBe(true)
    expect(await verifyPassword(b, 'misma-contrasena-123')).toBe(true)
  })
})

describe('verifyPassword', () => {
  it('acepta la contrasena correcta y rechaza la incorrecta', async () => {
    const hash = await hashPassword('correcto-caballo-grapa-42')
    expect(await verifyPassword(hash, 'correcto-caballo-grapa-42')).toBe(true)
    expect(await verifyPassword(hash, 'equivocada-12345')).toBe(false)
  })

  it('distingue mayusculas de minusculas', async () => {
    // Truncar o lowercasear la contrasena seria una perdida silenciosa de
    // entropia. Este test falla si alguien "normaliza" la entrada.
    const hash = await hashPassword('SeCtA-De-Verificacion')
    expect(await verifyPassword(hash, 'SeCtA-De-Verificacion')).toBe(true)
    expect(await verifyPassword(hash, 'secta-de-verificacion')).toBe(false)
  })

  it('no trunca inputs largos como hace bcrypt', async () => {
    // bcrypt ignora todo pasado el byte 72, asi que estas dos contrasenas
    // darian el mismo hash. argon2 no.
    const base = 'a'.repeat(80)
    const hash = await hashPassword(base + '-UNO')
    expect(await verifyPassword(hash, base + '-UNO')).toBe(true)
    expect(await verifyPassword(hash, base + '-DOS')).toBe(false)
  })

  it('devuelve false, no lanza, ante un hash malformado', async () => {
    expect(await verifyPassword('no-es-un-hash', 'lo-que-sea')).toBe(false)
    expect(await verifyPassword('', 'lo-que-sea')).toBe(false)
    expect(await verifyPassword('$argon2id$v=19$m=65536,t=3,p=4$malformado', 'x')).toBe(false)
  })
})

describe('getDummyHash', () => {
  it('devuelve un hash REAL, no un string cualquiera', async () => {
    // Esta es la asercion que habria atrapado el bug original. Un hash
    // hardcodeado malformado rompe aca de forma determinista.
    const dummy = await getDummyHash()
    expect(dummy).toMatch(/^\$argon2id\$v=19\$m=\d+,p=\d+,t=\d+\$/)
    expect(dummy.split('$')).toHaveLength(6)
    // Mismos parametros que los de un login real: si divergieran, el tiempo
    // de respuesta dejaria de ser comparable.
    expect(argonParams(dummy)).toEqual({ memoryCost: 65536, parallelism: 4, timeCost: 3 })
  })

  it('argon2 lo puede parsear (el bug era justamente que no)', async () => {
    const dummy = await getDummyHash()
    // verify no debe LANZAR. Con el hash malformado, argon2 tiraba
    // "pchstr must contain a $ as first char".
    await expect(argon2.verify(dummy, 'cualquier-cosa')).resolves.toBe(false)
  })

  it('memoiza: dos llamadas devuelven el mismo string', async () => {
    const a = await getDummyHash()
    const b = await getDummyHash()
    expect(a).toBe(b)
  })

  it('es una cadena distinta de cualquier hash de usuario', async () => {
    const dummy = await getDummyHash()
    const real = await hashPassword('correcto-caballo-grapa-42')
    expect(dummy).not.toBe(real)
  })
})
