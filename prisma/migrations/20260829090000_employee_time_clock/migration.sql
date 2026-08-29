-- Jornada / Ponto do funcionario (PRD 226-233).
--
-- ADITIVA. Nenhum DROP, nenhuma coluna existente alterada de forma destrutiva.
--
-- `companies.timezone` entra com DEFAULT: toda empresa existente passa a ter
-- fuso declarado sem backfill, e o default e o do Brasil onde o produto opera.
-- Sem ele, o dia operacional seria calculado em UTC e a jornada da noite cairia
-- no dia seguinte.
--
-- `workdays` tem unique (companyId, userId, date): e ela que garante um dia por
-- pessoa e serve de ancora para a serializacao das batidas.
-- CreateEnum
CREATE TYPE "TimeEntryType" AS ENUM ('CLOCK_IN', 'BREAK_START', 'BREAK_END', 'CLOCK_OUT');

-- CreateEnum
CREATE TYPE "TimeEntrySource" AS ENUM ('FIELD_APP', 'WEB', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "TimeAdjustmentType" AS ENUM ('MISSING_ENTRY', 'WRONG_TIME', 'BREAK', 'OTHER');

-- CreateEnum
CREATE TYPE "TimeAdjustmentStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "companies" ADD COLUMN     "timezone" TEXT NOT NULL DEFAULT 'America/Sao_Paulo';

-- CreateTable
CREATE TABLE "workdays" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "timezone" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workdays_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "time_entries" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workdayId" TEXT NOT NULL,
    "technicianId" TEXT,
    "mobileDeviceId" TEXT,
    "type" "TimeEntryType" NOT NULL,
    "source" "TimeEntrySource" NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "deviceOccurredAt" TIMESTAMP(3),
    "offlineRecordedAt" TIMESTAMP(3),
    "syncReceivedAt" TIMESTAMP(3),
    "latitude" DECIMAL(10,7),
    "longitude" DECIMAL(10,7),
    "accuracyMeters" INTEGER,
    "adjustmentRequestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "time_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "time_adjustment_requests" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workdayId" TEXT NOT NULL,
    "targetEntryId" TEXT,
    "requestedType" "TimeAdjustmentType" NOT NULL,
    "requestedEntryType" "TimeEntryType" NOT NULL,
    "requestedOccurredAt" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "notes" TEXT,
    "requestedById" TEXT NOT NULL,
    "status" "TimeAdjustmentStatus" NOT NULL DEFAULT 'PENDING',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "time_adjustment_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "workdays_companyId_date_idx" ON "workdays"("companyId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "workdays_companyId_userId_date_key" ON "workdays"("companyId", "userId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "time_entries_adjustmentRequestId_key" ON "time_entries"("adjustmentRequestId");

-- CreateIndex
CREATE INDEX "time_entries_companyId_userId_occurredAt_idx" ON "time_entries"("companyId", "userId", "occurredAt");

-- CreateIndex
CREATE INDEX "time_entries_workdayId_occurredAt_idx" ON "time_entries"("workdayId", "occurredAt");

-- CreateIndex
CREATE INDEX "time_adjustment_requests_companyId_status_createdAt_idx" ON "time_adjustment_requests"("companyId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "time_adjustment_requests_workdayId_idx" ON "time_adjustment_requests"("workdayId");

-- AddForeignKey
ALTER TABLE "workdays" ADD CONSTRAINT "workdays_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workdays" ADD CONSTRAINT "workdays_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_workdayId_fkey" FOREIGN KEY ("workdayId") REFERENCES "workdays"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_technicianId_fkey" FOREIGN KEY ("technicianId") REFERENCES "technicians"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_mobileDeviceId_fkey" FOREIGN KEY ("mobileDeviceId") REFERENCES "mobile_devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_adjustmentRequestId_fkey" FOREIGN KEY ("adjustmentRequestId") REFERENCES "time_adjustment_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_adjustment_requests" ADD CONSTRAINT "time_adjustment_requests_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_adjustment_requests" ADD CONSTRAINT "time_adjustment_requests_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_adjustment_requests" ADD CONSTRAINT "time_adjustment_requests_workdayId_fkey" FOREIGN KEY ("workdayId") REFERENCES "workdays"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_adjustment_requests" ADD CONSTRAINT "time_adjustment_requests_targetEntryId_fkey" FOREIGN KEY ("targetEntryId") REFERENCES "time_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_adjustment_requests" ADD CONSTRAINT "time_adjustment_requests_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_adjustment_requests" ADD CONSTRAINT "time_adjustment_requests_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

