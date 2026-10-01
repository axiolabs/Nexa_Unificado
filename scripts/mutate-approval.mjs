#!/usr/bin/env node
/**
 * Mutation testing del flujo de aprobacion.
 *
 * El valor de una suite esta en que falla cuando el codigo se rompe. Este script
 * mete mutaciones concretas, corre los tests que deberian detectarlas y falla si
 * alguno pasa igual.
 *
 * IMPORTANTE: rebuild por mutacion. Los tests pegan a `next start`, o sea al
 * BUNDLE, no al fuente. Si se muta el fuente sin rebuild, los tests corren
 * contra el codigo viejo y dan verde por el motivo equivocado. Es el mismo
 * motivo por el que `pretest` compila antes de testear.
 *
 * Las mutaciones son regresiones concretas, no cambios aleatorios.
 */
import { readFileSync, writeFileSync, copyFileSync, rmSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const JOIN = 'app/api/plans/[planId]/join/route.ts'
const REQ = 'app/api/plans/[planId]/requests/route.ts'
const DETAIL = 'app/api/plans/[planId]/route.ts'

const only = process.argv.slice(2)
const ALL = [
  {
    id: 'M1',
    name: 'el join acepta directo en vez de pedir',
    file: JOIN,
    from: "status: 'REQUESTED',",
    to: "status: 'ACCEPTED',",
  },
  {
    id: 'M2',
    name: 'el join no pone expiresAt: peticiones eternas',
    file: JOIN,
    from: 'expiresAt,',
    to: 'expiresAt: null,',
  },
  {
    id: 'M3',
    name: 'aprobar no incrementa acceptedCount',
    file: REQ,
    from: 'data: { acceptedCount: { increment: 1 } },',
    to: 'data: {},',
  },
  {
    id: 'M4',
    name: 'aprobar ignora la expiracion: aprueba a ciegas',
    file: REQ,
    from: "status: 'REQUESTED', expiresAt: { gt: now } },",
    to: "status: 'REQUESTED' },",
    // Mutante EQUIVALENTE, y a proposito se deja sobrevivir.
    //
    // El POST ya valida la expiracion antes de abrir la transaccion y devuelve
    // 409, asi que quitar el `expiresAt: { gt: now }` del `updateMany` no cambia
    // nada observable. El guard se mantiene igual porque no es redundante de
    // verdad: cubre la carrera entre esa lectura y la transaccion, donde la fila
    // puede cambiar. Marcarlo como sobreviviente esperado documenta que la
    // suite no puede distinguir las dos capas, no que falte cobertura.
    expectSurvivor: true,
  },
  {
    id: 'M5',
    name: 'aprobar ignora el cupo: overbooking',
    file: REQ,
    from: 'acceptedCount: { lt: plan.capacity },',
    to: 'acceptedCount: { lt: 9999 },',
  },
  {
    id: 'M6',
    name: 'la pantalla de aprobacion abre a cualquiera',
    file: REQ,
    from: "if (plan.creatorId !== gate.user.id) return fail(403, 'Solo el organizador ve las peticiones')",
    to: 'void gate.user.id',
  },
  {
    id: 'M7',
    name: 'responder peticiones abre a cualquiera',
    file: REQ,
    from: "if (plan.creatorId !== organizerId) return fail(403, 'Solo el organizador responde peticiones')",
    to: 'void organizerId',
  },
  {
    id: 'M8',
    name: 'la reliability se filtra al detalle del plan',
    file: DETAIL,
    from: '      plan: {\n        ...rest,',
    to: "      plan: {\n        ...rest,\n        showUpRate: 1,",
  },
  {
    id: 'M9',
    name: 'el barrido no corrige a DECLINED cuando falta cupo',
    file: REQ,
    from: "data: { status: 'DECLINED', respondedAt: now },",
    to: 'data: { respondedAt: now },',
  },
  {
    // Las tres siguientes atacan la REGLA DE CUPO del barrido, no el hecho de
    // que cambie algo. M9 prueba que el status se mueve; estas prueban que se
    // mueva al valor CORRECTO segun haya o no cupo.
    id: 'M10',
    name: 'el barrido siempre ACEPTA, ignorando que el plan este lleno',
    file: REQ,
    from: "where: { id: planId, deletedAt: null, acceptedCount: { lt: plan.capacity } },",
    to: "where: { id: planId, deletedAt: null, acceptedCount: { lt: 999999 } },",
  },
  {
    id: 'M11',
    name: 'el barrido siempre RECHAZA, aunque haya cupo de sobra',
    file: REQ,
    from: "where: { id: planId, deletedAt: null, acceptedCount: { lt: plan.capacity } },",
    to: "where: { id: planId, deletedAt: null, acceptedCount: { lt: -1 } },",
  },
  {
    id: 'M12',
    name: 'el barrido resuelve en LOTE: el updateMany sin cupo y sin bucle',
    file: REQ,
    from: "where: { id: planId, deletedAt: null, acceptedCount: { lt: plan.capacity } },\n        data: { acceptedCount: { increment: 1 } },",
    to: "where: { id: planId, deletedAt: null },\n        data: { acceptedCount: { increment: 1 } },",
  },
  {
    id: 'M13',
    name: 'el barrido no escribe respondedAt',
    file: REQ,
    from: "data: { status: 'ACCEPTED', respondedAt: now },",
    to: "data: { status: 'ACCEPTED' },",
  },
  {
    id: 'M14',
    name: 'el plazo ignora el inicio del plan (expiresAt = 24h a secas)',
    file: JOIN,
    from: 'const expiresAt = new Date(Math.min(ttlEnd, plan.startsAt.getTime()))',
    to: 'const expiresAt = new Date(ttlEnd)',
  },
]

const mutations = only.length > 0 ? ALL.filter((m) => only.includes(m.id)) : ALL
const TESTS = ['tests/map/plans-api.test.ts', 'tests/map/places-api.test.ts']

function run(cmd, args) {
  try {
    // `shell: true` es necesario en Windows: `npx` es un `.cmd` y
    // execFileSync sin shell no lo encuentra. Los argumentos que se pasan acá
    // (rutas de test, flags) no llevan caracteres que el shell interprete.
    execFileSync(cmd, args, {
      stdio: 'pipe',
      shell: true,
      env: { ...process.env, NODE_ENV: 'test' },
    })
    return { ok: true }
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

let killed = 0
const survivors = []
const notApplied = []
const expectedSurvivors = []

for (const m of mutations) {
  const backup = `${m.file}.mutbak`
  copyFileSync(m.file, backup)
  const original = readFileSync(m.file, 'utf8')

  if (!original.includes(m.from)) {
    console.log(`  ??  ${m.id} ${m.name}: no encontre el texto. Sin aplicar.`)
    notApplied.push(m.id)
    rmSync(backup)
    continue
  }

  try {
    writeFileSync(m.file, original.replace(m.from, m.to))

    const build = run('npx', ['next', 'build'])
    if (!build.ok) {
      console.log(`  ERR ${m.id} ${m.name}: la mutacion no compilaba, no es una prueba valida.`)
      notApplied.push(m.id)
    } else {
      const test = run('npx', ['vitest', 'run', '--config', 'vitest.config.mts', ...TESTS])
      if (!test.ok) {
        killed++
        // Vitest colorea la salida con secuencias ANSI que rompen un regex
        // directo sobre `FAIL`. Se limpian antes de buscar.
        const plain = test.out.replace(/\u001b\[[0-9;]*m/g, '')
        const failing = [...new Set((plain.match(/FAIL\s+\S+\.test\.ts/g) ?? []).map((s) => s.replace('FAIL ', '')))]
        console.log(`  kill ${m.id} ${m.name}`)
        if (failing.length) console.log(`        detectado por: ${failing.join(', ')}`)
      } else {
        if (m.expectSurvivor) {
          expectedSurvivors.push(m.id)
          console.log(`  ok   ${m.id} ${m.name}\n        sobrevive por diseño (mutante equivalente, ver el script)`)
        } else {
          survivors.push(m.id)
          console.log(`  VIVE ${m.id} ${m.name}   <-- la suite no lo detecta`)
        }
      }
    }
  } finally {
    copyFileSync(backup, m.file)
    rmSync(backup)
  }
}

const restore = run('npx', ['next', 'build'])
if (!restore.ok) {
  console.log('  !! el rebuild de restauracion fallo: revisar el fuente antes de commitear')
  process.exitCode = 1
}

console.log(
  `\n  ${killed} matadas, ${survivors.length} sobrevivientes, ${expectedSurvivors.length} equivalentes esperados, ${notApplied.length} sin aplicar`,
)
if (survivors.length) console.log(`  sobrevivientes: ${survivors.join(', ')}`)
if (expectedSurvivors.length) console.log(`  equivalentes esperados: ${expectedSurvivors.join(', ')}`)
if (notApplied.length) console.log(`  sin aplicar: ${notApplied.join(', ')}`)
if (survivors.length > 0 || notApplied.length > 0) process.exitCode = 1
