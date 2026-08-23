-- CreateTable
CREATE TABLE "service_order_executions" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "serviceOrderId" TEXT NOT NULL,
    "diagnosis" TEXT,
    "workPerformed" TEXT,
    "notes" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "service_order_executions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "service_order_executions_serviceOrderId_key" ON "service_order_executions"("serviceOrderId");

-- CreateIndex
CREATE INDEX "service_order_executions_companyId_idx" ON "service_order_executions"("companyId");

-- AddForeignKey
ALTER TABLE "service_order_executions" ADD CONSTRAINT "service_order_executions_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_order_executions" ADD CONSTRAINT "service_order_executions_serviceOrderId_fkey" FOREIGN KEY ("serviceOrderId") REFERENCES "service_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
