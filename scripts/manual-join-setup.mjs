/**
 * Deja la DB de DEV lista para la pasada MANUAL de "Pedir unirme".
 *
 * NO es un test y NO corre en `npm test`: el proyecto no tiene DOM en el
 * harness, y el click no se puede probar sin navegador. Existe por la misma
 * razon que `manual-plan-flow.mjs`: para que la pasada sea REPETIBLE y quede
 * versionada, en vez de depender de una terminal que ya no existe.
 *
 *   node scripts\manual-join-setup.mjs
 *
 * Lee `.env` (la DB de DEV), nunca `.env.test`. Siembra un host, un segundo
 * usuario y un plan OPEN. Volver a correrlo resetea SOLO sus propios datos
 * (los identifica por email y por nombre de lugar), asi que se puede repetir
 * sin acumular planes. NO limpia al salir: el estado queda para que lo use una
 * persona.
 *
 * Por que imprime las cookies y no dice "inicia sesion": en este proyecto
 * todavia NO existe pantalla de login. El unico login es `POST /api/auth/login`,
 * al que un navegador no llega solo. La cookie va firmada con el mismo
 * `createSessionToken` del server, asi que es una sesion de verdad, no un atajo.
 */
import { existsSync } from 'node:fs'

if (existsSync('.env')) process.loadEnvFile('.env')

const { getPrisma } = await import('../lib/db.ts')
const { hashPassword } = await import('../lib/auth/password.ts')
const { createSessionToken } = await import('../lib/auth/token.ts')

const prisma = getPrisma()

const HOST_EMAIL = 'host.manual@example.com'
const JOINER_EMAIL = 'se.une.manual@example.com'
const PASSWORD = 'cavallo-grapa-correo-42'
const LUGAR = 'Cafeteria Manual Join'
const PUERTO = process.env.PORT ?? '3000'

const line = (t) => console.log('\n' + '='.repeat(72) + '\n' + t + '\n' + '='.repeat(72))
const step = (t) => console.log('\n-- ' + t)
const ok = (t) => console.log('   OK   ' + t)

// ------------------------------------------------------------------ reset ---
// Borra lo que este mismo script sembro antes. El orden importa: los planes
// referencian al lugar y al creador con `onDelete: Restrict`, asi que van
// primero; los usuarios recien despues de que sus planes ya no estan.
const previos = await prisma.user.findMany({
  where: { email: { in: [HOST_EMAIL, JOINER_EMAIL] } },
  select: { id: true },
})
const ids = previos.map((u) => u.id)
if (ids.length) await prisma.plan.deleteMany({ where: { creatorId: { in: ids } } })
await prisma.place.deleteMany({ where: { name: LUGAR } })
if (ids.length) await prisma.user.deleteMany({ where: { id: { in: ids } } })

// ------------------------------------------------------------------- seed ---
step('Siembro lugar, usuarios y plan')
const place = await prisma.place.create({
  data: {
    name: LUGAR,
    category: 'CAFE',
    priceLevel: 'LOW',
    latitude: -34.6037,
    longitude: -58.3816,
    timezone: 'America/Argentina/Buenos_Aires',
    verificationStatus: 'APPROVED',
  },
})
ok(`lugar APPROVED ${place.id}`)

const hash = await hashPassword(PASSWORD)

const host = await prisma.user.create({
  data: { email: HOST_EMAIL, name: 'Host Manual', passwordHash: hash },
})
await prisma.userRoleAssignment.create({ data: { userId: host.id, role: 'HOST' } })
ok(`host ${HOST_EMAIL}`)

const joiner = await prisma.user.create({
  data: { email: JOINER_EMAIL, name: 'Se Une Manual', passwordHash: hash },
})
ok(`se une ${JOINER_EMAIL}`)

// `startsAt` a 48h: mas alla del TTL de 24h de la peticion, para que el plazo
// sea el completo y no quede recortado por el inicio del plan.
const startsAt = new Date(Date.now() + 48 * 3_600_000)
const plan = await prisma.plan.create({
  data: {
    title: 'Cafe para probar unirse a mano',
    description: 'Plan sembrado por scripts/manual-join-setup.mjs para la pasada manual.',
    placeId: place.id,
    creatorId: host.id,
    startsAt,
    endsAt: new Date(startsAt.getTime() + 3 * 3_600_000),
    capacity: 4,
    acceptedCount: 1,
    status: 'OPEN',
    participants: { create: { userId: host.id, role: 'ORGANIZER', status: 'ACCEPTED' } },
  },
})
ok(`plan OPEN ${plan.id} (1/4, a 48h)`)

// ------------------------------------------------------------------ salida ---
const url = `http://localhost:${PUERTO}/planes/${plan.id}`
const cookieJoiner = createSessionToken(joiner.id)

line('Listo. La pasada manual, en 4 clicks')
console.log(`   password para los dos: ${PASSWORD}`)
console.log(`   URL del plan:          ${url}`)
console.log('')
console.log('   1. Con `npm run dev` corriendo, abri la URL.')
console.log('   2. En la consola del navegador, pega esto para entrar como el que se une:')
console.log('')
console.log(`      document.cookie = "nexa_session=${cookieJoiner}; path=/"; location.reload()`)
console.log('')
console.log('   3. Click en "Pedir unirme". Esperado: 201 y el texto "Pediste unirte.')
console.log('      Esperando que el organizador responda." en vez del boton.')
console.log('   4. Recarga (F5). Esperado: sigue "Esperando", no vuelve el boton.')
console.log('      Ese estado REQUESTED persistido es lo que ningun test HTTP mira.')
console.log('')
console.log('   Contraste sin sesion (opcional):')
console.log(`      borrar la cookie y recargar ${url} debe redirigir, no romper.`)

await prisma.$disconnect()
