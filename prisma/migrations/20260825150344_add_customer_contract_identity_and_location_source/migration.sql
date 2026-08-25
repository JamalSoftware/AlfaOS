-- CreateEnum
CREATE TYPE "CustomerLocationSource" AS ENUM ('MANUAL', 'IMPORTED');

-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "externalContractId" TEXT,
ADD COLUMN     "locationSource" "CustomerLocationSource",
ADD COLUMN     "locationVerified" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "customers_companyId_externalProvider_externalContractId_idx" ON "customers"("companyId", "externalProvider", "externalContractId");
