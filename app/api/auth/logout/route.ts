import { NextResponse } from 'next/server'
import { clearSessionCookie } from '@/lib/auth/session'
import { assertSameOrigin } from '@/lib/http'

export async function POST(req: Request) {
  const originError = assertSameOrigin(req)
  if (originError) return originError

  // La cookie es stateless: el logout solo borra la cookie del cliente.
  // El token sigue siendo criptograficamente valido hasta que expira, asi que
  // si alguien lo copio antes, sigue sirviendo. Por eso `requireUser` relee
  // la base: no alcanza con limpiar la cookie del navegador.
  //
  // Invalidacion real de un token robado: rotar SESSION_VERSION (mata todas
  // las sesiones) o montar la tabla Session.
  const res = NextResponse.json({ ok: true })
  clearSessionCookie(res)
  return res
}
