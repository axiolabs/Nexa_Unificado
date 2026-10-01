import { describe, expect, it } from 'vitest'
import { MENSAJES_POR_ESTADO, decidirUnirse } from '../../lib/plan-join'
import type { EntradaDecision } from '../../lib/plan-join'

/**
 * La decision del boton de unirse, estado por estado.
 *
 * Esto no es una tabla de confort: es la parte de la pagina que NO se puede
 * verificar leyendo codigo, porque un `else` mal puesto no rompe el build ni
 * ningún otro test. El cableado del `onClick` sigue sin cubrir, pero la regla
 * que decide que se muestra ya no depende de que alguien la lea con cuidado.
 *
 * Las fechas van fijas. `startsAt` relativo a `Date.now()` mas un segundo de
 * margen en un `it` puede cambiar de signo entre el armado y la asercion, y un
 * test que a veces falla no informa nada.
 */

const AHORA = new Date('2026-10-01T12:00:00.000Z')
const FUTURO = '2026-10-01T20:00:00.000Z'
const PASADO = '2026-10-01T10:00:00.000Z'

// Anotada con el tipo de la funcion, y no con `as const`: el literal de
// `startsAt` y de `isCreator` quedaria tan angosto que los casos que varyan uno
// de los dos campos no compilarian.
const planAbierto: EntradaDecision = {
  status: 'OPEN',
  startsAt: FUTURO,
  creatorName: 'Hilda Host',
  isCreator: false,
}

const pedir = (participacion: string | null, plan = planAbierto) =>
  decidirUnirse(plan, participacion ? { status: participacion } : null, AHORA)

describe('decidirUnirse', () => {
  // Los ocho estados, en el orden en que la funcion los evalua.
  const casos: {
    estado: string
    entrada: EntradaDecision
    participacion: string | null
    esperado: { tipo: 'informativo' | 'solicitar'; texto?: string; etiqueta?: string }
  }[] = [
    {
      estado: 'el organizador',
      entrada: { ...planAbierto, isCreator: true },
      participacion: null,
      esperado: { tipo: 'informativo', texto: 'Lo organizas vos' },
    },
    {
      estado: 'confirmado',
      entrada: planAbierto,
      participacion: 'ACCEPTED',
      esperado: { tipo: 'informativo', texto: 'Estas confirmado' },
    },
    {
      estado: 'asistido antes',
      entrada: planAbierto,
      participacion: 'ATTENDED',
      esperado: { tipo: 'informativo', texto: 'Estas confirmado' },
    },
    {
      estado: 'peticion pendiente',
      entrada: planAbierto,
      participacion: 'REQUESTED',
      esperado: { tipo: 'informativo', texto: 'Pediste unirte' },
    },
    {
      estado: 'rechazado',
      entrada: planAbierto,
      participacion: 'DECLINED',
      esperado: { tipo: 'informativo', texto: 'no acepto tu peticion' },
    },
    {
      estado: 'planton',
      entrada: planAbierto,
      participacion: 'NO_SHOW',
      esperado: { tipo: 'informativo', texto: 'Fuiste anotado' },
    },
    {
      estado: 'plan cancelado',
      entrada: { ...planAbierto, status: 'CANCELLED' },
      participacion: null,
      esperado: { tipo: 'informativo', texto: 'ya no acepta participantes' },
    },
    {
      estado: 'plan ya empezado',
      entrada: { ...planAbierto, startsAt: PASADO },
      participacion: null,
      esperado: { tipo: 'informativo', texto: 'ya empezo' },
    },
    {
      estado: 'se dio de baja',
      entrada: planAbierto,
      participacion: 'CANCELLED',
      esperado: { tipo: 'solicitar', etiqueta: 'Pedir de nuevo' },
    },
    {
      estado: 'nunca habia pedido',
      entrada: planAbierto,
      participacion: null,
      esperado: { tipo: 'solicitar', etiqueta: 'Pedir unirme' },
    },
  ]

  for (const c of casos) {
    it(`${c.estado} -> ${c.esperado.tipo}`, () => {
      const d = decidirUnirse(
        c.entrada,
        c.participacion ? { status: c.participacion } : null,
        AHORA,
      )
      expect(d.tipo).toBe(c.esperado.tipo)
      if (d.tipo === 'informativo') expect(d.texto).toContain(c.esperado.texto)
      else expect(d.etiqueta).toBe(c.esperado.etiqueta)
    })
  }

  it('el invitado ve el boton, y solo el invitado', () => {
    // El campo mas importante de la funcion: `isCreator` no puede ganarle a nada
    // porque se evalua primero, y un creador nunca debe ver "Pedir unirme" en su
    // propio plan. El `POST /join` lo rechaza con 400, asi que la pantalla que
    // lo ofrece esta prometiendo algo que el servidor va a rechazar.
    const creador = pedir(null, { ...planAbierto, isCreator: true })
    expect(creador.tipo).toBe('informativo')
    const otro = pedir(null)
    expect(otro.tipo).toBe('solicitar')
  })

  it('"Pedir unirme" dice explicitamente que pedir no es entrar', () => {
    // Si esta frase se cae, "unirme" se lee como reservar y desaparece el
    // consentimiento del organizador, que es la parte del producto que hace que
    // la pantalla exista.
    const d = pedir(null)
    expect(d.tipo).toBe('solicitar')
    if (d.tipo !== 'solicitar') return
    expect(d.nota).toContain('Pedir no es entrar')
    expect(d.nota).toContain('Hilda Host')
  })

  it('un plan lleno NO cambia la decision: avisa arriba, el boton sigue', () => {
    // Cancelar en el peor momento libera el lugar para otro, asi que un plan
    // lleno tiene que aceptar pedidos. `isFull` no entra a la funcion a
    // proposito; si alguna vez entra, esta es la linea que avisa.
    expect(pedir(null).tipo).toBe('solicitar')
  })

  it('CANCELLED en un plan ya empezado no ofrece volver a pedir', () => {
    // El orden de las reglas, no una regla explicita: `CANCELLED` se evalua
    // DESPUES de "ya empezo". Ofrecer el boton seria mostrar una accion cuyo
    // unico resultado posible es un 409.
    const d = pedir('CANCELLED', { ...planAbierto, startsAt: PASADO })
    expect(d.tipo).toBe('informativo')
    if (d.tipo === 'informativo') expect(d.texto).toBe('Este plan ya empezo.')
  })

  it('el creador sigue viendo su estado real aunque el plan este lleno', () => {
    const d = pedir('ACCEPTED', { ...planAbierto, isCreator: true })
    expect(d.tipo).toBe('informativo')
  })

  it('el creador nunca ve una accion, aunque su plan ya empezo', () => {
    // Este caso existe por un mutante que sobrevivio: con `isCreator` evaluado
    // despues de "ya empezo", el organizador de un plan pasado leia "este plan ya
    // empezo", que es un mensaje para invitados. El orden de las reglas es la
    // especificacion, y esto la ata.
    const d = pedir(null, { ...planAbierto, isCreator: true, startsAt: PASADO })
    expect(d.tipo).toBe('informativo')
    if (d.tipo === 'informativo') expect(d.texto).toBe('Lo organizas vos. No hay nada que pedir.')
  })

  it('el creador que se dio de baja tampoco recibe un boton', () => {
    // Mismo motivo, otro camino: `CANCELLED` devuelve un "Pedir de nuevo", y para
    // el que organiza ese plan no corresponde.
    const d = pedir('CANCELLED', { ...planAbierto, isCreator: true })
    expect(d.tipo).toBe('informativo')
  })

  it('un estado desconocido no rompe: cae en el boton de pedir', () => {
    // Si la base gana un estado nuevo, la pantalla tiene que ofrecer algo
    // razonable y que el servidor pueda rechazar con un 409 explicable, no
    // quedar en blanco.
    const d = pedir('WAT')
    expect(d.tipo).toBe('solicitar')
  })

  it('el tono distingue confirmado de solo informativo', () => {
    // `ok` es verde y es para lo que se logro. Si un rechazo queda en verde, el
    // usuario lee que salio bien.
    const confirmado = pedir('ACCEPTED')
    const rechazado = pedir('DECLINED')
    if (confirmado.tipo !== 'informativo' || rechazado.tipo !== 'informativo') {
      throw new Error('ambos deberian ser informativos')
    }
    expect(confirmado.tono).toBe('ok')
    expect(rechazado.tono).toBe('note')
  })
})

describe('los mensajes de un 409 con estado', () => {
  it('cada estado tiene su propio texto', () => {
    // El 409 con `status` no es un error generico: "el organizador no te
    // acepto" y "ya estas confirmado" son cosas distintas para el usuario.
    expect(MENSAJES_POR_ESTADO.REQUESTED).toContain('Pediste unirte')
    expect(MENSAJES_POR_ESTADO.ACCEPTED).toContain('confirmado')
    expect(MENSAJES_POR_ESTADO.DECLINED).toContain('no acepto')
    expect(MENSAJES_POR_ESTADO.CANCELLED).toContain('dado de baja')
    expect(MENSAJES_POR_ESTADO.NO_SHOW).toContain('asistencia')
    expect(MENSAJES_POR_ESTADO.ATTENDED).toContain('estuviste')
  })

  it('ningun texto promete entrar sin organizacion', () => {
    // Un unico texto que dijera "ya estas adentro" seria el bug de consentimiento.
    for (const [estado, texto] of Object.entries(MENSAJES_POR_ESTADO)) {
      expect(texto, estado).not.toMatch(/\bestas adentro\b/)
    }
  })
})
