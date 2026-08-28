-- Estagio de vida da evidencia + vinculo 1:1 da etiqueta.
--
-- ADITIVA. Nenhum DROP, nenhuma coluna alterada de forma destrutiva.
--
-- `status` entra com DEFAULT 'COMMITTED': toda evidencia que ja existe e toda
-- foto anexada pelo caminho normal sao definitivas no instante em que chegam.
-- So a etiqueta do equipamento nasce TEMPORARY, e quem decide isso e o codigo.
--
-- A UNIQUE em labelEvidenceId nao pode falhar na aplicacao: a coluna nasceu
-- nula na migration anterior e nenhum vinculo duplicado e possivel enquanto
-- ela nao existir.

-- CreateEnum
CREATE TYPE "EvidenceStatus" AS ENUM ('TEMPORARY', 'COMMITTED');

-- AlterTable
ALTER TABLE "service_order_evidences" ADD COLUMN     "expiresAt" TIMESTAMP(3),
ADD COLUMN     "status" "EvidenceStatus" NOT NULL DEFAULT 'COMMITTED';

-- CreateIndex
CREATE UNIQUE INDEX "service_order_equipments_labelEvidenceId_key" ON "service_order_equipments"("labelEvidenceId");

-- CreateIndex
CREATE INDEX "service_order_evidences_status_expiresAt_idx" ON "service_order_evidences"("status", "expiresAt");
