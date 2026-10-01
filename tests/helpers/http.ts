import { BASE_URL } from './env'

const BASE = BASE_URL

/**
 * Cliente HTTP minimo con jar de cookies.
 *
 * A proposito no se usa supertest ni nada que monte la app en proceso: los
 * tests pegan a un server real, porque lo que hay que verificar es que el
 * MIDDLEWARE corre. Ver `tests/setup/server.ts`.
 */
export class Client {
  private cookies = new Map<string, string>()

  constructor(readonly origin: string = BASE) {}

  /** Copia el jar. Para simular "otro dispositivo" con la misma cuenta. */
  fork(): Client {
    const c = new Client(this.origin)
    c.cookies = new Map(this.cookies)
    return c
  }

  get cookieHeader(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ')
  }

  setCookie(name: string, value: string): void {
    this.cookies.set(name, value)
  }

  clearCookies(): void {
    this.cookies.clear()
  }

  async req(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers)
    if (this.cookieHeader) headers.set('cookie', this.cookieHeader)
    // Origin siempre presente: es lo que exige assertSameOrigin, y las rutas
    // de API rechazan el request sin el.
    if (!headers.has('origin')) headers.set('origin', this.origin)

    const res = await fetch(this.origin + path, { ...init, headers, redirect: 'manual' })

    for (const raw of res.headers.getSetCookie()) {
      const [pair] = raw.split(';')
      const eq = pair.indexOf('=')
      if (eq > 0) {
        const name = pair.slice(0, eq).trim()
        const value = pair.slice(eq + 1).trim()
        if (value === '') this.cookies.delete(name)
        else this.cookies.set(name, value)
      }
    }

    const text = await res.text()
    let body: unknown = text
    try {
      body = JSON.parse(text)
    } catch {
      // el middleware devuelve texto plano en 403 de paginas
    }
    return { status: res.status, body, text, headers: res.headers }
  }

  get = (path: string) => this.req(path, { method: 'GET' })
  post = (path: string, json: unknown) =>
    this.req(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof json === 'string' ? json : JSON.stringify(json),
    })

  /** Login real contra la API. Deja el jar con la cookie de sesion. */
  async login(email: string, password: string) {
    return this.post('/api/auth/login', { email, password })
  }

  /** Registro real contra la API. */
  async register(name: string, email: string, password: string) {
    return this.post('/api/auth/register', { name, email, password })
  }
}

export function json(body: unknown): string {
  return JSON.stringify(body)
}
