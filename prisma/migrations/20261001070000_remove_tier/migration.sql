-- Nexa es gratis: se van los dos campos del tier y el enum que los sostenia.
--
-- Los `IF EXISTS` no son pereza: la primera corrida de esta migracion quedo a
-- medias (la aplicacion fallo por el BOM del archivo) y sin ellos volver a
-- correrla revienta contra un estado que ella misma ya dejo. Prisma corre las
-- migraciones en el orden del directorio y no tiene forma de saber que una
-- quedo partially applied.
--
-- El `DROP TYPE` va ultimo y es el que no se puede omitir: borrar la columna NO
-- borra el enum en Postgres. Sin esta linea el tipo `PlanTier` sobrevive como
-- esquema muerto, invisible para Prisma porque ya nadie lo referencia, y el
-- proximo que abra la base lo encuentra sin saber de donde salio.

DROP INDEX IF EXISTS "User_planTier_idx";

ALTER TABLE "User" DROP COLUMN IF EXISTS "planTier",
DROP COLUMN IF EXISTS "premiumUntil";

DROP TYPE IF EXISTS "PlanTier";