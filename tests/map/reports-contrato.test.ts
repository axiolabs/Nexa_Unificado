import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, rawQuery, resetDb } from '../helpers/db'

/**
 * Que lo que Prisma no sabe que existe, siga existiendo.
 *
 * Los CHECK y los indices parciales de `ModerationReport` estan en SQL a mano,
 * dentro de la migracion, y `schema.prisma` no los menciona. Prisma compara su
 * modelo contra el catalogo de Postgres, no contra lo que el proyecto quiere, asi
 * que un `prisma migrate dev` de rutina los ve como objetos de mas y genera una
 * migracion que los borra. La migracion es valida, corre, y el contrato se
 * pierde:
 *
 *   - Sin `ModerationReport_exactamente_un_objetivo` se puede guardar un reporte
 *     sin destino, y la cola no sabe ni que mostrar.
 *   - Sin `ModerationReport_target_coincide` se puede guardar `target = PLACE`
 *     con `planId` informado: una fila que se lee bien y se muestra mal.
 *   - Sin los cuatro indices parciales UNIQUE, denunciar dos veces lo mismo crea
 *     filas repetidas en vez de devolver 409. Y el `@@unique` de Prisma no puede
 *     reemplazarlos, porque en Postgres dos NULL son distintos entre si: el
 *     UNIQUE de Prisma no unica.
 *
 * Este archivo no prueba que las reglas sirvan para algo (eso lo prueba
 * `reports-borrado.test.ts`); prueba que estan AHORA. Un CHECK que nadie mira no
 * avisa cuando lo borran: desaparece en silencio y el siguiente bug se declara
 * como "la base no lo impedia", que es la frase que siempre sale cuando el
 * problema es otro.
 *
 * Si este test falla, la respuesta NO es comentar el assert: es la migracion que se
 * llevo los objetos. Prisma no tiene forma de expresarlos, asi que hay que
 * reponerlos a mano y volver a correrla.
 */

describe('contrato de la base que Prisma no expresa', () => {
  beforeEach(resetDb)
  afterAll(closeDb)

  it('los dos CHECK de reportes estan, con la regla que se documentscribieron', async () => {
    const filas = await rawQuery<{ conname: string; pg_get_constraintdef: string }>(
      `SELECT conname, pg_get_constraintdef(oid) AS pg_get_constraintdef
         FROM pg_constraint
        WHERE conrelid = '"ModerationReport"'::regclass
          AND contype = 'c'
        ORDER BY conname`,
    )
    const porNombre = new Map(filas.map((f) => [f.conname, f.pg_get_constraintdef]))

    const exactamente = porNombre.get('ModerationReport_exactamente_un_objetivo')
    expect(exactamente, 'falta el CHECK de exactamente un objetivo').toBeTruthy()
    // Se asserta la REGLA, no solo el nombre. Un CHECK que sobrevive con otra
    // formula esta en verde contra un `toBeTruthy` y no cumple lo que dice su
    // nombre.
    expect(exactamente).toMatch(/num_nonnulls/i)
    expect(exactamente).toMatch(/= 1/)

    const coincide = porNombre.get('ModerationReport_target_coincide')
    expect(coincide, 'falta el CHECK de target vs FK').toBeTruthy()
    for (const target of ['PLACE', 'PLAN', 'USER', 'MESSAGE']) {
      expect(coincide, `el CHECK no contempla ${target}`).toContain(`'${target}'`)
    }
  })

  it('los cuatro indices parciales de "una vez por objetivo" estan', async () => {
    // Con `WHERE target = ...`, no con una lista de columnas: el indice parcial
    // es lo que achica el indice y lo que hace que la columna nula de los otros
    // tipos no colisione. Un indice UNIQUE completo seria correcto en teoria y
    // no frenaria nada en la practica.
    const filas = await rawQuery<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE tablename = 'ModerationReport' AND indexname LIKE 'ModerationReport_una_vez_%'
        ORDER BY indexname`,
    )

    const esperados = {
      ModerationReport_una_vez_place: 'placeId',
      ModerationReport_una_vez_plan: 'planId',
      ModerationReport_una_vez_user: 'userId',
      ModerationReport_una_vez_message: 'messageId',
    }

    expect(
      filas.map((f) => f.indexname),
      'faltan indices de unicidad por objetivo',
    ).toEqual(Object.keys(esperados).sort())

    for (const f of filas) {
      const columna = esperados[f.indexname as keyof typeof esperados]
      const target = f.indexname.replace('ModerationReport_una_vez_', '').toUpperCase()

      expect(f.indexdef, `${f.indexname} no es UNIQUE`).toMatch(/CREATE UNIQUE INDEX/i)
      expect(f.indexdef, `${f.indexname} no incluye la columna del objetivo`).toContain(`"${columna}"`)
      expect(f.indexdef, `${f.indexname} no incluye al denunciante`).toContain('"reporterId"')
      expect(f.indexdef, `${f.indexname} no es parcial por target`).toMatch(
        new RegExp(`WHERE[^)]*'${target}'`, 'i'),
      )
    }
  })

  it('el indice de la cola sigue siendo parcial a los abiertos y ordenado al reves', async () => {
    // El `DESC` y el `WHERE status = 'OPEN'` son lo que hacen que la consulta de
    // la cola no ordene en memoria. Sin este indice la cola funciona igual, solo
    // que mas lento, y "mas lento" no se nota hasta que hay Enough data.
    const filas = await rawQuery<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE tablename = 'ModerationReport' AND indexname = 'ModerationReport_cola'`,
    )
    expect(filas[0]?.indexdef, 'falta ModerationReport_cola').toBeTruthy()
    expect(filas[0].indexdef).toMatch(/WHERE[^)]*'OPEN'/i)
    // `status` sin comillas (todo minuscula no las necesita) y `createdAt` con
    // comillas. Se afirma el orden de las columnas y el `DESC` sin casarse con
    // las comillas que Postgres decide poner, que no son parte del contrato.
    expect(filas[0].indexdef).toMatch(/\(\s*"?status"?\s*,\s*"createdAt"\s+DESC\s*\)/)
  })

  it('las FK de objetivo y la del denunciante siguen en RESTRICT', async () => {
    // El otro mitad del contrato que Prisma no ve. Con `CASCADE` en
    // `reporterId` la evidencia se borra sola; con `SET NULL` en las de
    // objetivo, borrar lo reportado choca contra el CHECK. Los dos estan
    // verificados por comportamiento en `reports-borrado.test.ts`; aca se afirma
    // el estado del catalogo, para que un cambio de regla se vea en el nombre de
    // la constraint y no como un fallo de borrado raro.
    const filas = await rawQuery<{ column_name: string; delete_rule: string }>(
      `SELECT kcu.column_name, rc.delete_rule
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
         JOIN information_schema.referential_constraints rc ON tc.constraint_name = rc.constraint_name
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND tc.table_name = 'ModerationReport'
        ORDER BY kcu.column_name`,
    )

    const reglas = new Map(filas.map((f) => [f.column_name, f.delete_rule]))

    for (const col of ['reporterId', 'placeId', 'planId', 'userId', 'messageId']) {
      expect(reglas.get(col), `${col} deberia estar en RESTRICT`).toBe('RESTRICT')
    }
    // La unica que se queda en SET NULL, y por que: perder "quien cerro esto" es
    // tolerable, perder el reporte no.
    expect(reglas.get('resolvedById')).toBe('SET NULL')
  })
})