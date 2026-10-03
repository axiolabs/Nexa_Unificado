import { NextResponse } from 'next/server'
import { getViewer, isCurator } from '@/lib/auth/guard'
import { fail } from '@/lib/http'
import { findPlacesInBbox, searchPlaces } from '@/lib/places'
import {
  PLACE_CATEGORIES,
  isPlaceCategory,
  parseBbox,
} from '@/lib/validation'

/**
 * GET /api/places?bbox=minLng,minLat,maxLng,maxLat&category=
 * GET /api/places?q=texto&category=
 *
 * PUBLICO a proposito: el mapa es la superficie de adquisicion. Un visitante
 * sin cuenta ve los mismos lugares que un usuario, y por eso la respuesta no
 * lleva datos personales de nadie.
 *
 * `bbox` y `q` son ALTERNATIVAS, no filtros combinables. Cada consumidor usa el
 * que le corresponde: el mapa pide una caja, el selector de lugar para crear un
 * plan pide un nombre. Aceptar los dos juntos no tendria semantica clara (una
 * caja mas un texto es un AND que nadie pidio), asi que se rechaza con 400 en
 * vez de aplicar un AND silencioso. Y `bbox` sin `q` no es un caso valido: sin
 * ninguno de los dos no hay consulta que hacer.
 *
 * Lo que NO viaja en esta respuesta, y por que:
 *
 *   - `ownerId` / `verifiedById`: son ids internos que ademas identifican cuentas.
 *   - Detalle de planes: solo el entero agregado `openPlanCount`. La hora, el
 *     organizador y los participantes de un plan NO van aca; viven en
 *     `/api/plans/[planId]`, que exige sesion. Publicar "sabado 20:00, van 4
 *     personas a este bar" en un mapa publico expone la whereabouts de gente
 *     que no pidio que fuera publica.
 *
 * Un curador con sesion ve ademas los `PENDING`. Para un visitante anonimo son
 * invisibles, y `visibleWhere` en `lib/places.ts` lo garantiza en la consulta,
 * no en el filtro posterior: filtrar despues de traer seria traer los datos
 * y descartar la respuesta, que es distinto de no haberlos queried.
 */
export async function GET(req: Request) {
  const url = new URL(req.url)

  const rawBbox = url.searchParams.get('bbox')
  const rawQ = url.searchParams.get('q')

  // Antes de validar el bbox, que es donde la consulta falla primero. Un
  // `?bbox=...&q=cafe` es un error de contrato, no de formato, y el mensaje de
  // formato ("abarca demasiado") desorientaria.
  if (rawBbox !== null && rawQ !== null) {
    return fail(400, 'Usa bbox o q, no los dos: son filtros alternativos')
  }
  if (rawBbox === null && rawQ === null) {
    return fail(400, 'Falta bbox o q: el mapa pide una caja, la busqueda un nombre')
  }

  const category = url.searchParams.get('category') ?? undefined

  // La query string la controla cualquiera y estos valores llegan a la consulta.
  // Contra la lista cerrada, no con un cast a ciegas: sin esto un
  // `?category=INVENTADO` seria un 500 desde Postgres en vez de un 400 con un
  // mensaje que dice que valores si valen.
  if (category !== undefined && !isPlaceCategory(category)) {
    return fail(400, `category invalido. Valores: ${PLACE_CATEGORIES.join(', ')}`)
  }

  const viewer = await getViewer()
  const cur = isCurator(viewer?.roles)
  const who = viewer ? { isCurator: cur } : null

  // Sin cache compartida: la respuesta depende de quien pregunta (el
  // curador ve mas) y una cache comun serviria los PENDING a un anonimo.
  const noStore = { headers: { 'cache-control': 'private, no-store' } }

  if (rawQ !== null) {
    const q = rawQ.trim()
    // Piso de 2 caracteres, y es un 400 explicito, no una lista vacia: sin esto
    // el endpoint es un volcado de la tabla a cambio de una tecla pulsada. El
    // mensaje explica el motivo, para que no haya que leer el codigo.
    if (q.length < 2) {
      return fail(400, 'La busqueda necesita al menos 2 caracteres')
    }
    const result = await searchPlaces(q, { category }, { isCurator: cur })
    // `total` y `truncated` viajan en la respuesta a proposito: el selector de
    // lugares tiene que poder decir "20 de 57". Un tope invisible convierte
    // "el lugar que busco no aparece" en un bug sin diagnostico posible.
    //
    // El camino por `bbox` NO los manda, y la diferencia es consciente: alla el
    // tope de 500 de `findPlacesInBbox` coincide con el viewport, asi que lo
    // que no aparece esta, por definicion, fuera de pantalla. Aun asi es un
    // tope sin avisar y queda anotado como deuda.
    return NextResponse.json({ ...result, viewer: who }, noStore)
  }

  const parsed = parseBbox(rawBbox)
  if (!parsed.ok) return fail(400, parsed.error)

  const places = await findPlacesInBbox(parsed.bbox, { category }, { isCurator: cur })

  return NextResponse.json({ places, viewer: who }, noStore)
}
