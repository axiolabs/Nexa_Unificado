/**
 * Seed de lugares y del test de personalidad.
 *
 * Los lugares NO los crea la gente desde el mapa: son curados. `Place` arranca
 * en `verificationStatus = PENDING` y `ownerId` es opcional. El flujo real es
 * "alguien propone, curaduria aprueba", y por eso el seed los crea ya
 * `APPROVED`: si los creara `PENDING`, el mapa no mostraria nada y no habria
 * forma de ver la feature.
 *
 * El test de personalidad va en el mismo seed y no en otro comando por una razon
 * practica: la pantalla del test lee el test activo, y si `db:seed` no lo crea,
 * `npm run dev` en una base nueva muestra un 404 en una pantalla que el flujo de
 * registro manda a hacer. Un paso que obliga a acordarse de correr un segundo
 * comando antes de poder seguir es un paso que nadie va a hacer.
 *
 * El contenido del test esta en `prisma/personality-v1.mjs` y lo comparten el
 * seed y los tests, para que no haya dos versiones distintas de "el test".
 *
 * Escribe con Prisma Client, no con SQL crudo, y por eso no hace falta pasar
 * `id` ni `createdAt` a mano: los defaults de Prisma si existen aca (a
 * diferencia de en SQL crudo, donde habria que inventarlos).
 *
 * Es idempotente por `name` en los lugares y por `key`/`version` en el test:
 * correrlo dos veces no duplica ni borra resultados ya completados.
 *
 *   npm run db:seed
 */
import { Prisma, PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { existsSync } from 'node:fs'
import { sembrarTestV1 } from './personality-v1.mjs'

if (existsSync('.env')) process.loadEnvFile('.env')

const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL no esta definido')
  process.exit(1)
}

const adapter = new PrismaPg({ connectionString: url })
const prisma = new PrismaClient({ adapter })

/**
 * Coordenadas reales de Buenos Aires, con la zona horaria `America/Argentina/
 * Buenos_Aires`. `timezone` NO es opcional en el modelo, asi que cada lugar
 * tiene que declararlo: no hay default, y un lugar sin zona horaria no puede
 * convertirse despues sin adivinar.
 */
const PLACES = [
  {
    name: 'Cafe Tortuga', category: 'CAFE', priceLevel: 'LOW', lat: -34.6037, lng: -58.3816,
    desc: 'Cafe de especialidad en San Telmo.',
    traits: { nueva_gente: 0.3, charlas: 0.7, actividad: 0.1, improvisar: 0.1, ambiente_calmo: 0.8 },
  },
  {
    name: 'Museo de Arte Moderno', category: 'MUSEUM', priceLevel: 'FREE', lat: -34.6106, lng: -58.3995,
    desc: null,
    traits: { nueva_gente: 0.4, charlas: 0.3, actividad: 0.9, improvisar: 0.1, ambiente_calmo: 0.7 },
  },
  {
    name: 'Parque Centenario', category: 'PARK', priceLevel: 'FREE', lat: -34.6058, lng: -58.4352,
    desc: 'Parque grande, con cancha y area para picnic.',
    traits: { nueva_gente: 0.5, charlas: 0.4, actividad: 1, improvisar: 0.8, ambiente_calmo: -0.2 },
  },
  {
    name: 'Libreria El Ateneo', category: 'LIBRARY', priceLevel: 'MEDIUM', lat: -34.5987, lng: -58.3947,
    desc: null,
    traits: { nueva_gente: 0.1, charlas: 0.2, actividad: 0.1, improvisar: 0, ambiente_calmo: 1 },
  },
  {
    name: 'Bar El Clan', category: 'BAR', priceLevel: 'LOW', lat: -34.6083, lng: -58.3724,
    desc: null,
    // Peso NEGATIVO a proposito: el ambiente calmo no es " irrelevante" en un
    // bar concurrido, es lo contrario de lo que la persona busca. El signo
    // importa y esta sembrado para que la alineacion tenga un caso real de
    // peso negativo y no solo uno inventado en un test.
    traits: { nueva_gente: 0.8, charlas: 0.9, actividad: 0.1, improvisar: 0.9, ambiente_calmo: -0.7 },
  },
  {
    name: 'Taller de Ceramica', category: 'WORKSHOP', priceLevel: 'MEDIUM', lat: -34.5891, lng: -58.3826,
    desc: 'Taller de fin de semana.',
    traits: { nueva_gente: 0.4, charlas: 0.2, actividad: 1, improvisar: 0.5, ambiente_calmo: 0.6 },
  },
  {
    name: 'La Carniceria', category: 'RESTAURANT', priceLevel: 'HIGH', lat: -34.5917, lng: -58.3720,
    desc: null,
    traits: { nueva_gente: 0.6, charlas: 0.5, actividad: 0.1, improvisar: 0.2, ambiente_calmo: 0.5 },
  },
  {
    name: 'Club de Natacion', category: 'SPORTS', priceLevel: 'LOW', lat: -34.5765, lng: -58.4200,
    desc: null,
    traits: { nueva_gente: 0.4, charlas: 0.2, actividad: 1, improvisar: 0.1, ambiente_calmo: 0.3 },
  },
]

const TZ = 'America/Argentina/Buenos_Aires'

// Los `Trait` se siembran PRIMERO. `PlaceTrait` referencia `Trait.id`, asi que
// sin esas filas no hay a que apuntar y ningun lugar puede tener rasgos. El
// orden inverso era el que hacia que la alineacion saliera siempre vacia.
const test = await sembrarTestV1(prisma)
console.log(
  test.yaExistia
    ? `[seed] test v1 (id ${test.testId}) ya existia`
    : `[seed] test v1 creado: ${test.questions} preguntas, ${test.options} opciones`,
)

const traitRows = await prisma.trait.findMany({ select: { id: true, key: true } })
const traitIdByKey = new Map(traitRows.map((t) => [t.key, t.id]))

let created = 0
let existing = 0
let pesos = 0

for (const p of PLACES) {
  const found = await prisma.place.findFirst({ where: { name: p.name } })
  const place =
    found ??
    (await prisma.place.create({
      data: {
        name: p.name,
        description: p.desc,
        category: p.category,
        priceLevel: p.priceLevel,
        latitude: new Prisma.Decimal(p.lat),
        longitude: new Prisma.Decimal(p.lng),
        timezone: TZ,
        verificationStatus: 'APPROVED',
        verifiedAt: new Date(),
      },
    }))

  if (found) existing++
  else created++

  // Los pesos se escriben SIEMPRE, tambien en un lugar que ya existia. Con el
  // `continue` que habia antes, un lugar sembrado en una corrida anterior se
  // salteaba para siempre: el seed era idempotente para el lugar pero no para
  // lo que el lugar significa, y por eso los rasgos nunca aparecian.
  for (const [key, weight] of Object.entries(p.traits)) {
    const traitId = traitIdByKey.get(key)
    if (!traitId) throw new Error(`el trait "${key}" no esta sembrado`)
    await prisma.placeTrait.upsert({
      where: { placeId_traitId: { placeId: place.id, traitId } },
      create: { placeId: place.id, traitId, weight },
      update: { weight },
    })
    pesos++
  }
}

console.log(`[seed] lugares: ${created} creados, ${existing} ya existian`)
console.log(`[seed] pesos de lugar: ${pesos} escritos`)

await prisma.$disconnect()
