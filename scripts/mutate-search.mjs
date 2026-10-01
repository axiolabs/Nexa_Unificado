// Mutantes de la busqueda por nombre (`?q=`). Verifican que los tests de
// `places-api.test.ts` cubrian el contrato y no solo el camino feliz.
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'

const ROUTE = 'app/api/places/route.ts'
const PLACES = 'lib/places.ts'

const MUTANTS = [
  {
    id: 'Q1',
    name: 'se aceptan bbox y q juntos (AND silencioso)',
    file: ROUTE,
    from: "  if (rawBbox !== null && rawQ !== null) {\n    return fail(400, 'Usa bbox o q, no los dos: son filtros alternativos')\n  }",
    to: '  if (false) {\n    void rawBbox\n    void rawQ\n  }',
  },
  {
    id: 'Q2',
    name: 'sin bbox ni q se devuelve la base entera',
    file: ROUTE,
    from: "  if (rawBbox === null && rawQ === null) {\n    return fail(400, 'Falta bbox o q: el mapa pide una caja, la busqueda un nombre')\n  }",
    to: '  if (false) {\n    void rawBbox\n  }',
  },
  {
    id: 'Q3',
    name: 'la busqueda acepta un solo caracter',
    file: ROUTE,
    from: '    if (q.length < 2) {',
    to: '    if (q.length < 1) {',
  },
  {
    id: 'Q4',
    name: 'el piso de longitud mide el texto crudo, sin trim',
    file: ROUTE,
    from: '    if (q.length < 2) {',
    to: '    if (rawQ.length < 2) {',
  },
  {
    id: 'Q5',
    name: 'truncated siempre false: el tope vuelve a ser invisible',
    file: PLACES,
    from: '    truncated: total > rows.length,',
    to: '    truncated: false,',
  },
  {
    id: 'Q6',
    name: 'total es la pagina, no el total real',
    file: PLACES,
    from: '    total,\n    truncated: total > rows.length,',
    to: '    total: rows.length,\n    truncated: total > rows.length,',
  },
  {
    id: 'Q7',
    name: 'la busqueda no filtra por visibilidad (muestra PENDING a cualquiera)',
    file: PLACES,
    from: '  const where = {\n    ...visibleWhere(opts.isCurator ?? false),',
    to: '  const where = {\n    ...(opts.isCurator ?? false ? {} : {}),',
  },
  {
    id: 'Q8',
    name: 'la busqueda distingue mayusculas (el usuario escribe en minuscula)',
    file: PLACES,
    from: "    name: { contains: q, mode: 'insensitive' as const },",
    to: '    name: { contains: q },',
  },
  {
    id: 'Q9',
    name: 'la busqueda coincide solo por prefijo, no por substring',
    file: PLACES,
    from: "    name: { contains: q, mode: 'insensitive' as const },",
    to: "    name: { startsWith: q, mode: 'insensitive' as const },",
  },
  {
    id: 'Q10',
    name: 'la busqueda ignora el filtro de categoria',
    file: PLACES,
    from: '    ...categoryFilter(filters.category),\n    ...priceFilter(filters.priceLevel),\n    name:',
    to: '    ...priceFilter(filters.priceLevel),\n    name:',
  },
  {
    id: 'Q11',
    name: 'la busqueda ignora el filtro de precio',
    file: PLACES,
    from: '    ...categoryFilter(filters.category),\n    ...priceFilter(filters.priceLevel),\n    name:',
    to: '    ...categoryFilter(filters.category),\n    name:',
  },
  {
    id: 'Q12',
    name: 'la busqueda no excluye los lugares desactivados',
    // No se corre: el mutante no compila (`in: [...]` se infiere `string[]` y no
    // es asignable al enum, el mismo error que ya aparecio una vez). Y no hacia
    // falta: `isActive` y `deletedAt` salen de `visibleWhere`, el mismo
    // predicado que Q7 ya mata, y el behavior esta cubierto por el test HTTP
    // "un lugar desactivado o borrado logicamente tampoco". Un mutante que
    // probaria lo mismo por otra ruta no agrega cobertura, agrega tiempo.
    file: PLACES,
    from: '  const where = {\n    ...visibleWhere(opts.isCurator ?? false),',
    to: '  const where = {\n    ...(opts.isCurator ?? false ? {} : {}),',
  },
]

const TESTS = ['tests/map/places-api.test.ts']
const SOLO = process.argv.slice(2)
const results = []

for (const m of MUTANTS) {
  if (SOLO.length && !SOLO.includes(m.id)) continue
  const orig = fs.readFileSync(m.file, 'utf8')
  if (!orig.includes(m.from)) {
    results.push({ ...m, status: 'NO-APLICADO' })
    console.log(`  ?? ${m.id} ${m.name} (texto no encontrado)`)
    continue
  }
  fs.writeFileSync(m.file, orig.split(m.from).join(m.to))
  let killed = false
  let det = ''
  try {
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
const inesperados = results.filter((x) => x.status !== 'kill' && !x.esperado)
if (inesperados.length) {
  console.log('Revisar:')
  for (const r of inesperados) console.log(`  ${r.id} [${r.status}] ${r.name}`)
}
