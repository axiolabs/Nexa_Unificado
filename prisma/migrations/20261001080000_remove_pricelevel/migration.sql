-- Nexa es gratis, asi que un lugar no tiene "nivel de precio": el filtro de
-- precio del mapa era una decision de negocio que ya no aplica.
--
-- El indice compuesto cambia de 3 columnas a 2. No es cosmetico: con
-- `priceLevel` en el indice, la columna eliminada lo arrastra y el indice deja
-- de existir, asi que el planner pierde el camino para "verificados de esta
-- categoria" y vuelve a seq scan sobre la tabla.
--
-- Igual que en la migracion anterior, todo es `IF EXISTS`/`IF NOT EXISTS` para
-- que una corrida a medias se pueda volver a aplicar.

DROP INDEX IF EXISTS "Place_verificationStatus_category_priceLevel_idx";

ALTER TABLE "Place" DROP COLUMN IF EXISTS "priceLevel";

CREATE INDEX IF NOT EXISTS "Place_verificationStatus_category_idx"
  ON "Place"("verificationStatus", "category");

-- La columna no existia todavia cuando se creo el enum, pero el `CREATE TYPE` de
-- la migracion inicial si, y Postgres no lo borra solo.
DROP TYPE IF EXISTS "PriceLevel";