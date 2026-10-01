import { describe, expect, it } from 'vitest'
import { buildBbox, isSameBbox } from '../../lib/map-bbox'
import { DEFAULT_CENTER, DEFAULT_ZOOM } from '../../lib/map-tiles'
import { MAX_LAT_SPAN, MAX_LNG_SPAN, parseBbox } from '../../lib/validation'

/**
 * La caja que se le pide a la API sale de aqui, y es la unica logica del mapa
 * que se puede testear sin montar Leaflet.
 *
 * Por que vale la pena testearla: el sintoma de una caja mal calculada es que
 * el mapa "no encuentra" lugares que el usuario tiene en pantalla. Eso no parece
 * un bug de la caja, parece un bug de datos, y alguien va a debugear la base
 * de datos en lugar de estas 40 lineas.
 */

const BA = { lat: -34.6037, lng: -58.3816 }

/**
 * ¿La longitud cae dentro de la caja?
 *
 * Una caja que cruza el antimeridiano viene con `minLng > maxLng`, y comparar
 * con `>=` y `<=` a secas la declara vacia. Ese caso no es teorico: aparece en
 * cualquier centro cerca del meridiano 180 con zoom bajo, que es justo donde el
 * recorte de amplitud esta activo.
 */
function longitudDentro(b: { minLng: number; maxLng: number }, lng: number): boolean {
  if (b.minLng <= b.maxLng) return lng >= b.minLng && lng <= b.maxLng
  return lng >= b.minLng || lng <= b.maxLng
}

describe('buildBbox', () => {
  it('el centro queda dentro de la caja', () => {
    for (const zoom of [3, 8, 13, 17, 19]) {
      const b = buildBbox(BA, zoom)
      expect(b.minLat, `lat sur, zoom ${zoom}`).toBeLessThan(BA.lat)
      expect(b.maxLat, `lat norte, zoom ${zoom}`).toBeGreaterThan(BA.lat)
      expect(b.minLng, `lng oeste, zoom ${zoom}`).toBeLessThan(BA.lng)
      expect(b.maxLng, `lng este, zoom ${zoom}`).toBeGreaterThan(BA.lng)
    }
  })

  it('mas zoom, caja mas chica mientras no llegue al tope de la API', () => {
    // La monotonia solo vale donde la caja NO esta recortada por `MAX_LNG_SPAN`.
    // Abajo del zoom en que eso pasa, la caja es siempre de 60 grados: mas zoom
    // no la achica porque ya esta pegada al limite que impone la API.
    const ancho = (z: number) => {
      const b = buildBbox(BA, z)
      return b.maxLng - b.minLng
    }
    // El recorte se activa en el zoom donde la caja teorica pasa los 60 grados.
    for (let z = 10; z < 19; z++) {
      expect(ancho(z + 1), `lng ${z}->${z+1}`).toBeLessThan(ancho(z))
      const b1 = buildBbox(BA, z)
      const b2 = buildBbox(BA, z + 1)
      expect(b2.maxLat - b2.minLat, `lat ${z}->${z+1}`).toBeLessThan(b1.maxLat - b1.minLat)
    }
  })

  it('con zoom bajo la caja se queda en el tope, no crece mas alla', () => {
    // Zoom out no puede romper el limite de amplitud: la caja tiene que dejar de
    // crecer cuando llega al tope. Si creciera, la API responderia 400 y el mapa
    // se vaciaria justo cuando el usuario quiere ver mas.
    for (const z of [2, 4, 6, 8]) {
      const b = buildBbox(BA, z)
      expect(b.maxLng - b.minLng, `lng zoom ${z}`).toBeLessThanOrEqual(MAX_LNG_SPAN)
      expect(b.maxLat - b.minLat, `lat zoom ${z}`).toBeLessThanOrEqual(MAX_LAT_SPAN)
    }
  })

  it('la caja recortada queda centrada en lo que el usuario mira', () => {
    // El error que este test persigue: al recortar, encoger los dos bordes de a
    // la misma cantidad de grados. La caja de Mercator es simetrica en `y`, no en
    // latitud, asi que encoger parejo desplaza el centro y la caja queda pegada
    // al ecuador, con el lugar que el usuario mira fuera de la consulta.
    //
    // Solo se afirma el centrado en los zooms donde el recorte ocurre de verdad.
    // En un zoom donde la caja NO se recorta, el punto medio en GRADOS de una
    // proyeccion no lineal no es la latitud del centro, y afirmarlo seria
    // afirmar un error de la matematica.
    for (const z of [2, 4]) {
      const b = buildBbox(BA, z)
      expect(b.maxLng - b.minLng, `lng recortado zoom ${z}`).toBeCloseTo(MAX_LNG_SPAN, 6)
      expect(b.maxLat - b.minLat, `lat recortado zoom ${z}`).toBeCloseTo(MAX_LAT_SPAN, 6)
      expect((b.minLng + b.maxLng) / 2, `centro lng zoom ${z}`).toBeCloseTo(BA.lng, 6)
      expect((b.minLat + b.maxLat) / 2, `centro lat zoom ${z}`).toBeCloseTo(BA.lat, 6)
      // Y lo importante: el lugar que se mira esta dentro.
      expect(b.minLat).toBeLessThan(BA.lat)
      expect(b.maxLat).toBeGreaterThan(BA.lat)
    }
  })

  it('en un zoom sin recortar, el centro igual queda dentro de la caja', () => {
    // El caso complementario: si la caja es chica, alcanza con que contenga al
    // centro, no con que su punto medio en grados coincida con el.
    for (const z of [8, 12, 16, 19]) {
      const b = buildBbox(BA, z)
      expect(b.minLat, `lat sur zoom ${z}`).toBeLessThan(BA.lat)
      expect(b.maxLat, `lat norte zoom ${z}`).toBeGreaterThan(BA.lat)
      expect(b.minLng, `lng oeste zoom ${z}`).toBeLessThan(BA.lng)
      expect(b.maxLng, `lng este zoom ${z}`).toBeGreaterThan(BA.lng)
    }
  })

  it('el zoom alto se achica al espaciado real de la pantalla', () => {
    // La razon de `buildBbox` existir: la caja de la app tiene que describir lo
    // que se ve, no un cuadrado teorico. Con un viewport de 2000 px a zoom 17,
    // una caja de 200 px traeria una fraccion de lo que hay en pantalla.
    const chico = buildBbox(BA, 17, { viewportPx: 200 })
    const grande = buildBbox(BA, 17, { viewportPx: 2000 })
    expect(grande.maxLng - grande.minLng).toBeGreaterThan((chico.maxLng - chico.minLng) * 5)
  })

  it('el margen agranda la caja para que el borde no entre y salga', () => {
    const sinMargen = buildBbox(BA, 13, { margin: 0 })
    const conMargen = buildBbox(BA, 13)
    expect(conMargen.maxLng - conMargen.minLng).toBeGreaterThan(sinMargen.maxLng - sinMargen.minLng)
    expect(conMargen.maxLat - conMargen.minLat).toBeGreaterThan(sinMargen.maxLat - sinMargen.minLat)
  })

  it('la caja nunca sale de los polos ni del antimeridiano', () => {
    // Un centro en el norte con el margen por default se pasaria de 90 sin
    // recortar, y `parseBbox` lo rechazaria con 400: la pagina quedaria sin
    // mapa al navegar al norte.
    for (const centro of [
      { lat: 89.9, lng: 0 },
      { lat: -89.9, lng: 0 },
      { lat: 0, lng: 179.9 },
      { lat: 0, lng: -179.9 },
    ]) {
      const b = buildBbox(centro, 5)
      expect(b.minLat).toBeGreaterThanOrEqual(-90)
      expect(b.maxLat).toBeLessThanOrEqual(90)
      expect(b.minLng).toBeGreaterThanOrEqual(-180)
      expect(b.maxLng).toBeLessThanOrEqual(180)
      const parsed = parseBbox(`${b.minLng},${b.minLat},${b.maxLng},${b.maxLat}`)
      expect(parsed.ok, `caja de ${JSON.stringify(centro)}`).toBe(true)
    }
  })

  it('la caja que produce es siempre aceptada por el validador de la API', () => {
    // Este es el test de cierre entre los dos modulos. Si `buildBbox` y
    // `parseBbox` se disenan distinto, la pagina pide algo que la API rechaza
    // con 400 y el sintoma es "el mapa no carga en ningun lado".
    //
    // El zoom 0 y el 1 estan porque son los mas alejados que `buildBbox` acepta
    // (los recorta a [0, 19]) y los que mas recortan. Si el recorte se rompe,
    // es aca donde se ve, no en el zoom 13 con el que se abre la pagina.
    const puntos: Array<{ lat: number; lng: number }> = []
    for (let lat = -85; lat <= 85; lat += 5) {
      for (let lng = -180; lng <= 180; lng += 15) {
        puntos.push({ lat, lng })
      }
    }
    for (const p of puntos) {
      for (const zoom of [0, 1, 2, 6, 11, 16, 19]) {
        const b = buildBbox(p, zoom)
        const parsed = parseBbox(`${b.minLng},${b.minLat},${b.maxLng},${b.maxLat}`)
        expect(parsed.ok, `centro ${JSON.stringify(p)} zoom ${zoom}: ${b.minLng},${b.minLat},${b.maxLng},${b.maxLat}`).toBe(true)
      }
    }
  })

  it('el centro visual cae dentro de la caja en TODO zoom, incluso en el mas alejado', () => {
    // Esta es la otra mitad del contrato, y es distinta de la de arriba.
    //
    // Que la caja sea VALIDA solo garantiza que la peticion no reviente. Falta
    // garantizar que CONTENGA lo que el usuario tiene en el centro de la
    // pantalla. Son dos cosas distintas y la segunda es la que se ve:
    //
    // Con zoom 0 la caja teorica seria el planeta entero, y `MAX_LNG_SPAN` la
    // recorta a 60 grados. Como el recorte se define a partir del centro del
    // visor, el centro queda dentro por construccion. Ese "por construccion" es
    // justo lo que puede romperse sin que nadie se entere: si alguien "simplifica"
    // el recorte a `minLng = Math.max(-180, minLng)` y saca el recentrado, la
    // caja sigue siendo valida, el mapa sigue cargando, y el lugar que el
    // usuario esta mirando cae FUERA de la consulta. Se ve como un mapa con
    // vacios en el medio, no como un error.
    const puntos: Array<{ lat: number; lng: number }> = []
    for (let lat = -85; lat <= 85; lat += 10) {
      for (let lng = -180; lng <= 180; lng += 20) {
        puntos.push({ lat, lng })
      }
    }
    for (const p of puntos) {
      for (const zoom of [0, 1, 2, 6, 11, 16, 19]) {
        const b = buildBbox(p, zoom)
        const donde = `centro ${JSON.stringify(p)} zoom ${zoom}: ${b.minLng},${b.minLat},${b.maxLng},${b.maxLat}`
        expect(b.minLat, `lat sur, ${donde}`).toBeLessThanOrEqual(p.lat)
        expect(b.maxLat, `lat norte, ${donde}`).toBeGreaterThanOrEqual(p.lat)
        expect(longitudDentro(b, p.lng), `lng, ${donde}`).toBe(true)
      }
    }
  })

  it('con zoom alejado la caja se capa, y esa diferencia es lo pactado', () => {
    // Fija el trade a proposito, para que no se "arregle" sin que nadie decida.
    //
    // A zoom 0 la vista muestra practicamente el planeta entero. Lo que se PIDE
    // son 60 grados de longitud, el tope de la API. Ese desajuste entre lo que
    // se ve y lo que se carga es real y es a proposito: hoy no existe forma de
    // pedir mas, asi que la opcion no es "cargar todo" sino "cargar el centro y
    // aceptar que el borde no tiene datos".
    //
    // Si alguna vez hay que resolverlo, se cambia `MAX_LNG_SPAN` en
    // `lib/validation.ts` (que es de donde lo lee el mapa), NO el recorte de
    // `buildBbox`. Tocar solo el mapa deja los dos modulos en desacuerdo, que
    // es el bug que este archivo existe para cazar.
    const lejos = buildBbox(BA, 0)
    expect(lejos.maxLng - lejos.minLng).toBeCloseTo(MAX_LNG_SPAN, 6)
    expect(lejos.maxLat - lejos.minLat).toBeCloseTo(MAX_LAT_SPAN, 6)

    // Chiquena respecto de lo que se ve: 60 de 360 grados, un sexto del mundo.
    expect(lejos.maxLng - lejos.minLng).toBeLessThan(360 / 4)

    // Pero centrada en lo que se mira, no pegada a un borde.
    expect(lejos.minLng).toBeLessThan(BA.lng)
    expect(lejos.maxLng).toBeGreaterThan(BA.lng)
    expect(lejos.minLat).toBeLessThan(BA.lat)
    expect(lejos.maxLat).toBeGreaterThan(BA.lat)

    // Y el zoom alto sigue dando una caja mas chica: el recorte es un tope, no
    // un piso.
    const cerca = buildBbox(BA, 14)
    expect(cerca.maxLng - cerca.minLng).toBeLessThan(lejos.maxLng - lejos.minLng)
  })

  it('la caja por defecto cubre los lugares del seed en Manizales', () => {
    // Si el centro por defecto no cubre el seed, la primera pantalla que ve
    // alguien nuevo esta vacia y parece que la app no tiene datos.
    //
    // Este test usa `DEFAULT_CENTER` de verdad. Antes usaba la constante `BA` de
    // arriba, o sea que el titulo mentia: cualquier centro por defecto pasaba
    // el test, incluido uno que no tuviera nada que ver con el seed. Por eso
    // `DEFAULT_CENTER` y `DEFAULT_ZOOM` estan importados arriba: si alguien
    // cambia la ciudad del producto y no actualiza el seed, esto falla.
    const b = buildBbox(DEFAULT_CENTER, DEFAULT_ZOOM)

    // Coordenadas del seed de `prisma/seed.mjs`. El primero es el centro.
    const seed = [
      { lat: 5.0758, lng: -75.5146 }, // Monumento a los Nevados
      { lat: 5.1519, lng: -75.4925 }, // Parque del Cafe
      { lat: 5.0706, lng: -75.5209 }, // Museo de Arte Moderno
      { lat: 5.0731, lng: -75.5188 }, // Biblioteca Publica
      { lat: 5.0672, lng: -75.5293 }, // Universidad de Caldas
      { lat: 5.0745, lng: -75.5298 }, // Rio Blanco
      { lat: 5.0703, lng: -75.5183 }, // Cable Plaza
      { lat: 5.0843, lng: -75.5495 }, // Termas de Manizales
    ]

    for (const p of seed) {
      expect(p.lat, `lat de ${p.lat},${p.lng} fuera de la caja`).toBeGreaterThan(b.minLat)
      expect(p.lat, `lat de ${p.lat},${p.lng} fuera de la caja`).toBeLessThan(b.maxLat)
      expect(p.lng, `lng de ${p.lat},${p.lng} fuera de la caja`).toBeGreaterThan(b.minLng)
      expect(p.lng, `lng de ${p.lat},${p.lng} fuera de la caja`).toBeLessThan(b.maxLng)
    }

    // Y que entre en la caja de la API sin reventar el limite de amplitud.
    expect(b.maxLat - b.minLat).toBeLessThan(180)
    expect(b.maxLng - b.minLng).toBeLessThan(360)
  })
})

describe('isSameBbox', () => {
  const b = { minLat: -34.7, minLng: -58.5, maxLat: -34.5, maxLng: -58.2 }

  it('una caja igual es la misma', () => {
    expect(isSameBbox(b, { ...b })).toBe(true)
  })

  it('el ruido de redondeo de subpixel no cuenta como movimiento', () => {
    // Leaflet devuelve coordenadas redondeadas desde el modelo proyectado. Sin
    // tolerancia, cada arrastre de un pixel dispara una consulta.
    expect(isSameBbox(b, { ...b, minLng: b.minLng + 1e-9 })).toBe(true)
  })

  it('un movimiento real si cuenta', () => {
    // Un grado es mucho mas que el redondeo, y es lo que evita consultar en
    // cada pixel de un arrastre lento.
    expect(isSameBbox(b, { ...b, minLng: b.minLng - 0.01 })).toBe(false)
    expect(isSameBbox(b, { ...b, maxLat: b.maxLat + 0.01 })).toBe(false)
  })

  it('distingue cualquier cambio de dimensión', () => {
    expect(isSameBbox(b, { ...b, minLat: b.minLat - 0.5 })).toBe(false)
    expect(isSameBbox(b, { ...b, maxLng: b.maxLng + 0.5 })).toBe(false)
  })
})
