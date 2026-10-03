/**
 * Deja la DB de DEV lista para la pasada MANUAL del CIERRE de un plan:
 * marcar asistencia y calificar la experiencia.
 *
 * NO es un test y NO corre en `npm test`: el harness no tiene DOM, asi que ni el
 * click de "Asistio" ni el de "Enviar calificacion" se pueden probar sin
 * navegador. Es la misma razon que `manual-chat-flow.mjs`.
 *
 *   node scripts\manual-closing-flow.mjs
 *
 * La diferencia con el del chat, y es lo importante: el plan esta **terminado**.
 * `startsAt` esta en el pasado y `endsAt` tambien, asi que `planCerrable` da true
 * y las dos secciones aparecen. Con un plan a futuro el manual se pasaria entera
 * mirando una pantalla sin botones, sin ningun error en ninguna parte, que es
 * justamente el fallo que `lib/plan-finished.ts` describe.
 *
 * Los tres participantes arrancan todos en `ACCEPTED`, o sea sin marcar. Asi el
 * manual empieza en el estado en el que el organizador realmente recibe el plan:
 * una lista entera por completar.
 *
 * Imprime las cookies de los cuatro. Se necesitan DOS perfiles de Edge: el
 * organizador marca, y cada participante ve una version distinta de la pantalla.
 * Con un perfil no se puede ver ni la ocultacion de la lista de asistencia ni el
 * voto propio, que son las dos cosas que esta pasada tiene que probar.
 */
import { existsSync } from 'node:fs'

if (existsSync('.env')) process.loadEnvFile('.env')

const { getPrisma } = await import('../lib/db.ts')
const { hashPassword } = await import('../lib/auth/password.ts')
const { createSessionToken } = await import('../lib/auth/token.ts')

const prisma = getPrisma()

const ORGANIZADOR = 'host.cierre@example.com'
const ASISTENTE = 'ana.cierre@example.com'
const AUSENTE = 'beto.cierre@example.com'
const PENDIENTE = 'ciro.cierre@example.com'
const PASSWORD = 'cavallo-grapa-cierre-42'
const LUGAR = 'Cafeteria Manual Cierre'
const PUERTO = process.env.PORT ?? '3000'

const line = (t) => console.log('\n' + '='.repeat(72) + '\n' + t + '\n' + '='.repeat(72))
const step = (t) => console.log('\n-- ' + t)
const ok = (t) => console.log('   OK   ' + t)

// ------------------------------------------------------------------ reset ---
// Solo sus propios datos, por email y por nombre de lugar. Que se pueda correr
// dos veces seguidas es parte del contrato del script, asi que el orden de borrado
// no es un detalle: hay cinco FKs `Restrict` en cadena entre estos usuarios, sus
// participaciones, sus planes, sus votos y sus mensajes, y borrar en el orden
// intuitivo (planes, lugar, personas) revienta con P2003 en el segundo intento.
const EMAILS = [ORGANIZADOR, ASISTENTE, AUSENTE, PENDIENTE]
const previos = await prisma.user.findMany({
  where: { email: { in: EMAILS } },
  select: { id: true },
})
const ids = previos.map((u) => u.id)
if (ids.length) {
  // Ahora el orden es al reves del que uno adivina. `Rating` apunta a la
  // participacion con `onDelete: Restrict` y a `User` con `Restrict`, asi que
  // borrar la fila de participacion con sus hijos vivos es un P2003. Los votos
  // y los mensajes van primero, y solo despues la participacion.
  await prisma.rating.deleteMany({ where: { authorId: { in: ids } } })
  await prisma.message.deleteMany({ where: { authorId: { in: ids } } })
  await prisma.planParticipant.deleteMany({ where: { userId: { in: ids } } })
  await prisma.plan.deleteMany({ where: { creatorId: { in: ids } } })
}
await prisma.place.deleteMany({ where: { name: LUGAR } })
if (ids.length) await prisma.user.deleteMany({ where: { id: { in: ids } } })

// ------------------------------------------------------------------- seed ---
step('Siembro lugar, usuarios y un plan YA TERMINADO')
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
const crearUsuario = async (email, name, roles = []) => {
  const u = await prisma.user.create({ data: { email, name, passwordHash: hash } })
  for (const role of roles) {
    await prisma.userRoleAssignment.create({ data: { userId: u.id, role } })
  }
  return u
}

const host = await crearUsuario(ORGANIZADOR, 'Host Del Cierre', ['HOST'])
ok(`organizador ${ORGANIZADOR}`)
const ana = await crearUsuario(ASISTENTE, 'Ana Asistio')
ok(`asistira ${ASISTENTE}`)
const beto = await crearUsuario(AUSENTE, 'Beto No Vino')
ok(`no va a ir ${AUSENTE}`)
const ciro = await crearUsuario(PENDIENTE, 'Ciro Sin Marcar')
ok(`sin marcar ${PENDIENTE}`)

// Hace tres horas. Pasado el reloj y no "hoy a las 20": si el manual se corre
// cerca de medianoche, un "hoy 20:00" ya paso y la ventana se abre sola, y el
// manual deja de probar el gate. Con un instante relativo, el plan esta
// terminado ahora y en cualquier corrida.
const termina = new Date(Date.now() - 3 * 3_600_000)
const plan = await prisma.plan.create({
  data: {
    title: 'Cafe para probar el cierre a mano',
    description: 'Plan sembrado por scripts/manual-closing-flow.mjs. Ya termino.',
    placeId: place.id,
    creatorId: host.id,
    startsAt: new Date(termina.getTime() - 3 * 3_600_000),
    endsAt: termina,
    capacity: 6,
    // 4, que es la gente que se creo abajo. `acceptedCount` lo sube el endpoint de
    // solicitudes al aceptar, y este seed se saltea ese endpoint: si queda en 0,
    // la pantalla dice "0 de 6 lugares tomados" al lado de una lista de cuatro
    // personas, y el revisor lee un bug donde no lo hay.
    acceptedCount: 4,
    status: 'OPEN',
    participants: {
      create: [
        // El organizador tambien es participante, y organizando tambien se
        // asiste: sin esta fila, la lista de asistencia que el propio
        // organizador completa lo dejaria a el sin marcar para siempre.
        { userId: host.id, role: 'ORGANIZER', status: 'ACCEPTED' },
        { userId: ana.id, role: 'PARTICIPANT', status: 'ACCEPTED' },
        { userId: beto.id, role: 'PARTICIPANT', status: 'ACCEPTED' },
        { userId: ciro.id, role: 'PARTICIPANT', status: 'ACCEPTED' },
      ],
    },
  },
})
ok(`plan TERMINADO ${plan.id}`)
ok('los cuatro arrancan en ACCEPTED: la lista esta entera por marcar')

// ------------------------------------------------------------------ salida ---
const url = `http://localhost:${PUERTO}/planes/${plan.id}`

line('Listo. La pasada manual, con DOS perfiles de Edge')
console.log(`   password para los cuatro: ${PASSWORD}`)
console.log('')
console.log(`   ORGANIZADOR  ${ORGANIZADOR}`)
console.log(`   cookie: ${createSessionToken(host.id)}`)
console.log('')
console.log(`   ANA (asistio)   ${ASISTENTE}`)
console.log(`   cookie: ${createSessionToken(ana.id)}`)
console.log('')
console.log(`   BETO (no vino)  ${AUSENTE}`)
console.log(`   cookie: ${createSessionToken(beto.id)}`)
console.log('')
console.log(`   pantalla de los tres: ${url}`)
console.log('')
console.log('   1. Perfil A (organizador) abre el plan. Tiene que aparecer "Asistencia"')
console.log('      con las cuatro personas en "sin marcar", y "0 de 4".')
console.log('   2. Perfil A marca a Ana "Asistio" y a Beto "No vino". El renglon tiene que')
console.log('      pasar a "Marcaste 2 de 4".')
console.log('   3. Perfil B (Beto) recarga. "Quien va" NO puede listar a Beto, y en la')
console.log('      seccion de calificar dice que no puede calificar. Sin formulario.')
console.log('   4. Perfil C (Ana) recarga. Si marca "Asistio", aparece el formulario con')
console.log('      cinco estrellas y "Todavia no hay calificaciones".')
console.log('   5. Perfil C pone 4 estrellas y marca dos etiquetas, y envia. Tiene que')
console.log('      quedar "4 de 5, de 1 persona" con el conteo de esas dos. Marcar un')
console.log('      cuarto chip no puede: el tope es tres, y los que no entran se apagan.')
console.log('      En toda la seccion no hay ningun textarea.')
console.log('   6. Perfil C recarga: el formulario vuelve precargado con sus dos')
console.log('      etiquetas y el boton dice "Actualizar". Cambiar a 5 y guardar:')
console.log('      "5 de 5, de 1 persona".')
console.log('   7. Perfil A recarga: ve la calificacion de Ana con su nombre y sus')
console.log('      etiquetas. Ese renglon es el que NO tiene que ver Ana ni Beto, que')
console.log('      solo ven el conteo agregado, sin nombres.')
console.log('   8. Con la pestana de red abierta, ningun POST puede responder 4xx.')
console.log('')
// Una sola linea JSON para los drivers automatizados de la pasada. Va al final y
// sin texto alrededor a proposito: se parsea con un regex, y agregar un
// `console.log` de debug mas arriba no rompe lo que ya estaba andando.
console.log(
  '\nMANUAL_CIERRE_JSON=' +
    JSON.stringify({
      planId: plan.id,
      hostCookie: createSessionToken(host.id),
      attendedCookie: createSessionToken(ana.id),
      noShowCookie: createSessionToken(beto.id),
      url,
    }),
)

await prisma.$disconnect()
