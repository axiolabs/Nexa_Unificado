'use client'

import { useCallback, useEffect, useState } from 'react'

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
      // Texto para la persona, no el path del endpoint que respondio. "OK
      // /api/auth/login" no le dice nada a nadie.
      setMsg({
        kind: 'ok',
        text: path.endsWith('/register')
          ? 'Cuenta creada. Ya podes entrar.'
          : 'Sesion iniciada.',
      })
      await refresh()
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
      */}
      {me ? (
        <>
          <h2>Sesion</h2>
          <dl>
            <dt>email</dt><dd>{me.email}</dd>
            <dt>nombre</dt><dd>{me.name}</dd>
            {me.roles && <><dt>roles</dt><dd>{me.roles.join(', ')}</dd></>}
          </dl>
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
