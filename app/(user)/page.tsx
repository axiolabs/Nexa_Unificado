'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useState } from 'react'
import { herramientasSesion, enlacesSesion } from '@/lib/home-nav'
import { destinoPostLogin } from '@/lib/login-redirect'
import type { TestStatus } from '@/lib/personality-reminder'

type User = {
  id: string
  email: string
  name: string
  isActive?: boolean
  roles?: string[]
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MIN_PASSWORD = 12

export default function Home() {
  const router = useRouter()
  const [me, setMe] = useState<User | null>(null)
  const [checked, setChecked] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'neutro' | 'error'; text: string } | null>(null)

  const refresh = useCallback(async () => {
    const res = await fetch('/api/auth/me', { cache: 'no-store' })
    if (res.ok) {
      const data = await res.json()
      setMe(data.user)
    } else {
      setMe(null)
    }
    setChecked(true)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  /**
   * A donde va la persona recien autenticada.
   *
   * Usa `GET /api/personality`, el mismo endpoint barato que ya consulta el
   * recordatorio de `/explore`. No se pide el test entero: son ocho preguntas con
   * cinco opciones cada una, unas 40 filas, y para decidir una ruta alcanza con
   * el booleano de "hay resultado".
   *
   * Si el endpoint falla se cae al mapa. Es el mismo lado al que se cae sin
   * sesion, asi que el peor caso es una pantalla conocida, no un error.
   */
  const irADestino = useCallback(async () => {
    let destino: ReturnType<typeof destinoPostLogin> = null
    try {
      const res = await fetch('/api/personality', { cache: 'no-store' })
      if (res.ok) destino = destinoPostLogin((await res.json()) as TestStatus)
    } catch {
      destino = null
    }
    router.push(destino ?? '/explore')
  }, [router])

  async function submit(path: string, body: Record<string, string>) {
    setBusy(true)
    setMsg(null)
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        const campos = data.fields
          ? '\n' + Object.entries(data.fields).map(([k, v]) => `- ${k}: ${v}`).join('\n')
          : ''
        setMsg({ kind: 'error', text: (data.error ?? `HTTP ${res.status}`) + campos })
        return
      }
      // No se muestra "Sesion iniciada." ni "Cuenta creada.": si la pantalla
      // llega a verse, es que la redireccion no ocurrio, y en ese caso el
      // boton de arriba tiene que funcionar igual. Un mensaje de exito que
      // desaparece solo confunde mas que ayudar.
      await irADestino()
    } catch (e) {
      setMsg({ kind: 'error', text: String(e) })
    } finally {
      setBusy(false)
    }
  }

  async function logout() {
    setBusy(true)
    try {
      await fetch('/api/auth/logout', { method: 'POST' })
      setMe(null)
      setMsg({ kind: 'ok', text: 'Sesion cerrada' })
    } finally {
      setBusy(false)
    }
  }

  if (!checked) return <main><p className="lede">Cargando…</p></main>

  return (
    <main>
      <h1>Nexa</h1>
      <p className="lede">Planes con gente nueva.</p>

      {msg && <p className={`msg ${msg.kind}`} role="status">{msg.text}</p>}

      {/*
        Con sesion no se muestran los formularios. Antes convivia la sesion
        arriba con los dos formularios y las notas abajo, todo a la vez: era la
        pagina de pruebas, no la puerta de entrada. Registrarte o entrar ya
        tienen exito, asi que lo unico que queda por hacer es salir.

        Esta pantalla se sigue viendo cuando alguien YA llega con sesion (o
        cuando la redireccion no corre), asi que no es un callejon sin salida:
        tiene los botones para seguir usando la app. Antes solo offercia
        "Cerrar sesion", que es la unica accion posible desde ahi.
      */}
      {me ? (
        <>
          <h2>Sesion</h2>
          <dl>
            <dt>email</dt><dd>{me.email}</dd>
            <dt>nombre</dt><dd>{me.name}</dd>
            {me.roles && <><dt>roles</dt><dd>{me.roles.join(', ')}</dd></>}
          </dl>

          {/*
            Las herramientas de rol van PRIMERO y separadas, no mezcladas con lo
            de usar la app. A un `USER` normal no le aparece ninguna, y a un
            curador le aparecen arriba, que es donde se las busca.
          */}
          {herramientasSesion(me.roles).length > 0 && (
            <section aria-label="Herramientas">
              <h3>Herramientas</h3>
              <ul className="nav-list">
                {herramientasSesion(me.roles).map((e) => (
                  <li key={e.href}>
                    <Link className="plan-go" href={e.href}>{e.label}</Link>
                    <span className="nav-hint">{e.hint}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <h2>A donde ir</h2>
          <ul className="nav-list">
            {enlacesSesion(me.roles).map((e) => (
              <li key={e.href}>
                <Link className="plan-go" href={e.href}>{e.label}</Link>
                <span className="nav-hint">{e.hint}</span>
              </li>
            ))}
          </ul>

          <div className="row" style={{ marginTop: '0.85rem' }}>
            <button className="secondary" onClick={logout} disabled={busy}>Cerrar sesion</button>
          </div>
        </>
      ) : (
        <>
          <h2>Crear cuenta</h2>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              const f = new FormData(e.currentTarget)
              void submit('/api/auth/register', {
                name: String(f.get('name') ?? ''),
                email: String(f.get('email') ?? ''),
                password: String(f.get('password') ?? ''),
              })
            }}
          >
            <label>
              Nombre
              <input name="name" required minLength={2} maxLength={80} placeholder="Ana Ruiz" />
            </label>
            <label>
              Email
              <input name="email" type="email" required placeholder="ana@example.com" />
            </label>
            <label>
              Contrasena (min. {MIN_PASSWORD})
              <input name="password" type="password" required minLength={MIN_PASSWORD} />
            </label>
            <button disabled={busy}>Crear cuenta</button>
          </form>

          <h2>Iniciar sesion</h2>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              const f = new FormData(e.currentTarget)
              void submit('/api/auth/login', {
                email: String(f.get('email') ?? ''),
                password: String(f.get('password') ?? ''),
              })
            }}
          >
            <label>
              Email
              <input name="email" type="email" required placeholder="ana@example.com" />
            </label>
            <label>
              Contrasena
              <input name="password" type="password" required />
            </label>
            <button disabled={busy}>Entrar</button>
          </form>

          <h2>Notas</h2>
          <p className="note">
            El registro normaliza el email a minusculas antes de escribir, porque el
            indice unico de Postgres distingue mayusculas. La contrasena no se
            transforma: ni trim ni minusculas, para no destruir entropia.
          </p>
        </>
      )}
    </main>
  )
}
