'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  CHAT_POLL_MS,
  MESSAGE_BODY_MAX,
  agregarMensajes,
  avanzarCursor,
  type ChatPoll,
  type Mensaje,
} from '@/lib/chat'

/**
 * El chat del plan.
 *
 * Vive en su propio archivo y no dentro de `plan-detail-client.tsx` porque tiene
 * ciclo de vida propio: arranca un `setInterval`, escucha `visibilitychange` y
 * se limpia al desmontar. Mezclado con el resto del detalle, ese `clearInterval`
 * queda colgado de un `useEffect` que ya no se lee.
 *
 * El padre solo lo monta cuando el viewer esta `ACCEPTED`, que es exactamente
 * la condicion del gate del endpoint. No es una decision de UI: pintar el chat
 * a un `REQUESTED` significaria ofrecer una caja de texto que responde 403.
 *
 * Sin escritura optimista, a proposito: se manda, se espera la respuesta y se
 * agrega el mensaje que devuelve el servidor. Un mensaje optimista necesita un id
 * de cliente y reconciliarlo con el id real, y el peor error posible de esa
 * maquina es que el mensaje parezca enviado y no exista. Con el boton en estado
 * "Enviando" la espera se ve, que es la parte que importa.
 */

/** La respuesta del GET, distinguida de un error de red. */
type Lectura =
  | { tipo: 'ok'; poll: ChatPoll }
  | { tipo: 'cerrado'; motivo: 'estado' | 'sesion' }
  | { tipo: 'fallo'; texto: string }

export function ChatClient({ planId }: { planId: string }) {
  const [mensajes, setMensajes] = useState<Mensaje[]>([])
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [cerradoPor, setCerradoPor] = useState<'estado' | 'sesion' | null>(null)
  const [borrador, setBorrador] = useState('')
  const [enviando, setEnviando] = useState(false)
  const [errorEnvio, setErrorEnvio] = useState<string | null>(null)

  /**
   * El cursor va en un ref y no en estado: no se dibuja en ningun lado, y
   * ponerlo en estado obligaria a meterlo en las dependencias del `useEffect`
   * del poll. Cada cambio de cursor reiniciaria el intervalo, o sea que el
   * chat perderia el ritmo justo despues de cada mensaje nuevo.
   */
  const cursorRef = useRef<string | null>(null)
  /** Si el componente sigue montado, para no setear estado despues de morir. */
  const vivoRef = useRef(true)
  /** El id del `setInterval`, para poder cancelarlo cuando el chat se cierra. */
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const listaRef = useRef<HTMLDivElement | null>(null)
  /**
   * Si el usuario esta pegado al final. Solo se auto-desplaza en ese caso: tirar
   * la pantalla al ultimo mensaje mientras alguien esta leyendo mas arriba borra
   * de la vista justo lo que estaba por leer.
   */
  const pegadoRef = useRef(true)
  /**
   * Si hay un poll en vuelo. Sin esto, una respuesta que tarde mas que
   * `CHAT_POLL_MS` hace que dos peticiones lean el mismo rango y la segunda
   * vuelva a pintar lo que la primera ya habia agregado.
   */
  const pollOcupadoRef = useRef(false)

  const pararPoll = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
  }, [])

  /**
   * Una pagina del chat.
   *
   * Devuelve el resultado en vez de setear estado, para que la carga inicial
   * pueda encadenar paginas sin pasar por un render por pagina.
   */
  const leerPagina = useCallback(async (despuesDe: string | null): Promise<Lectura> => {
    const url = `/api/plans/${planId}/messages${despuesDe ? `?after=${despuesDe}` : ''}`
    try {
      const res = await fetch(url, { cache: 'no-store' })
      if (res.status === 401) return { tipo: 'cerrado', motivo: 'sesion' }
      // 403 y 404 son los dos finales del chat: se acepto, se completo, o el
      // plan dejo de ser visible. No son un error que se pueda reintentar, asi
      // que se distinguen de un 500 para dejar de preguntar.
      if (res.status === 403 || res.status === 404) return { tipo: 'cerrado', motivo: 'estado' }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        return { tipo: 'fallo', texto: body.error ?? `HTTP ${res.status}` }
      }
      return { tipo: 'ok', poll: (await res.json()) as ChatPoll }
    } catch {
      return { tipo: 'fallo', texto: 'No se pudo conectar con el chat.' }
    }
  }, [planId])

  /**
   * Un poll: lo que hay despues del cursor, y nada mas.
   *
   * El `nextCursor` se mueve SOLO si la respuesta vino con cursor. Un poll
   * vacio devuelve `nextCursor: null` porque no hay ultimo mensaje del que
   * sacarlo, y escribir ese `null` en el ref reiniciaria la lectura desde el
   * principio: cada mensaje nuevo seria reenviado y el chat se duplicaria
   * entero. Es el error mas caro de esta pantalla y por eso va comentado.
   */
  const poll = useCallback(async () => {
    if (!vivoRef.current) return
    // Pestana en segundo plano: no se pregunta. El `interval` sigue corriendo
    // porque no hay forma barata de saber si la pestana se activo sin
    // escucharla, y el chequeo es una linea.
    if (typeof document !== 'undefined' && document.hidden) return
    // No se solapan polls: si la respuesta tarda mas que el intervalo, dos
    // peticiones leen el mismo rango y la segunda duplica lo que trajo la
    // primera en la pantalla.
    if (pollOcupadoRef.current) return
    pollOcupadoRef.current = true
    try {
      const r = await leerPagina(cursorRef.current)
      if (!vivoRef.current) return
      if (r.tipo === 'cerrado') {
      setCerradoPor(r.motivo)
      pararPoll()
      return
    }
      if (r.tipo === 'fallo') {
        // Un poll fallido NO se come el cursor: se reintenta el mismo rango en
        // la proxima vuelta.
        setError(r.texto)
        return
      }
      setError(null)
      if (r.poll.messages.length > 0) {
        setMensajes((previos) => agregarMensajes(previos, r.poll.messages))
      }
      cursorRef.current = avanzarCursor(cursorRef.current, r.poll.nextCursor)
    } finally {
      pollOcupadoRef.current = false
    }
  }, [leerPagina, pararPoll])

  /**
   * La carga inicial: se leen todas las paginas hasta que no haya mas.
   *
   * El endpoint devuelve de los mas viejos a los mas nuevos, asi que una sola
   * llamada trae el COMIENZO de la conversacion, no el final. Si se pidiera solo
   * una pagina, un plan con 250 mensajes abriria mostrando los 100 mas viejos
   * y el usuario tendria que scrollear hasta abajo para ver lo recien escrito.
   */
  const cargaInicial = useCallback(async () => {
    setCargando(true)
    let cursor: string | null = null
    let leidos: Mensaje[] = []
    try {
      // El tope de 50 es una red de seguridad, no una logica: si el servidor
      // dijera `hasMore` para siempre, se detiene en vez de dejar la pantalla
      // cargando para siempre.
      for (let pagina = 0; pagina < 50; pagina++) {
        const r = await leerPagina(cursor)
        if (!vivoRef.current) return
        if (r.tipo === 'cerrado') {
          setCerradoPor(r.motivo)
          return
        }
        if (r.tipo === 'fallo') {
          setError(r.texto)
          return
        }
        leidos = agregarMensajes(leidos, r.poll.messages)
        // `hasMore` es la senal de seguir. `nextCursor` sin `hasMore` quiere
        // decir que ya se leyo todo, y es el cursor que queda para el poll.
        if (!r.poll.hasMore || !r.poll.nextCursor) {
          cursorRef.current = avanzarCursor(cursorRef.current, r.poll.nextCursor)
          break
        }
        cursor = r.poll.nextCursor
      }
      setMensajes(leidos)
    } finally {
      if (vivoRef.current) setCargando(false)
    }
  }, [leerPagina])

  useEffect(() => {
    vivoRef.current = true
    void cargaInicial().then(() => {
      if (!vivoRef.current) return
      timerRef.current = setInterval(() => void poll(), CHAT_POLL_MS)
    })

    /**
     * Al volver a la pestana se pregunta en el acto, en vez de esperar el
     * intervalo. Volver a mirar un chat y ver que lo que se escribio hace un
     * minuto sigue sin estar es la sensacion de que el chat esta roto.
     */
    const alCambiarVisibilidad = () => {
      if (!document.hidden) void poll()
    }
    document.addEventListener('visibilitychange', alCambiarVisibilidad)

    return () => {
      vivoRef.current = false
      pararPoll()
      document.removeEventListener('visibilitychange', alCambiarVisibilidad)
    }
  }, [cargaInicial, poll, pararPoll])

  /** Solo baja si el usuario ya estaba abajo. */
  useEffect(() => {
    if (cargando) return
    if (!pegadoRef.current) return
    listaRef.current?.scrollTo({ top: listaRef.current.scrollHeight })
  }, [mensajes, cargando])

  const enviar = useCallback(async () => {
    const body = borrador.trim()
    if (body.length === 0 || enviando || cerradoPor) return
    setEnviando(true)
    setErrorEnvio(null)
    try {
      const res = await fetch(`/api/plans/${planId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body }),
      })
      if (res.status === 401) {
        setCerradoPor('sesion')
        setBorrador('')
        return
      }
      if (res.status === 403 || res.status === 404) {
        setCerradoPor('estado')
        setBorrador('')
        return
      }
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}))
        setErrorEnvio(payload.error ?? `HTTP ${res.status}`)
        // El texto NO se borra: si reboto por el limite de caracteres, perder
        // lo que se habia escrito es la peor forma de avisar.
        return
      }
      const payload = (await res.json()) as { message: Mensaje }
      setMensajes((previos) => agregarMensajes(previos, [payload.message]))
      setBorrador('')
      // El cursor NO se mueve: no se sabe codificar un cursor en el cliente
      // (ver `lib/chat.ts`), y el proximo poll va a traer este mismo mensaje.
      // `agregarMensajes` lo descarta por id, que para eso esta el `Set`.
      pegadoRef.current = true
    } catch {
      setErrorEnvio('No se pudo enviar el mensaje. Revisa la conexion.')
    } finally {
      if (vivoRef.current) setEnviando(false)
    }
  }, [planId, borrador, enviando, cerradoPor])

  if (cerradoPor) {
    return (
      <section className="chat" aria-label="Chat del plan">
        <h2>Chat</h2>
        {/*
         * Los dos cierres se cuentan distinto. Decirle "solo queda para quienes
         * confirmaron su lugar" a alguien a quien se le vencio la sesion lo
         * manda a revisar un plan que esta perfecto, o sea que el aviso
         * describe un problema que no tiene.
         */}
        <p className="note">
          {cerradoPor === 'sesion'
            ? 'Tu sesion termino. Volve a entrar para seguir escribiendo.'
            : 'El chat no esta disponible. Solo queda para quienes confirmaron su lugar.'}
        </p>
      </section>
    )
  }

  const restantes = MESSAGE_BODY_MAX - borrador.length

  return (
    <section className="chat" aria-label="Chat del plan">
      <h2>Chat</h2>

      {/*
       * `role="log"` con `aria-live` es lo que hace que un lector de pantalla
       * anuncie los mensajes nuevos. Sin eso, el polling actualiza la pantalla
       * en silencio y un usuario de lector de pantalla no se entera de que le
       * respondieron.
       */}
      <div
        className="chat-lista"
        ref={listaRef}
        role="log"
        aria-live="polite"
        aria-label="Mensajes"
        tabIndex={0}
        onScroll={(e) => {
          const el = e.currentTarget
          pegadoRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        }}
      >
        {cargando ? (
          <p className="note">Cargando mensajes...</p>
        ) : mensajes.length === 0 ? (
          /*
           * "Todavia no hay mensajes. Presenta vos." solo es verdad si el plan
           * esta vacio. Cuando la carga fallo, `mensajes` quedo en cero y sin
           * este caso el usuario leeria que le toca escribir el primer mensaje de
           * un plan que puede tener miles: el error de abajo explica lo que paso,
           * y alcanza con no contradecirlo.
           */
          error ? null : <p className="note">Todavia no hay mensajes. Presenta vos.</p>
        ) : (
          mensajes.map((m) => (
            <article key={m.id} className={`chat-msj ${m.mine ? 'chat-msj-mio' : 'chat-msj-otro'}`}>
              {!m.mine && <span className="chat-autor">{m.authorName}</span>}
          {/*
           * El borrado logico se decide ACA y no en la API. El endpoint
           * sigue mandando el cuerpo porque el moderador puede necesitarlo,
           * asi que si el cliente lo imprimiera, "borrado" seria una palabra
           * y el texto seguiria en pantalla.
           */}
              <p className="chat-cuerpo">{m.deletedAt ? <em>Mensaje eliminado</em> : m.body}</p>
              <time className="chat-hora" dateTime={m.createdAt}>
                {new Date(m.createdAt).toLocaleTimeString('es-AR', {
                  hour: '2-digit',
                  minute: '2-digit',
                  hour12: false,
                })}
              </time>
            </article>
          ))
        )}
      </div>

      {error ? <p className="msg error">{error}</p> : null}

      <form
        className="chat-form"
        onSubmit={(e) => {
          e.preventDefault()
          void enviar()
        }}
      >
        <label className="chat-label" htmlFor="chat-borrador">
          Escribi un mensaje
        </label>
        <textarea
          id="chat-borrador"
          value={borrador}
          onChange={(e) => setBorrador(e.target.value)}
          maxLength={MESSAGE_BODY_MAX}
          rows={2}
          placeholder="Escribi algo para el plan."
        />
        {/*
         * El contador va antes del boton, y no es decorativo: avisa del limite
         * antes de que el POST vuelva con un 400. `maxLength` evita pasarse
         * escribiendo, pero el `maxLength` del navegador recorta en silencio al
         * pegar un texto largo, asi que el contador es la parte que explica por
         * que no entra todo.
         */}
        <p className={`chat-cuenta ${restantes === 0 ? 'msg error' : 'note'}`} aria-live="polite">
          {restantes} caracteres restantes
        </p>
        {errorEnvio ? (
          <p className="msg error" role="alert">
            {errorEnvio}
          </p>
        ) : null}
        <button type="submit" disabled={enviando || borrador.trim().length === 0}>
          {enviando ? 'Enviando...' : 'Enviar'}
        </button>
      </form>
    </section>
  )
}
