import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth/guard'
import { ROLE } from '@/lib/authz'
import { fail } from '@/lib/http'
import { searchPlaces } from '@/lib/places'

/**
 * GET /api/host/places?q=texto&category=
 *
 * El selector de lugares del formulario de creacion de plan. Es un endpoint
 * DISTINTO de `/api/places?q=` y no un parametro extra, por una razon que
 * importa: los dos devuelven conjuntos diferentes a proposito.
 *
 * - `/api/places` es publico y responde a "¿que lugares puedo ver?": incluye los
 *   `PENDING` si sos curador, porque verlos es tu trabajo.
 * - Este responde a "¿en que lugares puedo hacer un plan?": usa
 *   `planablePlaceWhere()`, que es mas estricto y solo da `APPROVED`.
 *
 * Con un unico endpoint y un flag, un curador veria `PENDING` en el selector,
 * completaria el formulario entero, y el `POST /api/plans` le responderia 404 al
 * final. El error no estaria mal, pero llega tarde y sin decir cual de los dos
 * lados estaba equivocado. Mostrar solo lo que se puede usar convierte el error
 * en algo que no puede llegar a ocurrir.
 *
 * El rol se verifica en el handler, no en el middleware: el middleware solo
 * cubre paginas por prefijo, y una API que cede de rol seria un agujero.
 */
export async function GET(req: Request) {
  const gate = await requireRole([ROLE.HOST, ROLE.ADMIN])
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })

  const url = new URL(req.url)
  const rawQ = url.searchParams.get('q')
  if (rawQ === null) {
    return fail(400, 'Falta q: este endpoint solo busca por nombre')
  }

  const q = rawQ.trim()
  if (q.length < 2) {
    return fail(400, 'La busqueda necesita al menos 2 caracteres')
  }

  // Este handler no acepta filtros de la query: el formulario de creacion no los
  // ofrece, y aceptarlos sin validarlos seria una puerta que se puede abrir en el
  // futuro sin que nadie la mire.
  const result = await searchPlaces(q, {}, { planableOnly: true })

  return NextResponse.json(result, { headers: { 'cache-control': 'private, no-store' } })
}
