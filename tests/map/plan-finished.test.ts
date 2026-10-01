import { describe, expect, it } from 'vitest'
import { planCerrable, planTermino, porQueNoSeCierra } from '../../lib/plan-finished'

/**
 * "¿El plan ya termino?" es la regla que abre las dos cosas nuevas — marcar
 * asistencia y calificar — asi que se prueba sola, sin base de datos, porque un
 * error aca se ve de las dos formas mas caras: la ventana abre antes de tiempo
 * (el organizador califica un plan que no ocurrio) o nunca abre (el feature
 * queda muerto y no hay error que lo delate).
 *
 * Todos los casos usan `ahora` explicito. Probar el borde con el reloj real
 * seria una carrera: el test pasaria hoy y fallaria en el minuto en que la hora
 * de fin pasara.
 */

const HORA = (iso: string) => new Date(iso)
const AHORA = HORA('2026-10-01T12:00:00.000Z')

describe('planTermino', () => {
  it('con hora de fin, termina cuando la hora de fin ya paso', () => {
    const plan = { startsAt: HORA('2026-10-01T10:00:00.000Z'), endsAt: HORA('2026-10-01T11:00:00.000Z') }
    expect(planTermino(plan, AHORA)).toBe(true)
  })

  it('con hora de fin, NO termina un minuto antes', () => {
    const plan = { startsAt: HORA('2026-10-01T10:00:00.000Z'), endsAt: HORA('2026-10-01T12:01:00.000Z') }
    expect(planTermino(plan, AHORA)).toBe(false)
  })

  it('el borde es inclusivo: en el milisegundo exacto de la hora de fin, termino', () => {
    // `<` en vez de `<=` deja el plan abierto durante el instante exacto en que
    // deberia cerrarse, y como el reloj del servidor tiene milisegundos, ese
    // instante existe de verdad.
    const plan = { startsAt: HORA('2026-10-01T10:00:00.000Z'), endsAt: HORA('2026-10-01T12:00:00.000Z') }
    expect(planTermino(plan, AHORA)).toBe(true)
  })

  it('sin hora de fin, termina cuando el inicio ya paso', () => {
    // `endsAt` es opcional en el schema. Sin el, el unico dato que hay es el
    // inicio, y no se inventa una duracion por defecto: un parametro mas que
    // alguien tiene que mantener sincronizado con lo que el organizador piensa
    // que dura el plan.
    expect(planTermino({ startsAt: HORA('2026-10-01T10:00:00.000Z'), endsAt: null }, AHORA)).toBe(true)
  })

  it('sin hora de fin, un plan que empieza en el futuro NO termina', () => {
    expect(planTermino({ startsAt: HORA('2026-10-01T20:00:00.000Z'), endsAt: null }, AHORA)).toBe(false)
  })

  it('ignora el status: "termino" y "se cancelo" son dos preguntas', () => {
    // Confundirlas hace que un plan cancelado sea calificable. El status se mira
    // en `planCerrable`, no aca.
    expect(planTermino({ startsAt: HORA('2026-10-01T10:00:00.000Z'), endsAt: null }, AHORA)).toBe(true)
  })
})

describe('planCerrable', () => {
  const cerrado = { startsAt: HORA('2026-10-01T10:00:00.000Z'), endsAt: null, status: 'OPEN' }

  it('un plan terminado y abierto se puede cerrar', () => {
    expect(planCerrable(cerrado, AHORA)).toBe(true)
  })

  it('un plan que todavia no termino no se puede cerrar', () => {
    const futuro = { startsAt: HORA('2026-10-02T10:00:00.000Z'), endsAt: null, status: 'OPEN' }
    expect(planCerrable(futuro, AHORA)).toBe(false)
  })

  it('un plan CANCELLED nunca se puede cerrar, aunque la hora haya pasado', () => {
    // El caso que justifica la funcion: cancelado tiene hora de fin vencida
    // como cualquier otro, pero no hubo evento, asi que no hay a quien marcar ni
    // experiencia que calificar.
    const cancelado = { startsAt: HORA('2026-10-01T10:00:00.000Z'), endsAt: null, status: 'CANCELLED' }
    expect(planCerrable(cancelado, AHORA)).toBe(false)
  })

  it('un plan COMPLETED se puede cerrar por hora, sin depender del estado', () => {
    // `COMPLETED` no lo escribe nadie todavia. La regla no puede depender de un
    // estado sin productor, o el feature es inalcanzable.
    const completed = { startsAt: HORA('2026-10-01T10:00:00.000Z'), endsAt: null, status: 'COMPLETED' }
    expect(planCerrable(completed, AHORA)).toBe(true)
  })
})

describe('porQueNoSeCierra', () => {
  const base = { startsAt: HORA('2026-10-01T10:00:00.000Z'), endsAt: null }

  it('devuelve null cuando si se puede, para que el render no muestre un aviso al lado', () => {
    expect(porQueNoSeCierra({ ...base, status: 'OPEN' }, AHORA)).toBeNull()
  })

  it('el cancelado tiene su propio motivo, distinto del "todavia no termino"', () => {
    // Si los dos casos dijeran lo mismo, el mensaje seria mentiroso para uno de
    // los dos: "espera a que termine la hora" de un plan cancelado es una
    // instruccion que no se puede cumplir nunca.
    const cancelado = porQueNoSeCierra({ ...base, status: 'CANCELLED' }, AHORA)
    const futuro = porQueNoSeCierra({ ...base, status: 'OPEN' }, new Date('2026-10-01T09:00:00.000Z'))
    expect(cancelado).not.toBeNull()
    expect(futuro).not.toBeNull()
    expect(cancelado).not.toBe(futuro)
  })

  it('el motivo no dice "cerrado" por un plan CANCELLED: no hay nada que cerrar', () => {
    const motivo = porQueNoSeCierra({ ...base, status: 'CANCELLED' }, AHORA) ?? ''
    expect(motivo).toMatch(/cancelo/i)
    expect(motivo).not.toMatch(/todavia no termino/i)
  })
})

describe('con fechas ISO, que es como llegan del JSON al cliente', () => {
  const HORA = (s: string) => s
  const AHORA = new Date('2026-10-01T12:00:00.000Z')

  it('la misma respuesta que con Date, porque el cliente nunca tiene un Date', () => {
    // El servidor tiene `Date` de Prisma; el cliente tiene el ISO que sale del
    // `JSON`. Si las dos rutas no dieran lo mismo, la seccion apareceria en la
    // API y no en la pantalla, sin error en ninguna parte.
    const conDate = { startsAt: new Date('2026-10-01T10:00:00.000Z'), endsAt: null, status: 'OPEN' }
    const conIso = { startsAt: '2026-10-01T10:00:00.000Z', endsAt: null, status: 'OPEN' }

    expect(planCerrable(conDate, AHORA)).toBe(true)
    expect(planCerrable(conIso, AHORA)).toBe(true)

    const futuro = { startsAt: '2026-10-01T23:00:00.000Z', endsAt: null, status: 'OPEN' }
    expect(planCerrable(futuro, AHORA)).toBe(false)
  })

  it('usa endsAt cuando viene, sea Date o ISO', () => {
    const conDate = { startsAt: '2026-10-01T09:00:00.000Z', endsAt: new Date('2026-10-01T11:00:00.000Z'), status: 'OPEN' }
    const conIso = { startsAt: '2026-10-01T09:00:00.000Z', endsAt: '2026-10-01T11:00:00.000Z', status: 'OPEN' }

    expect(planCerrable(conDate, AHORA)).toBe(true)
    expect(planCerrable(conIso, AHORA)).toBe(true)
  })

  it('una fecha rota no termina el plan, y no tira', () => {
    // `NaN <= ahora` es `false`, asi que un ISO roto no abre la ventana. Es el
    // default conservador: antes era "no se puede cerrar", ahora es "no se
    // puede cerrar". Lo contrario seria abrir la calificacion de un plan cuya
    // hora de fin no se puede leer.
    const roto = { startsAt: 'no es una fecha', endsAt: null, status: 'OPEN' }
    expect(() => planCerrable(roto, AHORA)).not.toThrow()
    expect(planCerrable(roto, AHORA)).toBe(false)
    expect(porQueNoSeCierra(roto, AHORA)).not.toBeNull()
  })

  it('el CANCELLED manda sobre una fecha rota tambien', () => {
    const roto = { startsAt: 'no es una fecha', endsAt: null, status: 'CANCELLED' }
    expect(porQueNoSeCierra(roto, AHORA)).toMatch(/cancelo/i)
  })
})
