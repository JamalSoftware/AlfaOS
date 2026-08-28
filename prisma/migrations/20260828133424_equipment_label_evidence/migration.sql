-- AlterEnum
ALTER TYPE "EvidenceCategory" ADD VALUE 'EQUIPMENT_LABEL';

-- AlterTable
ALTER TABLE "service_order_equipments" ADD COLUMN     "labelEvidenceId" TEXT;

-- AddForeignKey
ALTER TABLE "service_order_equipments" ADD CONSTRAINT "service_order_equipments_labelEvidenceId_fkey" FOREIGN KEY ("labelEvidenceId") REFERENCES "service_order_evidences"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
