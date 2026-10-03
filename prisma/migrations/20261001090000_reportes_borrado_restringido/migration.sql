-- El borrado de un reporte deja de propagarse, y el CHECK de "exactamente un
-- objetivo" deja de pelearse con las FKs.
--
--
-- Que estaba roto
-- ---------------
--
-- Las cuatro FK de objetivo usaban `ON DELETE SET NULL`, y al lado hay un CHECK
-- que exige `num_nonnulls("placeId","planId","userId","messageId") = 1`.
-- `SET NULL` pone la columna en NULL, `num_nonnulls` baja a 0, y el CHECK
-- revienta. Medido sobre esta base, no deducido:
--
--   DELETE de Plan con un reporte abierto
--     -> new row for relation "ModerationReport" violates check constraint
--        "ModerationReport_exactamente_un_objetivo"
--
-- O sea que la accion tipica de una cola de moderacion -- borrar lo reportado --
-- era imposible. No "queda raro" o "deja basura": no se puede. Y el error que
-- llegaba era una violacion de constraint de Postgres en crudo, sin ninguna
-- pista de que el reporte fuera el motivo, porque el `SET NULL` es invisible
-- para quien lee el mensaje.
--
-- `reporterId` era `ON DELETE CASCADE`, que es peor por otra razon: no falla,
-- desaparece. Borrar la cuenta de alguien se llevaba sus reportes. Medido:
-- 3 reportes -> 0. Un rastro de auditoria que se borra solo cuando borra al
-- denunciante no es un rastro de auditoria.
--
-- Que queda
-- ---------
--
-- `RESTRICT` en las cuatro FK de objetivo y en `reporterId`. El borrado duro
-- queda bloqueado, que es el comportamiento correcto y el que ya usa el resto
-- del esquema (`Plan.placeId`, `Plan.creatorId` y compañía son `Restrict`), y
-- la evidencia nunca se nullea ni se cascada.
--
-- No es una perdida de funcionalidad: `Place`, `Plan` y `User` ya tienen
-- `deletedAt`, y el borrado real de la app es el soft delete. Lo que cambia es
-- que cuando alguien intenta el camino destructivo se le dice, en vez de que le
-- reviente una constraint o le borre evidencia en silencio.
--
-- `resolvedById` se queda en `SET NULL` a proposito: es la unica de las cinco
-- que puede perder su dato sin romper nada. Si se borra la cuenta del moderator
-- que cerro un reporte, el reporte sigue ahi con su `resolutionNote`, su
-- `resolvedAt` y su `status`. Perder "quien lo cerro" es tolerable; perder el
-- reporte no.
--
-- Si algun dia el borrado duro se vuelve necesario de verdad, la salida no es
-- aflojar el CHECK: es decidir que pasa con la evidencia (snapshot del titulo
-- del objetivo, o borrar el reporte antes de borrar el contenido) y dejarlo
-- escrito. Este archivo no lo adelanta porque nadie lo pidio.

ALTER TABLE "ModerationReport" DROP CONSTRAINT "ModerationReport_reporterId_fkey";
ALTER TABLE "ModerationReport" ADD CONSTRAINT "ModerationReport_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ModerationReport" DROP CONSTRAINT "ModerationReport_placeId_fkey";
ALTER TABLE "ModerationReport" ADD CONSTRAINT "ModerationReport_placeId_fkey" FOREIGN KEY ("placeId") REFERENCES "Place"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ModerationReport" DROP CONSTRAINT "ModerationReport_planId_fkey";
ALTER TABLE "ModerationReport" ADD CONSTRAINT "ModerationReport_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ModerationReport" DROP CONSTRAINT "ModerationReport_userId_fkey";
ALTER TABLE "ModerationReport" ADD CONSTRAINT "ModerationReport_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ModerationReport" DROP CONSTRAINT "ModerationReport_messageId_fkey";
ALTER TABLE "ModerationReport" ADD CONSTRAINT "ModerationReport_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Las FKs que Prisma no puede expresar siguen igual, y esta migracion las deja
-- intactas a proposito. El CHECK `ModerationReport_exactamente_un_objetivo` ya
-- no se opone a ninguna FK, asi que ahora trabaja: valida los INSERT y no
-- bloquea los DELETE que no lo tocan.