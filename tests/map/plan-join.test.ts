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

  it('pedir y estar esperando no se anuncian como un logro', () => {
    // El estado PERSISTENTE (volves manana y lo seguis viendo) y el mensaje
    // que aparece al pedir (transitorio) cuentan lo mismo. Si uno queda en
    // `ok` y el otro no, el mismo hecho se ve de dos colores distintos.
    const esperando = pedir('REQUESTED')
    if (esperando.tipo !== 'informativo') throw new Error('deberia ser informativo')
    expect(esperando.tono, 'esperando').toBe('neutro')
    expect(esperando.tono, 'esperando').not.toBe('ok')
    expect(MENSAJES_POR_ESTADO.REQUESTED.tono).toBe(esperando.tono)
  })
})

describe('los mensajes de un 409 con estado', () => {
  it('cada estado tiene su propio texto', () => {
    // El 409 con `status` no es un error generico: "el organizador no te
    // acepto" y "ya estas confirmado" son cosas distintas para el usuario.
    expect(MENSAJES_POR_ESTADO.REQUESTED.texto).toContain('Pediste unirte')
    expect(MENSAJES_POR_ESTADO.ACCEPTED.texto).toContain('confirmado')
    expect(MENSAJES_POR_ESTADO.DECLINED.texto).toContain('no acepto')
    expect(MENSAJES_POR_ESTADO.CANCELLED.texto).toContain('dado de baja')
    expect(MENSAJES_POR_ESTADO.NO_SHOW.texto).toContain('asistencia')
    expect(MENSAJES_POR_ESTADO.ATTENDED.texto).toContain('estuviste')
  })

  it('el texto de pedir no promete un aviso que no existe', () => {
    // Hoy no hay notificaciones push: el usuario se entera volviendo a entrar.
    // Prometerle "te avisamos" y despues no avisarle genera MAS ansiedad que
    // el silencio, porque encima lo deja creyendo que perdio algo.
    expect(MENSAJES_POR_ESTADO.REQUESTED.texto).not.toMatch(/te avis|avisaremos|te vamos a avisar|te notific|te llega/i)
  })

  it('el texto de pedir no pone el reloj como protagonista', () => {
    // "Tiene hasta 24 horas" al principio invita a hacer cuentas y a esperar
    // ansioso. Lo que el usuario controla -poder volver cuando quiera- va
    // primero, y el plazo queda como dato secundario.
    const texto = MENSAJES_POR_ESTADO.REQUESTED.texto
    expect(texto.startsWith('Pediste unirte.')).toBe(true)
    expect(texto).toMatch(/24 horas/)
    expect(texto.indexOf('Podes volver')).toBeLessThan(texto.indexOf('24 horas'))
  })

  it('ningun texto promete entrar sin organizacion', () => {
    // Un unico texto que dijera "ya estas adentro" seria el bug de consentimiento.
    for (const [estado, { texto }] of Object.entries(MENSAJES_POR_ESTADO)) {
      expect(texto, estado).not.toMatch(/\bestas adentro\b/)
    }
  })

  it('esperar y ser rechazado no se pintan como error', () => {
    // La audiencia tiene ansiedad social y el rechazo es privado por diseno.
    // Si un REQUESTED o un DECLINED vuelven en el rojo de un fallo de red, la
    // interfaz le grita al usuario que rompio algo cuando no rompio nada.
    for (const estado of ['REQUESTED', 'DECLINED', 'CANCELLED', 'ATTENDED', 'NO_SHOW'] as const) {
      expect(MENSAJES_POR_ESTADO[estado].tono, estado).toBe('neutro')
    }
  })

  it('esperar tampoco se pinta como un exito', () => {
    // Verde dice "ya estas adentro". Pedir es una espera, no una confirmacion:
    // el mismo bug de consentimiento que el texto, resuelto en el color.
    expect(MENSAJES_POR_ESTADO.REQUESTED.tono).not.toBe('ok')
  })

  it('solo lo que si es un logro queda en ok', () => {
    expect(MENSAJES_POR_ESTADO.ACCEPTED.tono).toBe('ok')
  })

  it('ningun estado se muestra con el tono de error', () => {
    // `error` queda para lo que no se pudo hacer (conexion, 500, 403). Ningun
    // estado de participacion es eso: son todos hechos, no fallas.
    for (const [estado, { tono }] of Object.entries(MENSAJES_POR_ESTADO)) {
      expect(tono, estado).not.toBe('error')
    }
  })
})
