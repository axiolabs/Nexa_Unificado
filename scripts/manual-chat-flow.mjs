/**
 * Deja la DB de DEV lista para la pasada MANUAL del flujo completo:
 * el organizador ACEPTA una solicitud, y los dos escriben en el chat.
 *
 * NO es un test y NO corre en `npm test`: el harness no tiene DOM, y ni el click
 * de "Aceptar" ni el de "Enviar" se pueden probar sin navegador. Existe por la
 * misma razon que `manual-join-setup.mjs`: que la pasada sea REPETIBLE y quede
 * versionada, en vez de depender de una terminal que ya no existe.
 *
 *   node scripts\manual-chat-flow.mjs
 *
 * Que diferencia a este del de "Pedir unirme": siembra al postulante con la
 * peticion YA PENDIENTE (`REQUESTED`), no con nada. Asi la pasada manual
 * ejercita el boton de "Aceptar" de verdad, que es la parte que solo se puede
 * probar clicking. Y siembra los mensajes de arranque para que la carga
 * inicial del chat tenga algo que paginar y mostrar.
 *
 * Imprime las DOS cookies. Un solo navegador no alcanza para probar el chat: las
 * sesiones van en cookies, y con un unico perfil las dos pestanas serian la
 * misma persona. La pasada usa dos perfiles de Edge.
 */
import { existsSync } from 'node:fs'

if (existsSync('.env')) process.loadEnvFile('.env')

const { getPrisma } = await import('../lib/db.ts')
const { hashPassword } = await import('../lib/auth/password.ts')
const { createSessionToken } = await import('../lib/auth/token.ts')

const prisma = getPrisma()

const HOST_EMAIL = 'host.chat@example.com'
const JOINER_EMAIL = 'alguien.chat@example.com'
const PASSWORD = 'cavallo-grapa-correo-42'
const LUGAR = 'Cafeteria Manual Chat'
const PUERTO = process.env.PORT ?? '3000'

const line = (t) => console.log('\n' + '='.repeat(72) + '\n' + t + '\n' + '='.repeat(72))
const step = (t) => console.log('\n-- ' + t)
const ok = (t) => console.log('   OK   ' + t)

// ------------------------------------------------------------------ reset ---
// Solo sus propios datos, por email y por nombre de lugar. Los planes primero:
// referencian lugar y creador con `onDelete: Restrict`.
const previos = await prisma.user.findMany({
  where: { email: { in: [HOST_EMAIL, JOINER_EMAIL] } },
  select: { id: true },
})
const ids = previos.map((u) => u.id)
if (ids.length) await prisma.plan.deleteMany({ where: { creatorId: { in: ids } } })
await prisma.place.deleteMany({ where: { name: LUGAR } })
if (ids.length) await prisma.user.deleteMany({ where: { id: { in: ids } } })

// ------------------------------------------------------------------- seed ---
step('Siembro lugar, usuarios, plan y una solicitud pendiente')
const place = await prisma.place.create({
  data: {
    name: LUGAR,
    category: 'CAFE',
    latitude: -34.6037,
    longitude: -58.3816,
    timezone: 'America/Argentina/Buenos_Aires',
    verificationStatus: 'APPROVED',
  },
})
ok(`lugar APPROVED ${place.id}`)

const hash = await hashPassword(PASSWORD)

const host = await prisma.user.create({
  data: { email: HOST_EMAIL, name: 'Host Del Chat', passwordHash: hash },
})
await prisma.userRoleAssignment.create({ data: { userId: host.id, role: 'HOST' } })
ok(`host ${HOST_EMAIL}`)

const joiner = await prisma.user.create({
  data: { email: JOINER_EMAIL, name: 'Alguien Del Chat', passwordHash: hash },
})
ok(`se une ${JOINER_EMAIL}`)

const startsAt = new Date(Date.now() + 48 * 3_600_000)
const plan = await prisma.plan.create({
  data: {
    title: 'Cafe para probar el chat a mano',
    description: 'Plan sembrado por scripts/manual-chat-flow.mjs para la pasada manual.',
    placeId: place.id,
    creatorId: host.id,
    startsAt,
    endsAt: new Date(startsAt.getTime() + 3 * 3_600_000),
    capacity: 4,
    // 1 por el organizador, 0 por el postulante todavia: `acceptedCount` lo sube
    // el endpoint de solicitudes al aceptar, no el seed.
    acceptedCount: 1,
    status: 'OPEN',
    participants: {
      create: [
        { userId: host.id, role: 'ORGANIZER', status: 'ACCEPTED' },
        // La peticion PENDIENTE. Es la fila que la pantalla de solicitudes tiene
        // que ver para ofrecer "Aceptar".
        //
        // El `expiresAt` NO es opcional aca, aunque en la base la columna lo sea.
        // `GET /requests` filtra por `expiresAt > now` y descarta las que no lo
        // tienen, porque para el endpoint una peticion sin plazo ya esta
        // resuelta: `POST /join` siempre lo setea a 24h, y una fila con `null`
        // solo puede venir de un seed. Sin esto la pantalla muestra "sin
        // solicitudes pendientes" con la fila ahi, y parece un bug del gate.
        {
          userId: joiner.id,
          role: 'PARTICIPANT',
          status: 'REQUESTED',
          expiresAt: new Date(Date.now() + 24 * 3_600_000),
        },
      ],
    },
  },
})
ok(`plan OPEN ${plan.id}`)
ok(`solicitud REQUESTED de ${joiner.name}, vence en 24h`)

// Un mensaje previo del organizador. Sirve para dos cosas: que la pantalla no
// abra vacia, y que se vea de entrada que la lista ordena bien y que el mensaje
// ajeno NO sale alineado a la derecha.
const semilla = await prisma.message.create({
  data: {
    planId: plan.id,
    authorId: host.id,
    body: 'Bienvenido. Escribi aca si te queda alguna duda con el lugar.',
  },
})
ok(`mensaje semilla ${semilla.id}`)

// ------------------------------------------------------------------ salida ---
const url = `http://localhost:${PUERTO}/planes/${plan.id}`
const hostUrl = `http://localhost:${PUERTO}/host/requests?plan=${plan.id}`

line('Listo. La pasada manual, con DOS perfiles de Edge')
console.log(`   password para los dos: ${PASSWORD}`)
console.log('')
console.log(`   ORGANIZADOR  ${HOST_EMAIL}`)
console.log(`   cookie: ${createSessionToken(host.id)}`)
console.log(`   pantalla:  ${hostUrl}`)
console.log('')
console.log(`   POSTULANTE   ${JOINER_EMAIL}`)
console.log(`   cookie: ${createSessionToken(joiner.id)}`)
console.log(`   pantalla: ${url}`)
console.log('')
console.log('   1. Perfil A (host) entra en la pantalla de solicitudes.')
console.log('   2. Click en "Aceptar". Esperado: la fila desaparece y el contador baja.')
console.log('   3. Perfil B (postulante) recarga el detalle del plan.')
console.log('      Esperado: aparece la seccion "Chat" con el mensaje semilla del host.')
console.log('   4. Perfil B escribe y manda. Esperado: la burbuja propia a la derecha.')
console.log('   5. Perfil A, SIN recargar, espera hasta 3 s. Esperado: aparece el mensaje.')
console.log('      Ese paso es el que verifica el poll con cursor.')
console.log('   6. Perfil A escribe algo. Perfil B lo ve sin recargar.')
console.log('   7. Perfil B scrollea arriba. Llega un mensaje: la lista NO debe saltar.')
console.log('')
console.log('   El chat NO abre para el postulante antes de que el host acepte: esa es')
console.log('   la condicion del gate, y por eso el paso 3 va DESPUES del 2.')

// Una sola linea JSON para los drivers automatizados de la pasada. Va al final
// y sin texto alrededor a proposito: se parsea con un regex, y agregar un
// `console.log` de debug mas arriba no rompe lo que ya estaba andando.
console.log(
  '\nMANUAL_CHAT_JSON=' +
    JSON.stringify({
      planId: plan.id,
      hostCookie: createSessionToken(host.id),
      joinerCookie: createSessionToken(joiner.id),
      url,
      hostUrl,
    }),
)

await prisma.$disconnect()
