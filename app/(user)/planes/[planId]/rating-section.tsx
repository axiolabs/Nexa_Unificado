'use client'

import { useState } from 'react'
import {
  ETIQUETAS_EXPERIENCIA,
  ESCALA_RATING,
  RATING_TAGS_MAX,
  etiquetaDe,
  puedeCalificar,
  textoDelPromedioConCuenta,
} from '@/lib/ratings'
import type { PlanDetail } from '@/lib/plans'

/**
 * Calificar la EXPERIENCIA del plan.
 *
 * Solo con el plan terminado, y el formulario solo para quien estuvo
 * (`ATTENDED`). Las dos condiciones salen de las MISMAS funciones que usa el
 * endpoint: `puedeCalificar` y `planCerrable`. Un `=== 'ATTENDED' &&
 * Date.now() > endsAt` escrito aca seria una tercera copia de la regla, y la
 * combinacion que no tiene que existir — formulario visible con POST en 403 — no
 * la atrapa nadie.
 *
 * La primera version montaba el formulario para todo el mundo y ponia el
 * "no podes calificar" como una seccion aparte al lado. La pasada manual lo
 * agarro: un `NO_SHOW` veia las cinco estrellas y un boton que responde 403. Por
 * eso el gate esta ADENTRO del componente y no en el padre.
 *
 * Lo que si ve todo el mundo es el **promedio**, que es anonimo: es la senal de
 * si el lugar valio la pena sin decir quien opto por que.
 *
 * **Editar no es otro formulario.** Es el mismo, precargado con lo que ya
 * pusiste, y el boton dice "Actualizar" en vez de "Enviar". La diferencia no es
 * cosmetica: el endpoint hace upsert, y el que tuvo la idea correcta de corregir
 * tiene que ver que corregir es lo que esta haciendo.
 *
 * El mensaje de exito sale del `creado` que contesta el POST, y no de si el
 * formulario ya venia precargado. La recarga en silencio llega **antes** del
 * `setListo`, asi que para el segundo toque de una persona ya hay voto en
 * `plan.ratings.mine` y el componente dira "actualizada" tambien en la primera
 * vez. El unico que sabe si creo o corrigio es el server.
 *
 * **No hay textarea.** Hubo uno, con 500 caracteres, y seelimino: un texto libre
 * con el nombre del autor al lado permite escribir el juicio sobre una persona
 * que `Rating` no lleva `ratedUserId` justamente para impedir, y sin moderacion
 * no hay forma de sacarlo de circulacion. Ahora "decir algo" es elegir hasta
 * `RATING_TAGS_MAX` etiquetas de un set cerrado, y el set esta en `lib/ratings.ts`
 * para que el endpoint y esta pantalla no puedan separarse. Ver §16.10.
 */

type Props = {
  plan: PlanDetail
  alCalificar: (rating: number, tags: string[]) => Promise<{ creado: boolean }>
}

export function RatingSection({ plan, alCalificar }: Props) {
  const mio = plan.ratings.mine
  const [rating, setRating] = useState<number | null>(mio?.rating ?? null)
  const [tags, setTags] = useState<string[]>(mio?.tags ?? [])
  const [enviando, setEnviando] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [listo, setListo] = useState<'creado' | 'actualizado' | null>(null)

  // La misma funcion que el endpoint, no una copia: es la parte de participacion
  // del gate. El padre ya filtro el plan terminado, asi que aca solo queda esta.
  const puede = puedeCalificar(plan.viewer.participation)
  const estaEnElPlan = plan.viewer.participation !== null

  /** Marca o desmarca. Al llegar al tope, las que quedan se apagan. */
  function alternar(id: string) {
    setTags((previas) =>
      previas.includes(id)
        ? previas.filter((t) => t !== id)
        : previas.length >= RATING_TAGS_MAX
          ? previas
          : [...previas, id],
    )
  }

  async function enviar() {
    if (rating === null) {
      // No hay nada que mandar todavia. El boton esta deshabilitado, asi que esto
      // es un click en una estrella cuando todavia no se eligio ninguna y el
      // estado se perdio.
      setError('Elegi cuantas estrellas.')
      return
    }
    setEnviando(true)
    setError(null)
    setListo(null)
    try {
      const r = await alCalificar(rating, tags)
      setListo(r.creado ? 'creado' : 'actualizado')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo enviar la calificacion')
    } finally {
      setEnviando(false)
    }
  }

  /*
   * La lista con nombre y etiquetas es del organizador, y se decide por
   * `ratings.detail !== null` en vez de por `viewer.isCreator`: el endpoint ya
   * filtro eso y es el unico que sabe. Si se usara `isCreator` y el endpoint
   * dejara de mandarlo, la lista apareceria vacia y nadie sabria por que; con
   * esta forma, el `null` es la señal de que no se publica y el componente no
   * tiene que saber quien es.
   */
  const detalle = plan.ratings.detail

  return (
    <section className="plan-closing" aria-label="Calificar el plan">
      <h2>Calificar el plan</h2>

      {/*
       * El promedio se muestra siempre, incluso sin votos, y por eso el texto
       * sale de `textoDelPromedioConCuenta`: el caso "todavia no califico nadie"
       * tiene que decir lo mismo que deduciria el endpoint, y no es "0 estrellas".
       */}
      <p className="note">
        {textoDelPromedioConCuenta(plan.ratings.average, plan.ratings.count)}
      </p>

      {/*
       * El conteo de etiquetas es agregado y va para todos, igual que el
       * promedio. Nadie sabe quien marco que: "el 80% dice buena comida" le
       * sirve al siguiente que va sin exponer a nadie. Las etiquetas que marco la
       * persona que mira salen abajo, con su nombre, en `detail`.
       */}
      {plan.ratings.tags.length > 0 && (
        <ul className="rating-tags-resumen" aria-label="Lo que mas se marco">
          {plan.ratings.tags.map((t) => (
            <li key={t.id} className="chip">
              {etiquetaDe(t.id)}
              <span className="note"> {t.count}</span>
            </li>
          ))}
        </ul>
      )}

      {/*
       * El formulario y el motivo por el que no esta, en el mismo lugar y con la
       * misma condicion. La primera version de esto era al reves — el formulario
       * siempre, y el motivo en otra seccion al lado — y la pasada manual mostro
       * que un `NO_SHOW` tenia las cinco estrellas y un boton que respondia 403.
       */}
      {puede ? (
        <>
          <div className="rating-stars" role="group" aria-label="Cantidad de estrellas">
            {ESCALA_RATING.map((n) => (
              <button
                key={n}
                className={rating !== null && n <= rating ? 'star on' : 'star'}
                aria-pressed={rating === n}
                aria-label={`${n} ${n === 1 ? 'estrella' : 'estrellas'}`}
                disabled={enviando}
                onClick={() => setRating(n)}
              >
                {'*'}
              </button>
            ))}
          </div>

          {/*
           * Las etiquetas son botones, no checkboxes: el set es chico y el estado
           * vive en el `aria-pressed`. Al llegar al tope, las que no estan
           * marcadas se apagan en vez de desaparecer, para que se vea que
           * existen y que el limite esta ahi en vez de aparecer magico.
           */}
          <div className="rating-tags" role="group" aria-label="Etiquetas de la experiencia">
            {ETIQUETAS_EXPERIENCIA.map((e) => {
              const marcada = tags.includes(e.id)
              const bloqueada = !marcada && tags.length >= RATING_TAGS_MAX
              return (
                <button
                  key={e.id}
                  className={marcada ? 'chip on' : 'chip'}
                  aria-pressed={marcada}
                  disabled={enviando || bloqueada}
                  onClick={() => alternar(e.id)}
                >
                  {e.label}
                </button>
              )
            })}
          </div>
          <p className="note">
            {tags.length >= RATING_TAGS_MAX
              ? `Elegiste ${RATING_TAGS_MAX}. Desmarcá una para cambiar.`
              : 'Opcional: hasta 3, y son sobre el lugar.'}
          </p>

          <button onClick={() => void enviar()} disabled={enviando}>
            {enviando ? 'Enviando...' : mio ? 'Actualizar' : 'Enviar'}
          </button>

          {listo && (
            <p className="msg ok" role="status">
              {listo === 'creado' ? 'Gracias por calificar.' : 'Calificacion actualizada.'}
            </p>
          )}
          {error && (
            <p className="msg error" role="alert">
              {error}
            </p>
          )}
        </>
      ) : (
        estaEnElPlan && (
          <p className="note">
            {plan.viewer.participation?.status === 'NO_SHOW'
              ? 'No podes calificar un plan al que no fuiste.'
              : 'Calificas despues de que el organizador marque la asistencia.'}
          </p>
        )
      )}

      {detalle !== null && (
        <div className="rating-detalle">
          <h3>Lo que dijo la gente</h3>
          {detalle.length === 0 ? (
            <p className="note">Todavia no califico nadie.</p>
          ) : (
            <ul className="place-list">
              {detalle.map((r) => (
                <li key={r.user.id}>
                  <div className="place-card">
                    <strong>{r.user.name}</strong>
                    <span className="plan-meta">
                      {'*'.repeat(r.rating)}
                      <span className="visually-hidden">
                        {` de ${ESCALA_RATING.length}, ${r.rating} ${r.rating === 1 ? 'estrella' : 'estrellas'}`}
                      </span>
                    </span>
                    {r.tags.length > 0 && (
                      <ul className="rating-tags-voto" aria-label="Etiquetas que marco">
                        {r.tags.map((t) => (
                          <li key={t} className="chip">
                            {etiquetaDe(t)}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}
