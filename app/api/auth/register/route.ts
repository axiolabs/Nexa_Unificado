import { NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { getPrisma } from '@/lib/db'
import { hashPassword } from '@/lib/auth/password'
import { attachSessionCookie, createSessionToken } from '@/lib/auth/session'
import { assertSameOrigin, fail, readJson } from '@/lib/http'
import { fieldErrors, normalizeEmail, registerSchema } from '@/lib/validation'

export async function POST(req: Request) {
  const originError = assertSameOrigin(req)
  if (originError) return originError

  const body = await readJson(req)
  const parsed = registerSchema.safeParse(body)
  if (!parsed.success) {
    return fail(400, 'Datos invalidos', { fields: fieldErrors(parsed.error) })
  }

  const email = normalizeEmail(parsed.data.email)
  const { name, password } = parsed.data

  // Se hashea ANTES de tocar la base. Si el hasheo falla (memoria, CPU) no
  // queda ningun usuario a medias en la tabla.
  const passwordHash = await hashPassword(password)

  try {
    const user = await getPrisma().user.create({
      data: {
        email,
        name,
        passwordHash,
        roles: { create: { role: 'USER' } },
      },
      select: { id: true, email: true, name: true },
    })

    // El registro deja al usuario con sesion iniciada: si lo obligamos a
    // escribir email y contrasena otra vez para entrar, es una barrera
    // absurda y encima un password manager lo vuelve tedioso.
    const res = NextResponse.json({ user }, { status: 201 })
    attachSessionCookie(res, createSessionToken(user.id))
    return res
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      // P2002 es la violacion del indice unico de email. Se captura aca y no
      // se traduce en un 500.
      //
      // Esto SÍ revela que el email ya esta registrado. Es un trade-off
      // consciente: el mensaje "ya tenes cuenta, entra" evita que alguien
      // cree una cuenta que no va a poder usar. El costo es enumeracion de
      // emails. Si en algun momento molesta mas de lo que ayuda, el
      // compromiso es devolver 201 siempre y avisar por email.
      return fail(409, 'Ya existe una cuenta con ese email')
    }
    throw err
  }
}
