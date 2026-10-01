import { describe, expect, it } from 'vitest'
import { parseBbox } from '../../lib/validation'

/**
 * `parseBbox` es el parser que decide que se consulta, asi que se prueba sin
 * base ni servidor: es logica pura y sale mas barato y mas preciso esperar por
 * HTTP que mountar una app entera para comprobar un `split`.
 *
 * Los casos que importan no son los "''los validos": son los que devuelven una
 * caja vacia, devuelven el mundo entero, o cruzan el antimeridiano. Los tres
 * fallan en silencio en la UI: el mapa muestra "no hay lugares" y no hay forma
 * de saber si es que no hay o que la consulta esta mal.
 */
describe('parseBbox', () => {
  it('interpreta el orden de GeoJSON: minLng,minLat,maxLng,maxLat', () => {
    const r = parseBbox('-58.44,-34.62,-58.36,-34.59')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // Si esto se invirtiera, la caja seria el otro cuadrante de la ciudad y la
    // consulta traeria lugares de la zona equivocada sin dar error.
    expect(r.bbox).toEqual({ minLng: -58.44, minLat: -34.62, maxLng: -58.36, maxLat: -34.59 })
  })

  it('tolera espacios alrededor de la coma', () => {
    const r = parseBbox(' -58.44 , -34.62 , -58.36 , -34.59 ')
    expect(r.ok).toBe(true)
  })

  it('rechaza si falta', () => {
    expect(parseBbox(null)).toMatchObject({ ok: false })
    expect(parseBbox(undefined)).toMatchObject({ ok: false })
    expect(parseBbox('')).toMatchObject({ ok: false })
  })

  it('rechaza la cantidad equivocada de valores', () => {
    expect(parseBbox('1,2,3').ok).toBe(false)
    expect(parseBbox('1,2,3,4,5').ok).toBe(false)
  })

  it('rechaza un valor vacio en vez de tomarlo como 0', () => {
    // Number('') es 0. Si pasara, "0,,3,4" seria una caja en el golfo de
    // Guinea y devolveria nada con toda normalidad.
    const r = parseBbox('0,,3,4')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/vacio/i)
  })

  it('rechaza texto no numerico', () => {
    expect(parseBbox('a,b,c,d').ok).toBe(false)
    expect(parseBbox('NaN,0,1,1').ok).toBe(false)
    // Infinity es Number.isFinite false, pero "Infinity" como texto tambien
    // tiene que quedar afuera.
    expect(parseBbox('-Infinity,0,1,1').ok).toBe(false)
  })

  it('rechaza latitudes imposibles', () => {
    expect(parseBbox('0,-91,1,-90').ok).toBe(false)
    expect(parseBbox('0,90,1,91').ok).toBe(false)
  })

  it('rechaza una caja entera por encima del polo', () => {
    // Los cuatro valores fuera de rango pero en el mismo extremo.
    expect(parseBbox('0,91,1,92').ok).toBe(false)
  })

  it('rechaza una caja entera por debajo del polo', () => {
    expect(parseBbox('0,-92,1,-91').ok).toBe(false)
  })

  it('rechaza longitudes imposibles', () => {
    expect(parseBbox('-181,0,-179,1').ok).toBe(false)
    expect(parseBbox('179,0,181,1').ok).toBe(false)
  })

  it('rechaza una longitud fuera de rango en el extremo del antimeridiano', () => {
    // 200 este hasta 170 oeste parece cruzar el antimeridiano, asi que el orden
    // no lo delata. Y el alto de la caja es chico, asi que el rejection tiene
    // que venir del rango de longitud, no del tope de amplitud.
    const r = parseBbox('200,-10,170,10')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/longitud debe estar entre/i)
  })

  it('rechaza una longitud fuera de rango en el otro extremo del antimeridiano', () => {
    const r = parseBbox('-170,-10,-200,10')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/longitud debe estar entre/i)
  })

  it('rechaza minLat mayor que maxLat', () => {
    // Ojo: en LONGITUD inverted es valido (antimeridiano), en LATITUD no.
    // Mezclar las dos reglas es un error clasico.
    expect(parseBbox('0,10,1,-10').ok).toBe(false)
  })

  it('ACEPTA minLng mayor que maxLng porque cruza el antimeridiano', () => {
    const r = parseBbox('170,-10,-170,10')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.bbox.minLng).toBe(170)
    expect(r.bbox.maxLng).toBe(-170)
  })

  it('rechaza una caja que abarca el mundo entero', () => {
    // Sin este tope, `bbox=-90,-180,90,180` devuelve toda la tabla en una
    // request y no hay paginacion que lo frene.
    expect(parseBbox('-180,-90,180,90').ok).toBe(false)
  })

  it('una caja que cruza el antimeridiano se mide por el camino corto', () => {
    // 179 este hasta 179 oeste, cruzando 180, son 2 grados. No 358. Si el
    // parser midiera al reves, esta caja pareceria gigante y el mapa que
    // rodea al Pacifico no cargaria lugares aunque este a la vista.
    const r = parseBbox('179,-10,-179,10')
    expect(r.ok).toBe(true)
  })

  it('rechaza una caja enorme que NO cruza el antimeridiano', () => {
    // -170 hasta 170 son 340 grados de un tiron: casi el mundo entero. El
    // tope de 60 grados la corta.
    const r = parseBbox('-170,-10,170,10')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/abarca mas de/i)
  })

  it('rechaza una caja enorme en latitud', () => {
    const r = parseBbox('0,-80,1,80')
    expect(r.ok).toBe(false)
  })

  it('acepta una caja chica y valida', () => {
    expect(parseBbox('-58.5,-34.7,-58.4,-34.6').ok).toBe(true)
  })
})
