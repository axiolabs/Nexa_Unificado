import { describe, expect, it } from 'vitest'
import { herramientasSesion, enlacesSesion } from '../../lib/home-nav'
import { ROUTE_ROLES } from '../../lib/authz'

/**
 * Los botones de la pantalla de sesion.
 *
 * Lo que importa aca no es que haya cuatro botones, es que NINGUNO lleve a una
 * pantalla que el middleware vaya a rebotar. Un boton que expulsa es peor que un
 * boton que no esta: el problema se reporta como "no me deja entrar a /host" y
 * nadie va a mirar la pagina de inicio.
 */

describe('enlacesSesion', () => {
  it('un USER comun ve los cuatro destinos de siempre', () => {
    const hrefs = enlacesSesion(['USER']).map((e) => e.href)
    expect(hrefs).toEqual(['/explore', '/personalidad', '/perfil', '/planes'])
  })

  it('sin roles no rompe: devuelve la lista sin herramientas', () => {
    // `roles` es opcional en el tipo de la respuesta de `/api/auth/me`. Si
    // faltara, `enlacesSesion(undefined)` tiene que devolver lo mismo que
    // `USER`, no reventar con "cannot read property of undefined".
    expect(enlacesSesion(undefined).map((e) => e.href)).toEqual(enlacesSesion(['USER']).map((e) => e.href))
    expect(enlacesSesion([]).length).toBeGreaterThan(0)
  })

  it('nunca ofrece un destino que el middleware rechaza', () => {
    // La garantia que importa, y la razon de que los enlaces se deriven de
    // `ROUTE_ROLES` en vez de tener su propia lista. Se prueba con TODOS los
    // roles que existen, para que agregar uno nuevo al enum no pueda colarse un
    // boton sin revisar.
    const todos = ROUTE_ROLES.flatMap((r) => r.roles)
    for (const rol of todos) {
      for (const e of [...enlacesSesion([rol]), ...herramientasSesion([rol])]) {
        const rule = ROUTE_ROLES.find((r) => e.href === r.prefix || e.href.startsWith(r.prefix + '/'))
        if (rule) {
          expect(rule.roles, `${e.href} con rol ${rol}`).toContain(rol)
        }
      }
    }
  })

  it('un USER no ve herramientas de rol', () => {
    expect(herramientasSesion(['USER'])).toEqual([])
  })

  it('un HOST ve organizar un plan y nada mas del equipo', () => {
    const hrefs = herramientasSesion(['HOST']).map((e) => e.href)
    expect(hrefs).toEqual(['/host'])
  })

  it('el curador ve curaduria y no administracion', () => {
    const hrefs = herramientasSesion(['CURATOR']).map((e) => e.href)
    expect(hrefs).toEqual(['/curacion'])
  })

  it('ADMIN ve las tres herramientas', () => {
    // ADMIN es comodin en `ROUTE_ROLES`. Si este test falla, alguien toco la
    // tabla y le quito el superusuario, y ese cambio rompe a mas gente que a
    // esta pantalla.
    const hrefs = herramientasSesion(['ADMIN']).map((e) => e.href)
    expect(hrefs).toContain('/host')
    expect(hrefs).toContain('/curacion')
    expect(hrefs).toContain('/admin')
  })

  it('una persona con dos roles ve las herramientas de los dos', () => {
    const hrefs = herramientasSesion(['USER', 'HOST', 'CURATOR']).map((e) => e.href)
    expect(hrefs).toEqual(['/host', '/curacion'])
  })

  it('todos los destinos tienen etiqueta y pista', () => {
    // Un boton con la pista vacia se ve como un boton, no como una opcion. Y
    // una etiqueta vacia es un boton que no dice nada.
    for (const e of [...enlacesSesion(['ADMIN']), ...herramientasSesion(['ADMIN'])]) {
      expect(e.label.trim(), e.href).not.toBe('')
      expect(e.hint.trim(), e.href).not.toBe('')
    }
  })
})
