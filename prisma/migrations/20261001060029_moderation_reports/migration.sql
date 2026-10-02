-- CreateEnum
CREATE TYPE "ReportTarget" AS ENUM ('PLACE', 'PLAN', 'USER', 'MESSAGE');

-- CreateEnum
CREATE TYPE "ReportReason" AS ENUM ('CLOSED', 'WRONG_INFO', 'UNSAFE', 'NO_SHOW_RISK', 'MISLEADING', 'HARASSMENT', 'SPAM', 'IMPERSONATION', 'OFF_TOPIC', 'OTHER');

-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('OPEN', 'RESOLVED', 'DISMISSED');

-- CreateTable
CREATE TABLE "ModerationReport" (
    "id" TEXT NOT NULL,
    "reporterId" TEXT NOT NULL,
    "target" "ReportTarget" NOT NULL,
    "reason" "ReportReason" NOT NULL,
    "detail" TEXT,
    "status" "ReportStatus" NOT NULL DEFAULT 'OPEN',
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolutionNote" TEXT,
    "placeId" TEXT,
    "planId" TEXT,
    "userId" TEXT,
    "messageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModerationReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ModerationReport_status_createdAt_idx" ON "ModerationReport"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ModerationReport_placeId_idx" ON "ModerationReport"("placeId");

-- CreateIndex
CREATE INDEX "ModerationReport_planId_idx" ON "ModerationReport"("planId");

-- CreateIndex
CREATE INDEX "ModerationReport_userId_idx" ON "ModerationReport"("userId");

-- CreateIndex
CREATE INDEX "ModerationReport_messageId_idx" ON "ModerationReport"("messageId");

-- CreateIndex
CREATE INDEX "ModerationReport_reporterId_idx" ON "ModerationReport"("reporterId");

-- AddForeignKey
ALTER TABLE "ModerationReport" ADD CONSTRAINT "ModerationReport_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModerationReport" ADD CONSTRAINT "ModerationReport_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModerationReport" ADD CONSTRAINT "ModerationReport_placeId_fkey" FOREIGN KEY ("placeId") REFERENCES "Place"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModerationReport" ADD CONSTRAINT "ModerationReport_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModerationReport" ADD CONSTRAINT "ModerationReport_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModerationReport" ADD CONSTRAINT "ModerationReport_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Parte que Prisma no puede expresar. Va en SQL a proposito.
-- ---------------------------------------------------------------------------

-- Exactamente un objetivo.
--
-- Sin esto, las cuatro FKs admiten cero informadas (un reporte a nada) o mas de
-- una (un reporte a un lugar Y a un plan, que la cola no sabe como leer). El
-- CHECK es la unica parte del contrato que la base impone sola: la app puede
-- tener un bug y la base no deja pasar un reporte degenerado.
ALTER TABLE "ModerationReport"
  ADD CONSTRAINT "ModerationReport_exactamente_un_objetivo"
  CHECK (num_nonnulls("placeId", "planId", "userId", "messageId") = 1);

-- Coherencia entre `target` y la FK informada.
--
-- Un `target = 'PLACE'` con `planId` informado no es un caso degenerado de la
-- base: es una fila que se lee bien y se muestra mal, porque la cola agrupa por
-- `target` y luego lee la columna equivocada. Sale de un typo en el endpoint, que
-- es el tipo de bug que no se ve hasta que alguien mira la cola.
ALTER TABLE "ModerationReport"
  ADD CONSTRAINT "ModerationReport_target_coincide"
  CHECK (
    ("target" = 'PLACE'   AND "placeId"   IS NOT NULL) OR
    ("target" = 'PLAN'    AND "planId"    IS NOT NULL) OR
    ("target" = 'USER'    AND "userId"    IS NOT NULL) OR
    ("target" = 'MESSAGE' AND "messageId" IS NOT NULL)
  );

-- Una denuncia por persona y por objetivo.
--
-- Cuatro indices parciales y no un `@@unique([reporterId, target, placeId, ...])`
-- UNICO, porque en Postgres los NULL son distintos entre si: un reporte a un
-- lugar llega como ('ana', 'PLACE', 'lugar-1', NULL, NULL, NULL) y un segundo
-- igual llega con los mismos NULL, que Postgres considera una fila distinta, y
-- el UNIQUE no frena nada. O sea, el UNIQUE de Prisma habria sido un unique
-- que no unica. El `WHERE` sobre `target` es lo que hace que cada indice mire
-- solo las filas de su tipo, y ademas los deja chicos.
--
-- Con esto, denunciar dos veces lo mismo es idempotente en vez de una fila mas en
-- la cola: el endpoint puede responder 409 y la persona no pierde nada, porque
-- el reporte ya estaba.
CREATE UNIQUE INDEX "ModerationReport_una_vez_place"
  ON "ModerationReport" ("reporterId", "placeId") WHERE "target" = 'PLACE';
CREATE UNIQUE INDEX "ModerationReport_una_vez_plan"
  ON "ModerationReport" ("reporterId", "planId") WHERE "target" = 'PLAN';
CREATE UNIQUE INDEX "ModerationReport_una_vez_user"
  ON "ModerationReport" ("reporterId", "userId") WHERE "target" = 'USER';
CREATE UNIQUE INDEX "ModerationReport_una_vez_message"
  ON "ModerationReport" ("reporterId", "messageId") WHERE "target" = 'MESSAGE';

-- La cola se lee por estado y orden de llegada, siempre acotada. Este indice no
-- lo agrega Prisma porque ya existe uno con esos mismos dos campos, y la
-- diferencia es el `DESC`: esta es la unica consulta del producto que los pide
-- al reves ("lo abierto mas viejo primero", que es lo que hay que mirar antes de
-- que se enfríe). Sin esto la cola ordena en memoria.
CREATE INDEX "ModerationReport_cola"
  ON "ModerationReport" ("status", "createdAt" DESC) WHERE "status" = 'OPEN';
