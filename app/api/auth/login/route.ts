import { NextResponse } from 'next/server'
import { getPrisma } from '@/lib/db'
import { getDummyHash, verifyPassword } from '@/lib/auth/password'
import { attachSessionCookie, createSessionToken } from '@/lib/auth/session'
import { assertSameOrigin, fail, readJson } from '@/lib/http'
import { fieldErrors, loginSchema, normalizeEmail } from '@/lib/validation'

export async function POST(req: Request) {
  const originError = assertSameOrigin(req)
  if (originError) return originError

  const body = await readJson(req)
  const parsed = loginSchema.safeParse(body)
  if (!parsed.success) {
    return fail(400, 'Datos invalidos', { fields: fieldErrors(parsed.error) })
  }

  const email = normalizeEmail(parsed.data.email)

  const user = await getPrisma().user.findUnique({
    where: { email },
    select: {
      id: true,
      email: true,
      name: true,
      passwordHash: true,
      isActive: true,
      suspendedAt: true,
      deletedAt: true,
    },
  })

  // Si el usuario no existe no hay hash con que comparar, y comparar "no" contra
  // nada responderia en microsegundos. Para que el tiempo de respuesta no revele
  // que emails estan registrados, se verifica SIEMPRE, y contra un hash real
  // cuando el usuario no existe. Ver `getDummyHash` para por que se genera en
  // vez de hardcodearse.
  const hashToVerify = user?.passwordHash ?? (await getDummyHash())
  const passwordMatches = await verifyPassword(hashToVerify, parsed.data.password)

  if (!user || !user.passwordHash || !passwordMatches) {
    return fail(401, 'Email o contrasena incorrectos')
  }

  if (!user.isActive || user.deletedAt) {
    return fail(403, 'La cuenta esta desactivada')
  }
  if (user.suspendedAt) {
    return fail(403, 'La cuenta esta suspendida')
  }

  const res = NextResponse.json({
    user: { id: user.id, email: user.email, name: user.name },
  })
  attachSessionCookie(res, createSessionToken(user.id))
  return res
}
