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
 * Lugares de Manizales, Caldas, Colombia, con zona horaria `America/Bogota`.
 *
 * La ciudad es Manizales y el centro del mapa tambien (ver `DEFAULT_CENTER` en
 * `lib/map-tiles.ts`). Antes esto era Buenos Aires y el mapa abria ahi: cambiar
 * el seed sin cambiar el centro dejaba la app mirando una ciudad donde no hay
 * nada sembrado, que es el mismo sintoma de "el mapa esta vacio".
 *
 * Estos 8 NO son la curaduria final. Son lugares publicos y reconocibles de la
 * ciudad, elegidos para que el mapa arranque con algo real y no con ocho cafes
 * inventados. La curaduria de verdad (verificarlos, completar el catalogo,
 * sacar los que no sirven) es un paso posterior y manual, no de este archivo.
 *
 * `timezone` NO es opcional en el modelo, asi que cada lugar tiene que declararlo:
 * no hay default, y un lugar sin zona horaria no se puede convertir despues sin
 * adivinar. Manizales no observa horario de verano, asi que el offset es fijo
 * (`-05:00`) todo el ano.
 */
const PLACES = [
  {
    name: 'Monumento a los Nevados', category: 'PARK', lat: 5.0758, lng: -75.5146,
    desc: 'El simbolo de Manizales, en el centro, al pie del cable.',
    traits: { nueva_gente: 0.5, charlas: 0.4, actividad: 0.4, improvisar: 0.6, ambiente_calmo: 0.2 },
  },
  {
    name: 'Parque del Cafe', category: 'PARK', lat: 5.1519, lng: -75.4925,
    desc: 'Paisaje cafetero, mirador y vista del valle desde la montana.',
    traits: { nueva_gente: 0.4, charlas: 0.3, actividad: 1, improvisar: 0.4, ambiente_calmo: 0.5 },
  },
  {
    name: 'Museo de Arte Moderno de Manizales', category: 'MUSEUM', lat: 5.0706, lng: -75.5209,
    desc: null,
    traits: { nueva_gente: 0.4, charlas: 0.3, actividad: 0.8, improvisar: 0.1, ambiente_calmo: 0.7 },
  },
  {
    name: 'Biblioteca Publica Municipal', category: 'LIBRARY', lat: 5.0731, lng: -75.5188,
    desc: null,
    traits: { nueva_gente: 0.1, charlas: 0.2, actividad: 0.1, improvisar: 0, ambiente_calmo: 1 },
  },
  {
    name: 'Universidad de Caldas', category: 'OTHER', lat: 5.0672, lng: -75.5293,
    desc: 'Campus con espacios abiertos y gente nueva todo el tiempo.',
    traits: { nueva_gente: 0.8, charlas: 0.7, actividad: 0.5, improvisar: 0.5, ambiente_calmo: 0.3 },
  },
  {
    name: 'Rio Blanco', category: 'PARK', lat: 5.0745, lng: -75.5298,
    desc: 'El rio que atraviesa la ciudad, con senderos para caminar.',
    // Peso NEGATIVO a proposito: `ambiente_calmo` no es " irrelevante" en un
    // espacio concurrido, es lo contrario de lo que la persona busca. El signo
    // importa y esta sembrado para que la alineacion tenga un caso real de peso
    // negativo y no solo uno inventado en un test.
    traits: { nueva_gente: 0.6, charlas: 0.5, actividad: 0.9, improvisar: 0.8, ambiente_calmo: -0.6 },
  },
  {
    name: 'Cable Plaza', category: 'OTHER', lat: 5.0703, lng: -75.5183,
    desc: null,
    traits: { nueva_gente: 0.5, charlas: 0.4, actividad: 0.4, improvisar: 0.3, ambiente_calmo: 0.2 },
  },
  {
    name: 'Termas de Manizales', category: 'OTHER', lat: 5.0843, lng: -75.5495,
    desc: 'Aguas termales, plan de un finde entero.',
    traits: { nueva_gente: 0.4, charlas: 0.3, actividad: 0.8, improvisar: 0.2, ambiente_calmo: 0.8 },
  },
]

const TZ = 'America/Bogota'

/**
 * `Place.city` es nullable y hasta ahora el seed no la llenaba, con lo cual la
 * columna quedaba sin un solo valor util en toda la base. Se llena aca para que
 * el filtro por ciudad tenga algo que filtrar cuando se agregue: la columna
 * indexada sin datos es exactamente igual a no tenerla.
 */
const CIUDAD = 'Manizales'

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
        latitude: new Prisma.Decimal(p.lat),
        longitude: new Prisma.Decimal(p.lng),
        city: CIUDAD,
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
