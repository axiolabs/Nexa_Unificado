'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'

/**
 * El test de personalidad, pantalla completa.
 *
 * Decisiones de la pantalla, y por que:
 *
 * - **Una pregunta a la vez.** Con ocho en la pantalla el formulario se ve como un
 *   examen y la gente se bloquea. Ademas, el envio es todo o nada: si mandan dos
 *   y contestaron cinco, el POST devuelve 400 y no se guarda nada. Ir de a una
 *   elimina esa clase de error entera.
 *
 * - **Se puede salir en cualquier momento.** Hay un enlace al mapa arriba y abajo.
 *   La pantalla nunca atrapa: si se contesta la tercera y te arrepentiste, cerrar la
 *   pestaña tiene que ser igual de valido que seguir.
 *
 * - **El boton de enviar se habilita recien al final.** Antes, cada respuesta parcial
 *   parecia un error. Ademas el servidor exige el set completo igual: la UI lo
 *   anticipa, no lo reemplaza.
 *
 * - **El 409 de version recarga.** Si se publico una v2 mientras contestaba, el
 *   cliente reinicia el test con la nueva en vez de mostrar un error que la persona
 *   no puede arreglar.
 */

type Opcion = { id: string; label: string; order: number }
type Pregunta = { id: string; prompt: string; trait: { key: string; label: string }; options: Opcion[] }
type Test = { id: string; version: number; name: string; questions: Pregunta[] }

export function PersonalityTestClient() {
  const router = useRouter()
  const [test, setTest] = useState<Test | null>(null)
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [indice, setIndice] = useState(0)
  const [elegidas, setElegidas] = useState<Record<string, string>>({})
  const [enviando, setEnviando] = useState(false)
  const [yaHecho, setYaHecho] = useState<{ completadoEn: string } | null>(null)

  const cargar = useCallback(async () => {
    try {
      const res = await fetch('/api/personality/test', { cache: 'no-store' })
      if (res.status === 401) {
        setError('Necesitas iniciar sesion')
        return
      }
      if (res.status === 404) {
        setError('No hay ningun test disponible ahora mismo')
        return
      }
      if (!res.ok) {
        setError('No pudimos cargar el test')
        return
      }
      const data = (await res.json()) as { test: Test; resultado: { completadoEn: string } | null }
      setTest(data.test)
      if (data.resultado) setYaHecho(data.resultado)
    } catch {
      setError('No pudimos cargar el test')
    } finally {
      setCargando(false)
    }
  }, [])

  useEffect(() => {
    void cargar()
  }, [cargar])

  async function enviar() {
    if (!test) return
    setEnviando(true)
    setError(null)
    try {
      const answers = test.questions.map((q) => ({
        questionId: q.id,
        optionId: elegidas[q.id] ?? '',
      }))
      const res = await fetch('/api/personality/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ testId: test.id, answers }),
      })
      const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string }

      if (res.status === 409 && data.code === 'test_desactualizado') {
        // No es un error que la persona pueda entender ni arreglar: se recarga
        // el test y se arranca de nuevo con la version que esta vigente.
        setElegidas({})
        setIndice(0)
        await cargar()
        setCargando(true)
        return
      }
      if (!res.ok) {
        setError(data.error ?? 'No pudimos guardar el resultado')
        return
      }
      router.push('/perfil')
    } catch {
      setError('No pudimos guardar el resultado')
    } finally {
      setEnviando(false)
    }
  }

  if (cargando) return <main><p className="lede">Cargando el test...</p></main>

  if (error && !test) {
    return (
      <main>
        <h1>Test de personalidad</h1>
        <p className="msg error">{error}</p>
        <p className="row" style={{ marginTop: '0.85rem' }}>
          <Link className="plan-go" href="/explore">Volver al mapa</Link>
        </p>
      </main>
    )
  }

  if (yaHecho) {
    return (
      <main>
        <h1>Test de personalidad</h1>
        <p className="note">
          Ya lo completaste el {yaHecho.completadoEn.slice(0, 10)}. Podes ver tus
          rasgos en el perfil.
        </p>
        <p className="row" style={{ marginTop: '0.85rem' }}>
          <Link className="plan-go" href="/perfil">Ver mis rasgos</Link>
        </p>
      </main>
    )
  }

  if (!test) return <main><p className="lede">Cargando el test...</p></main>

  const pregunta = test.questions[indice]
  const elegida = elegidaDe(elegidas, pregunta?.id)
  const ultima = indice === test.questions.length - 1
  const contestadas = Object.keys(elegidas).length

  return (
    <main className="plan-detail">
      <p className="row" style={{ justifyContent: 'space-between' }}>
        <span className="note">
          Pregunta {indice + 1} de {test.questions.length}
        </span>
        <Link className="plan-go" href="/explore">Salir</Link>
      </p>

      {pregunta && (
        <fieldset className="test-pregunta">
          <legend>{pregunta.prompt}</legend>
          {pregunta.options.map((o) => (
            <label key={o.id} className={`opcion${elegida === o.id ? ' elegida' : ''}`}>
              <input
                type="radio"
                name={pregunta.id}
                value={o.id}
                checked={elegida === o.id}
                onChange={() => setElegidas((prev) => ({ ...prev, [pregunta.id]: o.id }))}
              />
              {o.label}
            </label>
          ))}
        </fieldset>
      )}

      {error && <p className="msg error">{error}</p>}

      <div className="row" style={{ marginTop: '1.25rem' }}>
        <button className="secondary" disabled={indice === 0 || enviando} onClick={() => setIndice(indice - 1)}>
          Anterior
        </button>
        {!ultima ? (
          <button disabled={!elegida} onClick={() => setIndice(indice + 1)}>
            Siguiente
          </button>
        ) : (
          <button disabled={!elegida || enviando || contestadas < test.questions.length} onClick={enviar}>
            {enviando ? 'Guardando...' : 'Ver mi resultado'}
          </button>
        )}
      </div>

      <p className="note" style={{ marginTop: '1.5rem' }}>
        Podes dejarlo para otro momento. No hace falta completarlo para usar Nexa.
      </p>
    </main>
  )
}

function elegidaDe(elegidas: Record<string, string>, questionId: string | undefined): string | undefined {
  return questionId ? elegidas[questionId] : undefined
}
