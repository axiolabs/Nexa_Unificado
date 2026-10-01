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
  const expected = process.env.APP_ORIGIN ?? previewOrigin()

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

/**
 * Origen de un Preview deployment, como respaldo de `APP_ORIGIN`.
 *
 * `APP_ORIGIN` es UN valor, pero cada Preview deployment tiene su propio
 * dominio (`<proyecto>-<hash>-<team>.vercel.app`). Fijar un `APP_ORIGIN` en el
 * entorno Preview no puede servir: seria el dominio del preview mas viejo, y
 * todo preview nuevo daria 403 en cada mutacion. Vercel setea `VERCEL_URL`
 * (host, sin esquema) con el dominio del deployment en curso, asi que el
 * deployment puede compararse contra el suyo propio.
 *
 * Solo aplica cuando `APP_ORIGIN` NO esta definido, y **nunca en Production**:
 * `VERCEL_ENV` tambien vale `production` en los deploys reales, asi que sin
 * este filtro un `APP_ORIGIN` olvidado se reemplazaria en silencio por el
 * dominio del deployment y se perderia el fail-closed de mas abajo. En
 * Production, si falta `APP_ORIGIN`, el sitio tiene que romperse.
 *
 * Efecto colateral que conviene no olvidar: un preview abierto por su alias de
 * rama (`VERCEL_BRANCH_URL`) tiene un `Origin` distinto del de `VERCEL_URL` y
 * daria 403. El enlace que muestra Vercel y GitHub en cada PR es el del
 * deployment, asi que es el camino normal.
 */
function previewOrigin(): string | null {
  if (process.env.VERCEL_ENV === 'production') return null
  const host = process.env.VERCEL_URL
  return host ? `https://${host}` : null
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
