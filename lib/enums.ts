/**
 * Las listas cerradas del dominio, en un modulo sin dependencias.
 *
 * Viven aparte de `lib/validation.ts` a proposito: ese archivo importa zod, y un
 * Client Component que importa de ahi se trae zod entero al bundle del cliente
 * para leer dos arrays de strings. Ademas, estas listas son la referencia que el
 * cliente usa para armar sus filtros, y ya paso lo que pasa cuando cada uno
 * escribe su propia copia: el explorador se habia inventado sus propios valores
 * de precio y mandaba en la query strings que **ninguna** existia en el enum,
 * o sea, elegir un filtro en el mapa devolvia un 400. No habia test que lo
 * cubriera, porque el test de sincronia compara estas listas contra Prisma: ambas
 * estaban bien, la copia del cliente era la que mentia.
 *
 * Importar desde aca hace que la desincronizacion sea imposible por
 * construccion, que es mas barato que un test que la detecte.
 */

export const PLACE_CATEGORIES = [
  'CAFE',
  'RESTAURANT',
  'MUSEUM',
  'PARK',
  'WORKSHOP',
  'SPORTS',
  'BAR',
  'LIBRARY',
  'OTHER',
] as const

/**
 * Los unions, exportados para que el cliente los use en vez de `string`.
 *
 * Un `category: string` obliga a castear en cada acceso, y ahi es donde un valor
 * de la API que no existe en la lista se convierte en `undefined` en pantalla sin
 * que TypeScript avise: `CATEGORY_LABELS[categoria]` compila y no falla. Con el
 * union, ese indexado solo admite una clave real, y la desincronizacion aparece
 * en el compilado y no en el texto que ve el usuario.
 */
export type PlaceCategoryValue = (typeof PLACE_CATEGORIES)[number]

/** Etiquetas para mostrar. La clave es el valor del enum, nunca otra. */
export const CATEGORY_LABELS: Record<(typeof PLACE_CATEGORIES)[number], string> = {
  CAFE: 'Cafe',
  RESTAURANT: 'Restaurante',
  MUSEUM: 'Museo',
  PARK: 'Parque',
  WORKSHOP: 'Taller',
  SPORTS: 'Deporte',
  BAR: 'Bar',
  LIBRARY: 'Libreria',
  OTHER: 'Otro',
}
