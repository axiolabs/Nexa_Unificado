-- Etiquetas cerradas en vez de texto libre.
--
-- Se reemplaza `Rating.comment` (`String?`, hasta 500 caracteres) por
-- `Rating.tags` (`String[]`, de un set de ocho ids que valida el endpoint).
--
-- **El `DROP COLUMN` descarta a proposito los valores que hubiera.** No es un
-- descuido de una migracion: el texto libre era el problema. `Rating` no lleva
-- `ratedUserId` porque la decision de §5.9 de `docs/modelo-datos.md` es
-- estructural — nada en el modelo puede afirmar que una persona es tal — y un
-- `String?` con el nombre del autor al lado deshace esa garantia sin reemplazarla
-- por ninguna. Con `ModerationReport` diferido a proposito no hay ni forma de
-- denunciar ni de sacar de circulacion lo que se escriba ahi, y para el publico
-- objetivo (ansiedad social, vulnerabilidad a exposicion) eso es un vector de
-- dano real.
--
-- Migrar el texto a ids no se puede hacer de forma automatica: no hay forma
-- honesta de decidir si "se me hizo tarde" es `faltaron_espacios` o una queja
-- sobre el lugar, y adivinarlo seria inventar el dato. Las filas que existian
-- pierden sus etiquetas y conservan su `rating`, que es el numero que todavia
-- significa algo.

-- AlterTable
ALTER TABLE "Rating" ADD COLUMN "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "Rating" DROP COLUMN "comment";
