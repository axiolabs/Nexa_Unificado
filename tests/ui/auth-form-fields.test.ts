import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'

/**
 * Los `name` de los inputs tienen que ser exactamente las claves que cada
 * handler lee con `f.get(...)`, y las que el schema Zod de la API espera.
 *
 * Antes estos tests pasaban mientras el login desde la UI estaba roto: los
 * inputs se llamaban `loginEmail`/`loginPassword` y el handler pedia
 * `email`/`password`, asi que `FormData` devolvia strings vacios y la API
 * contestaba "Datos invalidos" con los dos campos marcados. Ni los tests ni
 * `scripts/manual-plan-flow.mjs` lo detectaron porque los dos pegan a la API
 * con un JSON armado a mano, nunca a traves del formulario.
 *
 * No se puede verificar contra el HTML servido: la pagina es un client
 * component y con `!checked` el SSR devuelve solo "Cargando...", sin un solo
 * input. Cubrir de verdad el submit exigiria jsdom + Testing Library; esta
 * version al menos cruza las dos mitades del contrato sin sumar dependencias.
 */
const PAGE = new URL('../../app/(user)/page.tsx', import.meta.url)

/** Registro manda name/email/password; login manda email/password. */
const ESPERADOS = ['email', 'name', 'password']

const declarado = (src: string) =>
  new Set([...src.matchAll(/<input[^>]*\bname="([^"]+)"/g)].map((m) => m[1]!))

const leido = (src: string) =>
  new Set([...src.matchAll(/f\.get\('([^']+)'\)/g)].map((m) => m[1]!))

describe('formularios de auth', () => {
  it('los inputs declaran exactamente los campos que ambos handlers leen', async () => {
    const src = await readFile(PAGE, 'utf8')

    expect([...declarado(src)].sort(), 'name declarados en los inputs').toEqual(ESPERADOS)
    expect([...leido(src)].sort(), 'claves que el handler lee').toEqual(ESPERADOS)
  })

  it('ningun handler lee una clave que ningun input declara', async () => {
    const src = await readFile(PAGE, 'utf8')
    const nombres = declarado(src)

    const huerfanos = [...leido(src)].filter((k) => !nombres.has(k))
    expect(huerfanos, 'el handler lee campos que el usuario nunca llena').toEqual([])
  })

  it('ningun input declara un campo que el handler ignora', async () => {
    const src = await readFile(PAGE, 'utf8')
    const leidas = leido(src)

    // Este es el caso del bug: el usuario llenaba el campo, y el valor se
    // perdia en silencio porque el handler buscaba otro nombre.
    const ignorados = [...declarado(src)].filter((k) => !leidas.has(k))
    expect(ignorados, 'inputs que el handler nunca lee').toEqual([])
  })
})