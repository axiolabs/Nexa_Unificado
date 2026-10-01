'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'

/**
 * `/perfil`: los rasgos de la persona.
 *
 * Solo lectura. No hay boton de "rehacer el test" aca, y es a proposito: rehacerlo
 * es una decision que se toma desde el recordatorio del mapa, que es donde se
 * llega al test. Un boton que borra un resultado sin explicacion es un boton que
 * la gente toca sin querer.
 */

type Rasgo = {
  key: string
  label: string
  category: string
  description: string | null
  value: number
  posicion: number
  nivel: string
}

type Resultado = {
  id: string
  completadoEn: string
  testVersion: number
  testNombre: string
  rasgos: Rasgo[]
}

const NIVELES: Record<string, string> = {
  muy_bajo: 'muy bajo',
  bajo: 'bajo',
  medio: 'en el medio',
  alto: 'alto',
  muy_alto: 'muy alto',
}

export function PerfilClient() {
  const [cargando, setCargando] = useState(true)
  const [resultado, setResultado] = useState<Resultado | null>(null)
  const [hayTest, setHayTest] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const cargar = useCallback(async () => {
    try {
      const [res, status] = await Promise.all([
        fetch('/api/personality/resultado', { cache: 'no-store' }),
        fetch('/api/personality', { cache: 'no-store' }),
      ])
      if (!res.ok) {
        setError(res.status === 401 ? 'Necesitas iniciar sesion' : 'No pudimos leer tu perfil')
        return
      }
      const data = (await res.json()) as { resultado: Resultado | null }
      setResultado(data.resultado)
      const st = (await status.json()) as { hayTest: boolean }
      setHayTest(st.hayTest)
    } catch {
      setError('No pudimos leer tu perfil')
    } finally {
      setCargando(false)
    }
  }, [])

  useEffect(() => {
    void cargar()
  }, [cargar])

  if (cargando) return <main><p className="lede">Cargando tu perfil...</p></main>
  if (error) return <main><h1>Perfil</h1><p className="msg error">{error}</p></main>

  return (
    <main className="plan-detail">
      <h1>Tu personalidad</h1>

      {!resultado ? (
        <>
          <p className="note">
            Todavia no completaste el test. Son ocho preguntas y podes saltearlo
            cuando quieras: no es obligatorio para usar Nexa.
          </p>
          {hayTest && (
            <p className="row" style={{ marginTop: '0.85rem' }}>
              <Link className="plan-go" href="/personalidad">Hacer el test</Link>
            </p>
          )}
        </>
      ) : (
        <>
          <p className="note">
            {resultado.testNombre}, completado el {resultado.completadoEn.slice(0, 10)}.
            Esto no te califica para nada: no hay matching todavia, asi que estos
            rasgos todavia no cambian que planes te aparecen.
          </p>

          <dl className="rasgos">
            {resultado.rasgos.map((r) => (
              <div key={r.key} className="rasgo">
                <dt>{r.label}</dt>
                <dd>
                  <span className={`nivel nivel-${r.nivel}`}>{NIVELES[r.nivel] ?? r.nivel}</span>
                  {r.description && <small className="note"> {r.description}</small>}
                </dd>
              </div>
            ))}
          </dl>
        </>
      )}
    </main>
  )
}
