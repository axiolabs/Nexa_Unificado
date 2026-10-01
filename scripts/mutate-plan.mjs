// Mutantes para el contrato de "lugar no disponible". Cada uno quita UNA de las
// tres condiciones y debe morir solo el test que la cubre.
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'

const JOIN = 'app/api/plans/[planId]/join/route.ts'
const PLACES = 'lib/places.ts'
const ERRORS = 'lib/prisma-errors.ts'

const MUTANTS = [
  {
    id: 'P1',
    name: 'join ignora verificationStatus (deja entrar a un lugar curado)',
    file: JOIN,
    from: "plan.place.verificationStatus !== 'APPROVED' ||\n    !plan.place.isActive ||",
    to: 'false ||\n    !plan.place.isActive ||',
  },
  {
    id: 'P2',
    name: 'join ignora isActive',
    file: JOIN,
    from: "plan.place.verificationStatus !== 'APPROVED' ||\n    !plan.place.isActive ||",
    to: "plan.place.verificationStatus !== 'APPROVED' ||\n    false ||",
  },
  {
    id: 'P3',
    name: 'join ignora deletedAt',
    file: JOIN,
    from: 'plan.place.deletedAt !== null\n  ) {',
    to: 'false\n  ) {',
  },
  {
    id: 'P4',
    name: 'join no distingue un lugar no disponible: mensaje generico',
    file: JOIN,
    from: "return fail(409, 'El lugar de este plan ya no esta disponible')",
    to: "return fail(409, 'El plan ya no acepta participantes')",
  },
  {
    id: 'P5',
    name: 'planablePlaceWhere acepta cualquier estado de curaduria',
    file: PLACES,
    from: "    verificationStatus: 'APPROVED',\n    isActive: true,",
    to: "    verificationStatus: { in: ['PENDING', 'APPROVED'] },\n    isActive: true,",
  },
  {
    id: 'P6',
    name: 'planablePlaceWhere no exige isActive',
    file: PLACES,
    from: "    verificationStatus: 'APPROVED',\n    isActive: true,\n    deletedAt: null,\n  }\n}",
    to: "    verificationStatus: 'APPROVED',\n    deletedAt: null,\n  }\n}",
  },
  {
    id: 'P7',
    name: 'planablePlaceWhere no excluye los borrados logicamente',
    file: PLACES,
    from: "    verificationStatus: 'APPROVED',\n    isActive: true,\n    deletedAt: null,",
    to: "    verificationStatus: 'APPROVED',\n    isActive: true,",
  },
  {
    id: 'P8',
    name: 'la creacion se apoya solo en el pre-check (se saca la revalidacion interna)',
    // Este mutante NO se puede matar desde HTTP a proposito: sacar el chequeo
    // dentro de la transaccion es indistinguible del original para cualquier
    // peticion, porque la carrera que el chequeo previene no se puede provocar
    // desde un cliente. Se corre para dejarlo registrado como sobreviviente
    // esperado, no para fingir que la suite lo cubre.
    file: 'app/api/plans/route.ts',
    from: "      if (!placeLive) throw new PlaceUnavailableError()",
    to: '      void placeLive',
    esperado: 'misma carrera que E7: la ventana entre el pre-check y el create no se puede provocar desde un cliente HTTP',
  },
  {
    id: 'E1',
    name: 'un deadlock se reporta como "el lugar no existe"',
    file: ERRORS,
    from: "  'P2034',\n",
    to: '',
  },
  {
    id: 'E2',
    name: 'la base inalcanzable NO se marca como reintentable',
    file: ERRORS,
    from: "  'P1001',\n  'P1002',\n  'P1008',\n  'P1017',\n",
    to: '',
  },
  {
    id: 'E3',
    name: 'un unique (P2002) se marca como reintentable',
    file: ERRORS,
    from: "const RETRYABLE: ReadonlySet<string> = new Set([",
    to: "const RETRYABLE: ReadonlySet<string> = new Set([\n  'P2002',\n  'P2003',",
  },
  {
    id: 'E4',
    name: 'un timeout de transaccion no se reintenta',
    file: ERRORS,
    from: "  'P2028',\n",
    to: '',
  },
  {
    id: 'E5',
    name: 'la clasificacion acepta cualquier objeto con un `code` (no instanceof)',
    // Sin `instanceof`, un objeto plano `{ code: "P1001" }` se reportaria como
    // caida de base. Es el mutante que Justifica el `instanceof Error`.
    file: ERRORS,
    from: "return err instanceof Error && RETRYABLE.has((err as { code?: string }).code ?? '')",
    to: "return RETRYABLE.has((err as { code?: string })?.code ?? '')",
  },
  {
    id: 'E6',
    name: 'join no mira el codigo: cualquier error de Prisma dice "ya participas"',
    file: JOIN,
    // El mutante "volver al catch pelado" literal no se puede escribir en
    // TypeScript (deja de estrechar `err` y el build falla), asi que la misma
    // mentira se expresa como "cualquier Prisma errorKnown -> 409". Es el bug
    // que importa: la causa se|reporta mal.
    from: 'err instanceof Prisma.PrismaClientKnownRequestError && err.code === \'P2002\'',
    to: 'err instanceof Prisma.PrismaClientKnownRequestError',
    esperado: 'no se puede provocar por HTTP: un Prisma error que no sea P2002 ni de infraestructura no hay forma de generarlo sin cortar la base',
  },
  {
    id: 'E7',
    name: 'crear plan pierde el manejo de PlaceUnavailableError (cae a 500)',
    file: 'app/api/plans/route.ts',
    from: "    if (err instanceof PlaceUnavailableError) {\n      return fail(404, 'El lugar no existe o no esta disponible')\n    }",
    to: '',
    esperado: 'misma carrera que P8: solo se dispara si el lugar cambia de estado entre el pre-check y el create',
  },
]

const TESTS = ['tests/map/plans-api.test.ts', 'tests/api/prisma-errors.test.ts']
const results = []

// `node scripts/mutate-plan.mjs E6 E7` corre solo esos mutantes.
const SOLO = process.argv.slice(2)

for (const m of MUTANTS) {
  if (SOLO.length && !SOLO.includes(m.id)) continue
  const orig = fs.readFileSync(m.file, 'utf8')
  if (!orig.includes(m.from)) {
    results.push({ ...m, status: 'NO-APLICADO' })
    console.log(`  ?? ${m.id} ${m.name} (texto no encontrado)`)
    continue
  }
  fs.writeFileSync(m.file, orig.replace(m.from, m.to))
  let killed = false
  let det = ''
  try {
    // Un mutante que no compila NO esta matado: probo el compilador, no el
    // comportamiento. Se reporta aparte, con el error, para no contarlo como
    // cobertura.
    try {
      execFileSync('npx', ['next', 'build'], { stdio: 'pipe', shell: true })
    } catch (e) {
      const out = (e.stdout ? e.stdout.toString() : '') + (e.stderr ? e.stderr.toString() : '')
      const primera = out
        .replace(/\x1b\[[0-9;]*m/g, '')
        .split('\n')
        .find((l) => /error|Failed/i.test(l))
      results.push({ ...m, status: 'NO-COMPILA', det: primera ? primera.trim() : '' })
      console.log(`  NO-COMPILA ${m.id} ${m.name}`)
      if (primera) console.log(`        ${primera.trim()}`)
      continue
    }
    try {
      execFileSync('npx', ['vitest', 'run', '--config', 'vitest.config.mts', ...TESTS], {
        stdio: 'pipe',
        shell: true,
      })
    } catch (e) {
      const out = (e.stdout ? e.stdout.toString() : '') + (e.stderr ? e.stderr.toString() : '')
      killed = true
      const m2 = out.match(/FAIL\s+[^\n]+/)
      det = m2 ? m2[0].replace(/\x1b\[[0-9;]*m/g, '').trim() : ''
    }
  } finally {
    fs.writeFileSync(m.file, orig)
  }
  results.push({ ...m, status: killed ? 'kill' : 'VIVE', det })
  console.log(`  ${killed ? 'kill' : 'VIVE'} ${m.id} ${m.name}`)
  if (det) console.log(`        detectado por: ${det}`)
}

console.log('')
const killed = results.filter((r) => r.status === 'kill').length
const alive = results.filter((r) => r.status === 'VIVE').length
const na = results.filter((r) => r.status === 'NO-APLICADO').length
const nc = results.filter((r) => r.status === 'NO-COMPILA').length
console.log(`${killed} matadas, ${alive} sobrevivientes, ${nc} sin compilar, ${na} sin aplicar`)
if (alive) {
  const inesperados = results.filter((x) => x.status === 'VIVE' && !x.esperado)
  const esperados = results.filter((x) => x.status === 'VIVE' && x.esperado)
  for (const r of esperados) {
    console.log(`  ${r.id} sobrevive (esperado): ${r.esperado}`)
  }
  if (inesperados.length) {
    console.log('Sobrevivientes INESPERADOS (revisar):')
    for (const r of inesperados) console.log(`  ${r.id} ${r.name}`)
  } else {
    console.log('  sin sobrevivientes inesperados')
  }
}
