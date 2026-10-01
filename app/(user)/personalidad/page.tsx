import { PersonalityTestClient } from './personality-test-client'

/**
 * `/personalidad`: el test.
 *
 * Server Component minimo, sin consulta a la base, por el mismo motivo que el
 * detalle del plan: el contenido sale de `GET /api/personality/test`, que es el
 * que decide cual es la version activa. Si esta pagina leyera el test por su
 * cuenta, el cliente podria estar contestando una version que la API ya no
 * considera activa, y el 409 del POST seria la primera noticia de eso.
 *
 * La pagina NO bloquea el acceso a `/explore` ni a nada. Es saltable, y el
 * recordatorio esta en el mapa. Ver §14 de `docs/decisiones-auth.md`.
 */
export default function PersonalityTestPage() {
  return <PersonalityTestClient />
}
