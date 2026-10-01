import { describe, expect, it } from 'vitest'
import {
  ETIQUETAS_EXPERIENCIA,
  ESCALA_RATING,
  RATING_MAX,
  RATING_MIN,
  RATING_TAGS_MAX,
  esEtiquetaValida,
  esRatingValido,
  etiquetaDe,
  puedeCalificar,
  promedioDe,
  tallyDe,
  textoDelPromedio,
} from '../../lib/ratings'

/**
 * Reglas de la calificacion, probadas sin base de datos.
 *
 * La mas importante es la ultima del primer bloque: que la escala sea
 * exactamente 1 a 5. El schema tiene `rating Int`, que acepta `-5` y `9000`, y
 * un promedio de reputacion con un solo voto de 9000 rompe la pantalla sin que
 * ningun test de base de datos se entere, porque alli solo se comparan filas.
 */

describe('la escala', () => {
  it('va de 1 a 5', () => {
    expect([RATING_MIN, RATING_MAX]).toEqual([1, 5])
  })

  it('ESCALA_RATING tiene los cinco valores, en orden', () => {
    // El `Array.from` que la arma es el que preventa el error clasico de una
    // escala dibujada a mano: que le falte un valor en el medio y la pantalla
    // muestre 4 estrellas sin la de 3.
    expect(ESCALA_RATING).toEqual([1, 2, 3, 4, 5])
  })

  it.each([1, 2, 3, 4, 5])('%i es un voto valido', (n) => {
    expect(esRatingValido(n)).toBe(true)
  })

  it.each([0, -1, 6, 2.5, NaN, Infinity])('%s NO es un voto valido', (n) => {
    // `2.5` y `NaN` estan en la lista a proposito: un `<input type="number">`
    // deja escribir 2.5 si no tiene `step`, y el `Number` de un input vacio es
    // `NaN`, que sin esta comprobacion llegaria a la base como un entero raro.
    expect(esRatingValido(n)).toBe(false)
  })

  it('rechaza el 3.5 aunque promedie bien: los votos son enteros', () => {
    // Aceptar medios puntitos por el caminho de `esRatingValido` dejaria pasar
    // un 3.5 que el endpoint tiene que rechazar, o sea que los dos caminos
    // dirian que algo es valido que el otro no.
    expect(esRatingValido(3.5)).toBe(false)
    expect(Number.isInteger(3.5)).toBe(false)
  })
})

describe('el promedio', () => {
  it('con cero votos devuelve null, no 0', () => {
    // Un 0 en pantalla significa "todos loodiaron mal", que es un juicio
    // distinto de "nadie voto". `NaN` seria peor: parece un bug de calculo.
    expect(promedioDe([])).toBeNull()
  })

  it('redondea a un decimal', () => {
    // Sin redondear, 4 de 5 se muestra como 4.000000000000001.
    expect(promedioDe([{ rating: 4 }, { rating: 5 }])).toBe(4.5)
    expect(promedioDe([{ rating: 1 }, { rating: 2 }, { rating: 2 }])).toBe(1.7)
  })

  it('el texto distingue "nadie voto" de "voto mal"', () => {
    expect(textoDelPromedio([])).toMatch(/todavia no/i)
    expect(textoDelPromedio([{ rating: 1 }])).not.toMatch(/todavia no/i)
  })

  it('el texto concuerda en singular y plural, porque se lee en pantalla', () => {
    // "de 1 persona" y "de 3 personas": un `personas` fijo queda raro con uno
    // solo, y en una pantalla con una sola calificacion se nota.
    expect(textoDelPromedio([{ rating: 5 }])).toMatch(/1 persona\b/)
    expect(textoDelPromedio([{ rating: 5 }, { rating: 4 }])).toMatch(/2 personas/)
  })
})

describe('el set de etiquetas, y por que no es texto libre', () => {
  it('son ocho, todas sobre el lugar o la experiencia', () => {
    // El test de la decision, no del codigo: cada id tiene que poder leerse sin
    // saber quien estaba. "grupo_chico" habla de quantos fueron; si hubiera
    // "grupo_incomodo" o cualquier cosa que admita un nombre propio adentro, el
    // set volveria a ser el texto libre con otra forma.
    expect(ETIQUETAS_EXPERIENCIA).toHaveLength(8)
    for (const e of ETIQUETAS_EXPERIENCIA) {
      expect(e.label).toBeTruthy()
      expect(esEtiquetaValida(e.id)).toBe(true)
    }
  })

  it('el tope es tres, y el limite de 500 caracteres ya no existe', () => {
    // Tres alcanzan para decir que define el lugar y obligan a elegir. El
    // `RATING_COMMENT_MAX = 500` se elimino junto con el campo: no se ratifica
    // un limite de algo que ya no existe.
    expect(RATING_TAGS_MAX).toBe(3)
    expect(ETIQUETAS_EXPERIENCIA.length).toBeGreaterThan(RATING_TAGS_MAX)
  })

  it('rechaza cualquier id que no sea del set', () => {
    // Esto es la garantia estructural de §5.9 traducida a predicado: no hay
    // forma de que un string arbitrario sea una etiqueta. Con un campo de texto
    // esto seria `true` para todo.
    expect(esEtiquetaValida('fulano_es_un_imbecil')).toBe(false)
    expect(esEtiquetaValida('')).toBe(false)
    expect(esEtiquetaValida('Buena comida')).toBe(false) // el label, no el id
    expect(esEtiquetaValida('BUENA_COMIDA')).toBe(false) // mayusculas
  })

  it('el label se busca por id, y un id desconocido no rompe el render', () => {
    expect(etiquetaDe('buena_comida')).toBe('Buena comida')
    // Un id que no este (una base vieja, un id retirado del set) tiene que
    // devolver algo visible, no `undefined` en pantalla.
    expect(etiquetaDe('etiqueta_retirada')).toBe('etiqueta_retirada')
  })
})

describe('el conteo de etiquetas', () => {
  it('cuenta y ordena por apariciones', () => {
    expect(tallyDe([{ tags: ['vale_la_pena'] }, { tags: ['vale_la_pena', 'facil_llegar'] }])).toEqual([
      { id: 'vale_la_pena', count: 2 },
      { id: 'facil_llegar', count: 1 },
    ])
  })

  it('el resultado no dice con quien se voto', () => {
    // El conteo se publica para cualquiera que abra el plan, asi que su item no
    // puede llevar un id de persona. Si alguien le agrega `userId`, este test se
    // cae, y con razon: el agregado habria dejado de ser anonimo.
    const [vale] = tallyDe([{ tags: ['vale_la_pena'] }, { tags: ['vale_la_pena'] }])
    expect(vale).toEqual({ id: 'vale_la_pena', count: 2 })
    expect(Object.keys(vale).sort()).toEqual(['count', 'id'])
  })

  it('el conteo se publica para cualquiera que vea el plan', () => {
    // Es el mismo criterio que el promedio: un agregado no expone a quien voto.
    const tres = [{ tags: ['vale_la_pena'] }, { tags: ['vale_la_pena'] }, { tags: ['facil_llegar'] }]
    expect(tallyDe(tres)).toEqual([
      { id: 'vale_la_pena', count: 2 },
      { id: 'facil_llegar', count: 1 },
    ])
  })

  it('desempata por id y no por label, para que el orden no dependa del idioma', () => {
    // Con el mismo numero de apariciones, el orden tiene que ser estable. Si se
    // desempagara por `label`, el mismo conjunto de votos se leeria distinto en
    // dos traducciones, y el detalle del plan no puede depender del idioma del
    // lector.
    const dos = [{ tags: ['volveria'] }, { tags: ['vale_la_pena'] }]
    expect(tallyDe(dos)).toEqual(tallyDe([...dos].reverse()))
    expect(tallyDe(dos)[0].id).toBe('vale_la_pena')
  })

  it('sin etiquetas es una lista vacia, no un error', () => {
    expect(tallyDe([])).toEqual([])
    expect(tallyDe([{ tags: [] }])).toEqual([])
  })
})

describe('quien puede calificar', () => {
  it('solo quien asistio', () => {
    // La decision de producto: se califica la experiencia vivida. Un NO_SHOW no
    // puede calificar la de otros, y un ACCEPTED todavia no tiene experiencia
    // terminada que juzgar.
    expect(puedeCalificar({ status: 'ATTENDED' })).toBe(true)
    expect(puedeCalificar({ status: 'NO_SHOW' })).toBe(false)
    expect(puedeCalificar({ status: 'ACCEPTED' })).toBe(false)
    expect(puedeCalificar({ status: 'REQUESTED' })).toBe(false)
    expect(puedeCalificar({ status: 'DECLINED' })).toBe(false)
    expect(puedeCalificar({ status: 'CANCELLED' })).toBe(false)
  })

  it('quien no esta en el plan no puede calificar, y no crashea', () => {
    // El caso real es `null`: el detalle llama con
    // `viewer.participation?.status ?? null`, o sea un visitante que todavia no
    // esta en el plan. Un objeto sin `status` no se prueba porque el tipo no lo
    // permite, y `puedeCalificar` no necesita defenderse de algo que el
    // compilador ya rechaza.
    expect(puedeCalificar(null)).toBe(false)
    expect(puedeCalificar(undefined)).toBe(false)
  })
})
