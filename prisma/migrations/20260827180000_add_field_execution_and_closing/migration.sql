-- CreateEnum
CREATE TYPE "LocationChangeKind" AS ENUM ('ADDRESS', 'COORDINATES', 'BOTH');

-- CreateEnum
CREATE TYPE "LocationChangeReason" AS ENUM ('INCORRECT_ADDRESS', 'INCORRECT_LOCATION', 'CUSTOMER_MOVED', 'INCOMPLETE_REGISTRATION', 'OTHER');

-- CreateEnum
CREATE TYPE "CheckInSource" AS ENUM ('DEVICE_GPS', 'UNAVAILABLE');

-- CreateEnum
CREATE TYPE "EvidenceCategory" AS ENUM ('BEFORE_SERVICE', 'INSTALLATION_LOCATION', 'CABLE_ROUTE', 'CTO', 'ONU_ONT', 'ROUTER', 'EQUIPMENT', 'OPTICAL_READING', 'WIFI_TEST', 'SPEED_TEST', 'AFTER_SERVICE', 'OTHER');

-- CreateEnum
CREATE TYPE "ChecklistItemType" AS ENUM ('BOOLEAN', 'TEXT', 'NUMBER', 'SELECT', 'PHOTO');

-- CreateEnum
CREATE TYPE "InventoryMovementType" AS ENUM ('WAREHOUSE_TO_TECHNICIAN', 'TECHNICIAN_TO_CUSTOMER', 'TECHNICIAN_TO_WAREHOUSE', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT');

-- CreateEnum
CREATE TYPE "ContactAttemptChannel" AS ENUM ('PHONE_CALL', 'WHATSAPP', 'SMS', 'OTHER');

-- CreateEnum
CREATE TYPE "ContactAttemptResult" AS ENUM ('ANSWERED', 'NO_ANSWER', 'BUSY', 'INVALID_NUMBER', 'CUSTOMER_REQUESTED_LATER');

-- CreateEnum
CREATE TYPE "ImpedimentReason" AS ENUM ('CUSTOMER_ABSENT', 'CUSTOMER_NOT_ANSWERING', 'NO_ACCESS', 'MISSING_MATERIAL', 'EXTERNAL_NETWORK_ISSUE', 'WEATHER', 'NEED_SECOND_TECHNICIAN', 'NEED_SPECIAL_EQUIPMENT', 'SAFETY_RISK', 'OTHER');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "CustomerLocationSource" ADD VALUE 'GEOCODED';
ALTER TYPE "CustomerLocationSource" ADD VALUE 'TECHNICIAN_GPS';

-- AlterTable
ALTER TABLE "service_order_evidences" ADD COLUMN     "caption" TEXT,
ADD COLUMN     "capturedAt" TIMESTAMP(3),
ADD COLUMN     "category" "EvidenceCategory" NOT NULL DEFAULT 'OTHER',
ADD COLUMN     "contentHash" TEXT;

-- AlterTable
ALTER TABLE "service_order_executions" ADD COLUMN     "checklistTemplateId" TEXT,
ADD COLUMN     "checklistTemplateVersion" INTEGER;

-- AlterTable
ALTER TABLE "service_order_signatures" ADD COLUMN     "signedContentHash" TEXT,
ADD COLUMN     "signedOrderVersion" INTEGER;

-- CreateTable
CREATE TABLE "customer_locations" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "latitude" DECIMAL(10,7) NOT NULL,
    "longitude" DECIMAL(10,7) NOT NULL,
    "accuracyMeters" INTEGER,
    "source" "CustomerLocationSource" NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "verifiedAt" TIMESTAMP(3),
    "verifiedByUserId" TEXT,
    "verifiedByTechnicianId" TEXT,
    "reference" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_location_histories" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "serviceOrderId" TEXT,
    "kind" "LocationChangeKind" NOT NULL,
    "reason" "LocationChangeReason" NOT NULL,
    "note" TEXT,
    "previousLatitude" DECIMAL(10,7),
    "previousLongitude" DECIMAL(10,7),
    "previousSource" "CustomerLocationSource",
    "previousVerified" BOOLEAN,
    "newLatitude" DECIMAL(10,7),
    "newLongitude" DECIMAL(10,7),
    "newSource" "CustomerLocationSource",
    "newVerified" BOOLEAN,
    "previousAddress" JSONB,
    "newAddress" JSONB,
    "changedByUserId" TEXT,
    "technicianId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_location_histories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_order_check_ins" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "serviceOrderId" TEXT NOT NULL,
    "technicianId" TEXT NOT NULL,
    "latitude" DECIMAL(10,7),
    "longitude" DECIMAL(10,7),
    "accuracyMeters" INTEGER,
    "source" "CheckInSource" NOT NULL,
    "distanceMeters" INTEGER,
    "checkedInAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_order_check_ins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "checklist_templates" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "serviceOrderTypeId" TEXT,
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "checklist_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "checklist_template_items" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "type" "ChecklistItemType" NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "options" JSONB,
    "evidenceCategory" "EvidenceCategory",
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "checklist_template_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_order_checklist_items" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "serviceOrderId" TEXT NOT NULL,
    "templateItemId" TEXT,
    "templateId" TEXT,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "type" "ChecklistItemType" NOT NULL,
    "required" BOOLEAN NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "options" JSONB,
    "evidenceCategory" "EvidenceCategory",
    "valueBoolean" BOOLEAN,
    "valueText" TEXT,
    "valueNumber" DECIMAL(14,4),
    "answeredAt" TIMESTAMP(3),
    "answeredByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "service_order_checklist_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_items" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unit" "MaterialUnit" NOT NULL DEFAULT 'UNIT',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_movements" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "type" "InventoryMovementType" NOT NULL,
    "quantity" DECIMAL(10,3) NOT NULL,
    "technicianId" TEXT,
    "serviceOrderId" TEXT,
    "createdByUserId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_order_equipments" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "serviceOrderId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "equipmentType" TEXT NOT NULL,
    "manufacturer" TEXT,
    "model" TEXT,
    "serial" TEXT,
    "macAddress" TEXT,
    "notes" TEXT,
    "installedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "service_order_equipments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_order_contact_attempts" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "serviceOrderId" TEXT NOT NULL,
    "technicianId" TEXT NOT NULL,
    "channel" "ContactAttemptChannel" NOT NULL,
    "result" "ContactAttemptResult" NOT NULL,
    "notes" TEXT,
    "attemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_order_contact_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_order_impediments" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "serviceOrderId" TEXT NOT NULL,
    "technicianId" TEXT NOT NULL,
    "reason" "ImpedimentReason" NOT NULL,
    "notes" TEXT,
    "reportedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_order_impediments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_order_completion_policies" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "serviceOrderTypeId" TEXT NOT NULL,
    "requireChecklist" BOOLEAN NOT NULL DEFAULT false,
    "requireSignature" BOOLEAN NOT NULL DEFAULT false,
    "requireMaterials" BOOLEAN NOT NULL DEFAULT false,
    "requireEquipment" BOOLEAN NOT NULL DEFAULT false,
    "requireCheckIn" BOOLEAN NOT NULL DEFAULT false,
    "minEvidenceCount" INTEGER NOT NULL DEFAULT 0,
    "requiredEvidenceCategories" "EvidenceCategory"[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "service_order_completion_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_order_completions" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "serviceOrderId" TEXT NOT NULL,
    "technicianId" TEXT NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL,
    "orderVersionAtCompletion" INTEGER NOT NULL,
    "contentHash" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_order_completions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "customer_locations_customerId_key" ON "customer_locations"("customerId");

-- CreateIndex
CREATE INDEX "customer_locations_companyId_idx" ON "customer_locations"("companyId");

-- CreateIndex
CREATE INDEX "customer_locations_companyId_verified_idx" ON "customer_locations"("companyId", "verified");

-- CreateIndex
CREATE INDEX "customer_location_histories_companyId_customerId_createdAt_idx" ON "customer_location_histories"("companyId", "customerId", "createdAt");

-- CreateIndex
CREATE INDEX "customer_location_histories_companyId_createdAt_idx" ON "customer_location_histories"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "customer_location_histories_serviceOrderId_idx" ON "customer_location_histories"("serviceOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "service_order_check_ins_serviceOrderId_key" ON "service_order_check_ins"("serviceOrderId");

-- CreateIndex
CREATE INDEX "service_order_check_ins_companyId_technicianId_checkedInAt_idx" ON "service_order_check_ins"("companyId", "technicianId", "checkedInAt");

-- CreateIndex
CREATE INDEX "checklist_templates_companyId_active_idx" ON "checklist_templates"("companyId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "checklist_templates_companyId_serviceOrderTypeId_key" ON "checklist_templates"("companyId", "serviceOrderTypeId");

-- CreateIndex
CREATE INDEX "checklist_template_items_templateId_sortOrder_idx" ON "checklist_template_items"("templateId", "sortOrder");

-- CreateIndex
CREATE INDEX "checklist_template_items_companyId_idx" ON "checklist_template_items"("companyId");

-- CreateIndex
CREATE INDEX "service_order_checklist_items_serviceOrderId_sortOrder_idx" ON "service_order_checklist_items"("serviceOrderId", "sortOrder");

-- CreateIndex
CREATE INDEX "service_order_checklist_items_companyId_idx" ON "service_order_checklist_items"("companyId");

-- CreateIndex
CREATE INDEX "inventory_items_companyId_active_idx" ON "inventory_items"("companyId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_items_companyId_code_key" ON "inventory_items"("companyId", "code");

-- CreateIndex
CREATE INDEX "inventory_movements_companyId_itemId_technicianId_idx" ON "inventory_movements"("companyId", "itemId", "technicianId");

-- CreateIndex
CREATE INDEX "inventory_movements_serviceOrderId_idx" ON "inventory_movements"("serviceOrderId");

-- CreateIndex
CREATE INDEX "inventory_movements_companyId_createdAt_idx" ON "inventory_movements"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "service_order_equipments_serviceOrderId_idx" ON "service_order_equipments"("serviceOrderId");

-- CreateIndex
CREATE INDEX "service_order_equipments_companyId_customerId_idx" ON "service_order_equipments"("companyId", "customerId");

-- CreateIndex
CREATE UNIQUE INDEX "service_order_equipments_companyId_serial_key" ON "service_order_equipments"("companyId", "serial");

-- CreateIndex
CREATE UNIQUE INDEX "service_order_equipments_companyId_macAddress_key" ON "service_order_equipments"("companyId", "macAddress");

-- CreateIndex
CREATE INDEX "service_order_contact_attempts_serviceOrderId_attemptedAt_idx" ON "service_order_contact_attempts"("serviceOrderId", "attemptedAt");

-- CreateIndex
CREATE INDEX "service_order_contact_attempts_companyId_idx" ON "service_order_contact_attempts"("companyId");

-- CreateIndex
CREATE INDEX "service_order_impediments_serviceOrderId_reportedAt_idx" ON "service_order_impediments"("serviceOrderId", "reportedAt");

-- CreateIndex
CREATE INDEX "service_order_impediments_companyId_idx" ON "service_order_impediments"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "service_order_completion_policies_serviceOrderTypeId_key" ON "service_order_completion_policies"("serviceOrderTypeId");

-- CreateIndex
CREATE INDEX "service_order_completion_policies_companyId_idx" ON "service_order_completion_policies"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "service_order_completions_serviceOrderId_key" ON "service_order_completions"("serviceOrderId");

-- CreateIndex
CREATE INDEX "service_order_completions_companyId_completedAt_idx" ON "service_order_completions"("companyId", "completedAt");

-- CreateIndex
CREATE INDEX "service_order_evidences_serviceOrderId_category_idx" ON "service_order_evidences"("serviceOrderId", "category");

-- CreateIndex
CREATE INDEX "service_order_evidences_serviceOrderId_contentHash_idx" ON "service_order_evidences"("serviceOrderId", "contentHash");

-- AddForeignKey
ALTER TABLE "customer_locations" ADD CONSTRAINT "customer_locations_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_locations" ADD CONSTRAINT "customer_locations_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_locations" ADD CONSTRAINT "customer_locations_verifiedByUserId_fkey" FOREIGN KEY ("verifiedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_locations" ADD CONSTRAINT "customer_locations_verifiedByTechnicianId_fkey" FOREIGN KEY ("verifiedByTechnicianId") REFERENCES "technicians"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_location_histories" ADD CONSTRAINT "customer_location_histories_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_location_histories" ADD CONSTRAINT "customer_location_histories_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_location_histories" ADD CONSTRAINT "customer_location_histories_serviceOrderId_fkey" FOREIGN KEY ("serviceOrderId") REFERENCES "service_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_location_histories" ADD CONSTRAINT "customer_location_histories_changedByUserId_fkey" FOREIGN KEY ("changedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_location_histories" ADD CONSTRAINT "customer_location_histories_technicianId_fkey" FOREIGN KEY ("technicianId") REFERENCES "technicians"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_order_check_ins" ADD CONSTRAINT "service_order_check_ins_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_order_check_ins" ADD CONSTRAINT "service_order_check_ins_serviceOrderId_fkey" FOREIGN KEY ("serviceOrderId") REFERENCES "service_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_order_check_ins" ADD CONSTRAINT "service_order_check_ins_technicianId_fkey" FOREIGN KEY ("technicianId") REFERENCES "technicians"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checklist_templates" ADD CONSTRAINT "checklist_templates_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checklist_templates" ADD CONSTRAINT "checklist_templates_serviceOrderTypeId_fkey" FOREIGN KEY ("serviceOrderTypeId") REFERENCES "service_order_types"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checklist_template_items" ADD CONSTRAINT "checklist_template_items_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checklist_template_items" ADD CONSTRAINT "checklist_template_items_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "checklist_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_order_checklist_items" ADD CONSTRAINT "service_order_checklist_items_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_order_checklist_items" ADD CONSTRAINT "service_order_checklist_items_serviceOrderId_fkey" FOREIGN KEY ("serviceOrderId") REFERENCES "service_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_order_checklist_items" ADD CONSTRAINT "service_order_checklist_items_answeredByUserId_fkey" FOREIGN KEY ("answeredByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "inventory_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_technicianId_fkey" FOREIGN KEY ("technicianId") REFERENCES "technicians"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_serviceOrderId_fkey" FOREIGN KEY ("serviceOrderId") REFERENCES "service_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_order_equipments" ADD CONSTRAINT "service_order_equipments_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_order_equipments" ADD CONSTRAINT "service_order_equipments_serviceOrderId_fkey" FOREIGN KEY ("serviceOrderId") REFERENCES "service_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_order_equipments" ADD CONSTRAINT "service_order_equipments_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_order_equipments" ADD CONSTRAINT "service_order_equipments_installedByUserId_fkey" FOREIGN KEY ("installedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_order_contact_attempts" ADD CONSTRAINT "service_order_contact_attempts_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_order_contact_attempts" ADD CONSTRAINT "service_order_contact_attempts_serviceOrderId_fkey" FOREIGN KEY ("serviceOrderId") REFERENCES "service_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_order_contact_attempts" ADD CONSTRAINT "service_order_contact_attempts_technicianId_fkey" FOREIGN KEY ("technicianId") REFERENCES "technicians"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_order_impediments" ADD CONSTRAINT "service_order_impediments_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_order_impediments" ADD CONSTRAINT "service_order_impediments_serviceOrderId_fkey" FOREIGN KEY ("serviceOrderId") REFERENCES "service_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_order_impediments" ADD CONSTRAINT "service_order_impediments_technicianId_fkey" FOREIGN KEY ("technicianId") REFERENCES "technicians"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_order_completion_policies" ADD CONSTRAINT "service_order_completion_policies_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_order_completion_policies" ADD CONSTRAINT "service_order_completion_policies_serviceOrderTypeId_fkey" FOREIGN KEY ("serviceOrderTypeId") REFERENCES "service_order_types"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_order_completions" ADD CONSTRAINT "service_order_completions_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_order_completions" ADD CONSTRAINT "service_order_completions_serviceOrderId_fkey" FOREIGN KEY ("serviceOrderId") REFERENCES "service_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_order_completions" ADD CONSTRAINT "service_order_completions_technicianId_fkey" FOREIGN KEY ("technicianId") REFERENCES "technicians"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Template padrao da empresa: no maximo UM por empresa.
--
-- A unique composta (companyId, serviceOrderTypeId) gerada acima NAO cobre o
-- template padrao. Em PostgreSQL dois NULLs sao distintos entre si, entao
-- aquela constraint deixaria a mesma empresa acumular varias linhas com
-- serviceOrderTypeId IS NULL — e "o template padrao da empresa" passaria a
-- depender de qual delas a consulta ordenasse primeiro.
--
-- Indice PARCIAL porque a regra so vale para a linha padrao; templates com
-- tipo continuam arbitrados pela unique composta.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "checklist_templates_company_default_key"
  ON "checklist_templates"("companyId")
  WHERE "serviceOrderTypeId" IS NULL;
