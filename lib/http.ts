import { NextResponse } from 'next/server'

/**
 * Chequeo de Origin para mutaciones.
 *
 * `sameSite: 'lax'` ya bloquea el caso CSRF clasico (un form cross-origin que
 * postea a /api/auth/login). Esto es defensa en profundidad y cubre el otro
 * caso: same-origin con XSS, donde el navegador envia el Origin legitimo pero
 * el script ya corre dentro de la pagina.
 *
 * Solo se exige Origin en mutaciones. En GET el navegador puede omitirlo
 * (navigation, prefetch) y no seria un ataque.
 */
export function assertSameOrigin(req: Request): NextResponse | null {
  const origin = req.headers.get('origin')
  const expected = process.env.APP_ORIGIN

  if (!expected) {
    // Fallar abierto seria una decision de seguridad implicita y silenciosa.
    // Mejor romper en dev para que se note, y en prod exigir que este definido.
    if (process.env.NODE_ENV !== 'production') return null
    return NextResponse.json(
      { error: 'APP_ORIGIN no esta definido' },
      { status: 500 },
    )
  }

  if (!origin) {
    return NextResponse.json({ error: 'Falta el header Origin' }, { status: 403 })
  }
  if (origin !== expected) {
    return NextResponse.json({ error: 'Origen no permitido' }, { status: 403 })
  }
  return null
}

/** Lee y parsea un body JSON, tolerando que no sea JSON valido. */
export async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    return null
  }
}

export function fail(status: number, error: string, extra?: Record<string, unknown>) {
  return NextResponse.json({ error, ...extra }, { status })
}
