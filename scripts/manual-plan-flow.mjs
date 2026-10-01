/**
 * Pasada MANUAL del flujo de creacion de plan, de punta a punta.
 *
 * NO es un test. No corre en `npm test` y no deberia agregarse: el proyecto no
 * tiene DOM en el harness, y agregar una dependencia para testear un `onSubmit`
 * no es el mismo negocio que ejecutar el flujo una vez a mano.
 *
 * Que quede en el repo es por otra razon: para que la pasada sea REPETIBLE. Un
 * "lo probamos a mano" que solo existio en una terminal no lo puede repetir
 * nadie. Con el script, el procedimiento esta versionado y el proximo que quiera
 * volver a correrlo lo corre.
 *
 *   node scripts\manual-plan-flow.mjs
 *
 * Levanta `next start` en el puerto de tests, siembra un lugar aprobado y uno
 * pendiente, se registra por la API, inicia sesion con cookie real, abre la
 * pagina, busca el lugar, arma el body EXACTAMENTE como lo arma `onSubmit`
 * (con el `toApiDate` real del modulo, no con una copia), envia el POST, y
 * despues verifica en la base. Al final limpia lo que sembro.
 *
 * Lo que NO puede probar es el click. El resto del camino, con el server de
 * produccion y el middleware de verdad, si.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { createHash, randomBytes } from 'node:crypto'

if (existsSync('.env.test')) process.loadEnvFile('.env.test')

const PORT = process.env.TEST_PORT ?? '3100'
const BASE = `http://127.0.0.1:${PORT}`
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone

const { toApiDate } = await import('../lib/plan-dates.ts')
const { getPrisma } = await import('../lib/db.ts')
const prisma = getPrisma()

const line = (t) => console.log('\n' + '='.repeat(72) + '\n' + t + '\n' + '='.repeat(72))
const step = (t) => console.log('\n-- ' + t)
const ok = (t) => console.log('   OK   ' + t)
const fail = (t) => {
  console.log('   FALLA ' + t)
  process.exitCode = 1
}
const check = (cond, t) => (cond ? ok(t) : fail(t))

// ---------------------------------------------------------------- servidor ---
// Se spawnea `node next/dist/bin/next` y no `npx next`: en Windows, `spawn` de un
// `.cmd` tira EINVAL. Es el mismo camino que usa `tests/setup/server.ts`.
const NEXT_BIN = new URL('../node_modules/next/dist/bin/next', import.meta.url).pathname.replace(
  /^\/([A-Za-z]:)/,
  '$1',
)

let server = null
async function boot() {
  server = spawn(process.execPath, [NEXT_BIN, 'start', '-p', PORT], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'production' },
  })
  server.stdout.on('data', () => {})
  server.stderr.on('data', (d) => {
    const s = String(d)
    if (/error|Error/.test(s)) process.stderr.write('  [server] ' + s)
  })
  for (let i = 0; i < 60; i++) {
    await sleep(500)
    try {
      const r = await fetch(BASE + '/explore', { redirect: 'manual' })
      if (r.status < 500) return
    } catch {
      /* aun no levanta */
    }
  }
  throw new Error('el server no levanto')
}

// ------------------------------------------------------------- cliente HTTP ---
let cookie = ''
async function http(method, path, body) {
  const headers = { origin: BASE }
  if (cookie) headers.cookie = cookie
  if (body !== undefined) headers['content-type'] = 'application/json'
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  })
  for (const raw of res.headers.getSetCookie()) {
    const [pair] = raw.split(';')
    const eq = pair.indexOf('=')
    if (eq > 0) cookie = pair.slice(0, eq) + '=' + pair.slice(eq + 1)
  }
  const text = await res.text()
  let parsed = text
  try {
    parsed = JSON.parse(text)
  } catch {
    /* html */
  }
  return { status: res.status, body: parsed }
}

const sello = randomBytes(4).toString('hex')
const EMAIL = `host.manual.${sello}@example.com`
const PASSWORD = 'cavallo-grapa-correo-42'
const NOMBRE_LUGAR = 'Cafetería del Manual'
const NOMBRE_PENDIENTE = 'Bar Sin Revisar Manual'

// ------------------------------------------------------------------ arranque ---
line(`Pasada manual: crear un plan como host`)
console.log(`   origen:        ${BASE}`)
console.log(`   zona del proceso: ${TZ} (offset ${new Date().getTimezoneOffset() / 60}h)`)
console.log(`   build:         next start, el mismo camino de produccion`)

step('Levanto el server de produccion')
await boot()
ok('server escuchando')

// ------------------------------------------------------------------- semilla ---
step('Preparo datos: un lugar aprobado, uno pendiente, y un usuario host')
const place = await prisma.place.create({
  data: {
    name: NOMBRE_LUGAR,
    category: 'CAFE',
    priceLevel: 'LOW',
    latitude: -34.6037,
    longitude: -58.3816,
    timezone: 'America/Argentina/Buenos_Aires',
    verificationStatus: 'APPROVED',
  },
})
const pendiente = await prisma.place.create({
  data: {
    name: NOMBRE_PENDIENTE,
    category: 'BAR',
    priceLevel: 'MEDIUM',
    latitude: -34.604,
    longitude: -58.382,
    timezone: 'America/Argentina/Buenos_Aires',
    verificationStatus: 'PENDING',
  },
})
ok(`lugar aprobado  ${place.id}`)
ok(`lugar pendiente ${pendiente.id} (esta sembrado para comprobar que NO se ofrece)`)

step('Me registro por la API, como lo haria una persona')
const reg = await http('POST', '/api/auth/register', {
  name: 'Host Manual',
  email: EMAIL,
  password: PASSWORD,
})
check(
  reg.status === 201 || reg.status === 200,
  `registro -> ${reg.status} ${JSON.stringify(reg.body).slice(0, 200)}`,
)
if (reg.status !== 201 && reg.status !== 200) {
  console.log('   APP_ORIGIN del server: ' + (process.env.APP_ORIGIN ?? '(sin definir)'))
  console.log('   origin enviado:        ' + BASE)
  console.log('   cuerpo: ' + JSON.stringify(reg.body))
  throw new Error('el registro no salio; los 403 de mutacion son de Origin')
}

const user = await prisma.user.findUniqueOrThrow({ where: { email: EMAIL } })
await prisma.userRoleAssignment.create({ data: { userId: user.id, role: 'HOST' } })
ok(`rol HOST asignado a ${EMAIL}`)

step('Inicio sesion (cookie real, no llamada directa al handler)')
const login = await http('POST', '/api/auth/login', { email: EMAIL, password: PASSWORD })
check(login.status === 200, `login -> ${login.status}`)
check(cookie.includes('='), `cookie de sesion obtenida`)

// --------------------------------------------------------------- la pantalla ---
step('Abro /host/planes/nuevo')
const page = await http('GET', '/host/planes/nuevo')
check(page.status === 200, `pagina -> ${page.status}`)
for (const id of ['place-q', 'title', 'description', 'startsAt', 'endsAt', 'capacity']) {
  check(page.body.includes(`id="${id}"`), `control ${id} presente`)
}
const sinSesion = await fetch(BASE + '/host/planes/nuevo', { redirect: 'manual' })
check(sinSesion.status === 401, `sin sesion la pagina no se renderiza -> ${sinSesion.status}`)

// ---------------------------------------------------------------- el picker ---
step('Escribo en el buscador, como lo hace el componente (300 ms de debounce)')
for (const q of ['Cafe', 'Cafetería', 'del Manual', 'Manual']) {
  const r = await http('GET', `/api/host/places?q=${encodeURIComponent(q)}`)
  const n = r.body.places?.length ?? 0
  const nombres = (r.body.places ?? []).map((p) => p.name)
  console.log(`   q="${q}" -> ${r.status}, ${n} resultado(s) ${JSON.stringify(nombres)}`)
}
const rCorto = await http('GET', '/api/host/places?q=C')
check(rCorto.status === 400, `un solo caracter -> ${rCorto.status} con motivo "${rCorto.body.error}"`)

const rTodos = await http('GET', '/api/host/places?q=Manual')
const nombres = rTodos.body.places.map((p) => p.name)
check(
  nombres.includes(NOMBRE_LUGAR),
  `el lugar aprobado se ofrece: ${JSON.stringify(nombres)}`,
)
check(
  !nombres.includes(NOMBRE_PENDIENTE),
  'el PENDING NO se ofrece, ni a un host que es curador',
)
console.log(`   total=${rTodos.body.total} truncated=${rTodos.body.truncated}`)
check(rTodos.body.total === nombres.length, 'total coincide con los lugares ofrecidos')

// -------------------------------------------------------------- el formulario ---
step('Lleno el formulario: titulo, descripcion, lugar, fechas y capacidad')
const TITULO = 'Cafe con gente nueva'
const DESCRIPCION = 'ACHICHO + algo dulce. Se viene con hambre, sin drama.'

// Estas son las horas de pared que "escribo" en los datetime-local. El proceso
// corre en `TZ`, y el que las convierte es el `toApiDate` REAL del modulo.
const INICIO = '2026-10-08T20:00'
const FIN = '2026-10-08T23:30'
const CAPACIDAD = 4

const startsAtIso = toApiDate(INICIO)
const endsAtIso = toApiDate(FIN)
check(startsAtIso !== null, `toApiDate("${INICIO}") = ${startsAtIso}`)
check(endsAtIso !== null, `toApiDate("${FIN}") = ${endsAtIso}`)

// Exactamente el body que arma `onSubmit`.
const body = {
  title: TITULO,
  description: DESCRIPCION,
  placeId: place.id,
  startsAt: startsAtIso,
  endsAt: endsAtIso,
  capacity: CAPACIDAD,
}
console.log('   body que se envia:')
console.log('   ' + JSON.stringify(body))

step('Hago clic en "Crear plan"')
const post = await http('POST', '/api/plans', body)
check(post.status === 201, `POST /api/plans -> ${post.status}`)
if (post.status !== 201) {
  console.log('   cuerpo: ' + JSON.stringify(post.body))
} else {
  console.log('   respuesta: ' + JSON.stringify(post.body.plan))
}

// ------------------------------------------------------------ verificacion ---
step('Verifico en la base, no en la respuesta del endpoint')
const creado = await prisma.plan.findUniqueOrThrow({
  where: { id: post.body.plan.id },
  include: { participants: { include: { user: true } }, place: true },
})
console.log('   plan leido:  ' + creado.id)
check(creado.title === TITULO, `title = ${JSON.stringify(creado.title)}`)
check(creado.description === DESCRIPCION, `description = ${JSON.stringify(creado.description)}`)
check(creado.placeId === place.id, `placeId apunta al lugar elegido`)
check(creado.capacity === CAPACIDAD, `capacity = ${creado.capacity}`)
check(creado.acceptedCount === 1, `acceptedCount = ${creado.acceptedCount}`)
check(creado.status === 'OPEN', `status = ${creado.status}`)
check(creado.creatorId === user.id, 'creatorId es el host que lo creo')

// Se lee la relacion UNA vez y se reutiliza. Antes se hacia
// `creado.participants.length` dos veces en la misma linea --una en la condicion
// y otra dentro del template-- y la segunda devolvia `undefined` con un
// `TypeError`, con el array ya verificado como array en la linea anterior. Sea
// lo que sea que pase en el segundo acceso, un script de verificacion no
// deberia depender de eso: se lee una vez y se usa.
const partes = creado.participants
check(Array.isArray(partes) && partes.length === 1, `participantes = ${partes.length}`)
const p0 = partes[0]
check(p0?.role === 'ORGANIZER', `rol dentro del plan = ${p0?.role}`)
check(p0?.status === 'ACCEPTED', `estado = ${p0?.status}`)
check(p0?.userId === user.id, 'el participante es el host, no Carla ni nadie mas')


step('La fecha: lo que escribi, lo que viaja y lo que quedo guardado')
const ver = (d, tz) => d.toLocaleString('es-AR', { timeZone: tz, hourCycle: 'h23', dateStyle: 'short', timeStyle: 'short' })
console.log(`   escribi en el input : ${INICIO}`)
console.log(`   viaje por la red    : ${startsAtIso}`)
console.log(`   guardado (UTC)      : ${creado.startsAt.toISOString()}`)
console.log(`   leido en ${TZ.padEnd(22)}: ${ver(creado.startsAt, TZ)}`)
console.log(`   leido en Buenos Aires: ${ver(creado.startsAt, 'America/Argentina/Buenos_Aires')}`)
console.log(`   lo que muestra el formulario al confirmar (misma zona que el proceso):`)
console.log(`   -> ${ver(creado.startsAt, TZ)}`)
check(
  creado.startsAt.toISOString() === startsAtIso,
  'el instante guardado es EXACTO el que salio del input, sin corrimiento',
)
check(
  new Date(creado.startsAt).getHours() === 20,
  `vuelto a leer en la zona del proceso sigue siendo las 20:00 (hora de pared conservada)`,
)
check(
  (creado.endsAt.getTime() - creado.startsAt.getTime()) / 3_600_000 === 3.5,
  `duracion = ${(creado.endsAt.getTime() - creado.startsAt.getTime()) / 3_600_000}h`,
)
check(creado.endsAt > creado.startsAt, 'endsAt posterior a startsAt')

// El plan tiene que verse en el listado del mapa, que es donde el host lo va a buscar.
const box = { minLng: -58.5, minLat: -34.65, maxLng: -58.3, maxLat: -34.55 }
const lista = await http(
  'GET',
  `/api/plans?bbox=${box.minLng},${box.minLat},${box.maxLng},${box.maxLat}`,
)
const mio = (lista.body.plans ?? []).find((p) => p.id === creado.id)
check(!!mio, 'el plan recien creado aparece en el listado de planes del mapa')
// El listado tiene que devolver el INSTANTE crudo, no un texto ya formateado:
// formatearlo en el server es lo que obliga a cada pantalla a interpretarlo, y
// es donde se colaron las 12 horas de §13.3.
check(
  typeof mio?.startsAt === 'string' && mio.startsAt === creado.startsAt.toISOString(),
  `el listado devuelve el mismo instante que se guardo: ${mio?.startsAt}`,
)
check(
  !/\d{2}:\d{2}\s?[ap]\.\s?m\./i.test(String(mio?.startsAt)),
  'y lo devuelve como ISO, no como texto de 12 horas',
)

// ------------------------------------------------------- caminos de error ---
step('Camino de error 1: el lugar deja de estar disponible entre elegir y enviar')
await prisma.place.update({ where: { id: place.id }, data: { isActive: false } })
const porInactivo = await http('POST', '/api/plans', {
  title: 'Segundo intento con el mismo lugar',
  placeId: place.id,
  startsAt: toApiDate('2026-10-09T20:00'),
  capacity: 4,
})
check(porInactivo.status === 404, `-> ${porInactivo.status} con "${porInactivo.body.error}"`)
await prisma.place.update({ where: { id: place.id }, data: { isActive: true } })

step('Camino de error 2: el usuario escribe un plan de mas de 24 horas')
const largo = await http('POST', '/api/plans', {
  title: 'Plan de mas de un dia',
  placeId: place.id,
  startsAt: toApiDate('2026-10-08T20:00'),
  endsAt: toApiDate('2026-10-10T20:00'),
  capacity: 4,
})
check(largo.status === 400, `-> ${largo.status}`)
console.log('   campos: ' + JSON.stringify(largo.body.fields))
check(
  typeof largo.body.fields?.endsAt === 'string',
  'el error viene POR CAMPO, que es lo que el formulario pinta debajo del input',
)

step('Camino de error 3: el lugar pendiente, si se llegara a elegir')
const porPendiente = await http('POST', '/api/plans', {
  title: 'Intento con un lugar sin revisar',
  placeId: pendiente.id,
  startsAt: toApiDate('2026-10-09T20:00'),
  capacity: 4,
})
check(porPendiente.status === 404, `-> ${porPendiente.status} con "${porPendiente.body.error}"`)

// ------------------------------------------------------------------ limpieza ---
step('Limpio lo que sembre')
await prisma.plan.deleteMany({ where: { placeId: { in: [place.id, pendiente.id] } } })
await prisma.place.deleteMany({ where: { id: { in: [place.id, pendiente.id] } } })
await prisma.userRoleAssignment.deleteMany({ where: { userId: user.id } })
await prisma.user.deleteMany({ where: { id: user.id } })
ok('base como estaba')

await prisma.$disconnect()
server.kill()
await sleep(300)

line(process.exitCode ? 'RESULTADO: hay fallas, mirá arriba' : 'RESULTADO: el flujo completo funciona a mano')
process.exit(process.exitCode ?? 0)
