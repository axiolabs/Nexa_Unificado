import { PerfilClient } from './perfil-client'

/**
 * `/perfil`: los rasgos de la persona, y solo los suyos.
 *
 * Mismo criterio que el detalle del plan: este `page.tsx` no consulta la base.
 * Que el puntaje se calcule en el cliente o en un Server Component no cambia el
 * dato que sale, y duplicar la consulta abre dos copias de las reglas que
 * divergen. Ademas el puntaje es DERIVADO: se recalcula con `lib/personality.ts`
 * desde las respuestas, y la unica copia del algoritmo tiene que estar en
 * `lib/`, no en dos pantallas.
 *
 * La proteccion vive en el middleware por prefijo (`/perfil` esta en
 * `AUTHENTICATED_PREFIXES`).
 */
export default function PerfilPage() {
  return <PerfilClient />
}
