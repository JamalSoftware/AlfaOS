-- CreateEnum
CREATE TYPE "ConnectivityStatus" AS ENUM ('ONLINE', 'OFFLINE', 'UNKNOWN');

-- CreateTable
CREATE TABLE "customer_diagnostic_snapshots" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "externalProvider" "ERPProvider" NOT NULL,
    "connectivityStatus" "ConnectivityStatus" NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "sourceUpdatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_diagnostic_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customer_diagnostic_snapshots_companyId_idx" ON "customer_diagnostic_snapshots"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "customer_diagnostic_snapshots_companyId_customerId_external_key" ON "customer_diagnostic_snapshots"("companyId", "customerId", "externalProvider");

-- AddForeignKey
ALTER TABLE "customer_diagnostic_snapshots" ADD CONSTRAINT "customer_diagnostic_snapshots_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_diagnostic_snapshots" ADD CONSTRAINT "customer_diagnostic_snapshots_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
