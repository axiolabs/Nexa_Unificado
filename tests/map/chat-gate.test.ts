import { describe, expect, it } from 'vitest'
import { ParticipationStatus } from '@prisma/client'
import { CHAT_ABIERTOS_A, puedeUsarChat } from '../../lib/chat'

/**
 * El gate del chat, como funcion pura.
 *
 * Vive en `lib/chat.ts` y no en el route ni en el `.tsx` por una razon concreta:
 * **es la misma regla en los dos lados**, y la usan
 *
 *   - el `GET`/`POST /api/plans/[planId]/messages` (decide si se puede), y
 *   - el detalle del plan (decide si se monta el `ChatClient`).
 *
 * Con la condicion escrita dos veces, un estado nuevo entra por un lado y no por
 * el otro, y aparece la combinacion que no tiene que existir: ver la caja de
 * texto y que el POST responda 403. Estos tests son los que hacen que eso sea un
 * error visible.
 *
 * La parte de `ATTENDED`/`NO_SHOW` importa mas de lo que parece: la tentacion
 * de "cerrar el chat cuando el plan termina" es fuerte y razonable, asi que si
 * no esta fijada por un test, vuelve. Volver no es un bug de codigo: es una
 * decision de producto tomada por ausencia de decision.
 */

describe('el gate del chat por status de participacion', () => {
  it('ACCEPTED entra: es el caso normal del plan en curso', () => {
    expect(puedeUsarChat('ACCEPTED')).toBe(true)
  })

  it.each(['ATTENDED', 'NO_SHOW'] as const)('%s entra: el plan termino pero el canal no', (status) => {
    expect(puedeUsarChat(status)).toBe(true)
  })

  it.each(['REQUESTED', 'DECLINED', 'CANCELLED'] as const)('%s no entra: no es parte del plan', (status) => {
    expect(puedeUsarChat(status)).toBe(false)
  })

  it('sin participacion no entra, y no crashea', () => {
    // El detalle del plan llama al gate con `viewer.participation?.status ?? null`,
    // o sea que `null` es el caso de un visitante que todavia no esta en el plan.
    // Si el gate no contemplara el vacio, el detalle entero no renderiza para
    // el caso mas comun que tiene la pagina.
    expect(puedeUsarChat(null)).toBe(false)
    expect(puedeUsarChat(undefined)).toBe(false)
  })

  it('la constante cubre la mitad del enum, y son los tres del medio', () => {
    // El enum tiene seis estados: tres entran, tres no. Si alguien agrega uno,
    // esta cuenta falla y hay que decidir en que lado va, en vez de que caiga
    // en el `false` de `includes` sin que nadie lo note.
    expect(CHAT_ABIERTOS_A).toHaveLength(3)
    expect(CHAT_ABIERTOS_A).toEqual(expect.arrayContaining(['ACCEPTED', 'ATTENDED', 'NO_SHOW']))
    expect(Object.values(ParticipationStatus).filter((s) => puedeUsarChat(s))).toHaveLength(3)
  })

  it('ningun estado entra por el `else`: la lista es explicita', () => {
    // Si alguien "optimiza" `puedeUsarChat` a `status !== 'REQUESTED'`, este
    // test lo mata: `DECLINED` y `CANCELLED` volverian a tener chat, que es el
    // error que la FK no evita (§8.1 de `docs/modelo-datos.md`).
    const permitidos = new Set<ParticipationStatus>(CHAT_ABIERTOS_A)
    for (const s of Object.values(ParticipationStatus)) {
      expect(puedeUsarChat(s)).toBe(permitidos.has(s))
    }
  })
})
