-- CreateEnum
CREATE TYPE "EvidenceKind" AS ENUM ('PHOTO');

-- CreateEnum
CREATE TYPE "MaterialUnit" AS ENUM ('UNIT', 'METER', 'KILOGRAM', 'LITER');

-- CreateTable
CREATE TABLE "service_order_evidences" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "serviceOrderId" TEXT NOT NULL,
    "uploadedByUserId" TEXT,
    "kind" "EvidenceKind" NOT NULL DEFAULT 'PHOTO',
    "storageKey" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_order_evidences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_order_material_usages" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "serviceOrderId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(10,3) NOT NULL,
    "unit" "MaterialUnit" NOT NULL DEFAULT 'UNIT',
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "service_order_material_usages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_order_signatures" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "serviceOrderId" TEXT NOT NULL,
    "signerName" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "signedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "capturedByUserId" TEXT,

    CONSTRAINT "service_order_signatures_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "service_order_evidences_storageKey_key" ON "service_order_evidences"("storageKey");

-- CreateIndex
CREATE INDEX "service_order_evidences_serviceOrderId_createdAt_idx" ON "service_order_evidences"("serviceOrderId", "createdAt");

-- CreateIndex
CREATE INDEX "service_order_evidences_companyId_idx" ON "service_order_evidences"("companyId");

-- CreateIndex
CREATE INDEX "service_order_material_usages_serviceOrderId_createdAt_idx" ON "service_order_material_usages"("serviceOrderId", "createdAt");

-- CreateIndex
CREATE INDEX "service_order_material_usages_companyId_idx" ON "service_order_material_usages"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "service_order_signatures_serviceOrderId_key" ON "service_order_signatures"("serviceOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "service_order_signatures_storageKey_key" ON "service_order_signatures"("storageKey");

-- CreateIndex
CREATE INDEX "service_order_signatures_companyId_idx" ON "service_order_signatures"("companyId");

-- AddForeignKey
ALTER TABLE "service_order_evidences" ADD CONSTRAINT "service_order_evidences_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_order_evidences" ADD CONSTRAINT "service_order_evidences_serviceOrderId_fkey" FOREIGN KEY ("serviceOrderId") REFERENCES "service_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_order_evidences" ADD CONSTRAINT "service_order_evidences_uploadedByUserId_fkey" FOREIGN KEY ("uploadedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_order_material_usages" ADD CONSTRAINT "service_order_material_usages_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_order_material_usages" ADD CONSTRAINT "service_order_material_usages_serviceOrderId_fkey" FOREIGN KEY ("serviceOrderId") REFERENCES "service_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_order_material_usages" ADD CONSTRAINT "service_order_material_usages_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_order_signatures" ADD CONSTRAINT "service_order_signatures_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_order_signatures" ADD CONSTRAINT "service_order_signatures_serviceOrderId_fkey" FOREIGN KEY ("serviceOrderId") REFERENCES "service_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_order_signatures" ADD CONSTRAINT "service_order_signatures_capturedByUserId_fkey" FOREIGN KEY ("capturedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
