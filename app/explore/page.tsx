import type { Metadata } from 'next'
import ExploreClient from './explore-client'

/**
 * /explore
 *
 * El mapa es la pagina publica del producto, asi que va en su propia ruta y no
 * dentro de `(user)`: las rutas entre parentesis no afectan la URL, y `/` ya la
 * ocupa la pantalla de sesion.
 *
 * Este archivo es un Server Component a proposito. Dos razones:
 *   1. `metadata` solo se exporta desde un Server Component.
 *   2. Mantiene el bundle de Leaflet fuera del servidor. Leaflet toca `window`
 *      en el momento de importarse, asi que importarlo desde un Server
 *      Component revienta el render.
 */
export const metadata: Metadata = {
  title: 'Explorar',
  description: 'Mapa de lugares y planes abiertos en tu zona.',
}

export default function ExplorePage() {
  return <ExploreClient />
}
