-- CreateEnum
CREATE TYPE "CustomerConnectionType" AS ENUM ('PPPOE');

-- CreateTable
CREATE TABLE "customer_connections" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "type" "CustomerConnectionType" NOT NULL DEFAULT 'PPPOE',
    "username" TEXT NOT NULL,
    "credentialCiphertext" TEXT,
    "credentialIv" TEXT,
    "credentialAuthTag" TEXT,
    "credentialUpdatedAt" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_connections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customer_connections_companyId_customerId_active_idx" ON "customer_connections"("companyId", "customerId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "customer_connections_companyId_customerId_type_username_key" ON "customer_connections"("companyId", "customerId", "type", "username");

-- AddForeignKey
ALTER TABLE "customer_connections" ADD CONSTRAINT "customer_connections_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_connections" ADD CONSTRAINT "customer_connections_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Os tres campos de credencial formam UM valor: ou existem os tres, ou nenhum.
-- Um ciphertext sem IV ou sem tag nao e uma credencial parcialmente utilizavel,
-- e uma linha meio-gravada por uma falha no meio de um update.
ALTER TABLE "customer_connections"
  ADD CONSTRAINT "customer_connections_credential_completeness_check"
  CHECK (
    (
      "credentialCiphertext" IS NULL
      AND "credentialIv" IS NULL
      AND "credentialAuthTag" IS NULL
    )
    OR (
      "credentialCiphertext" IS NOT NULL
      AND "credentialIv" IS NOT NULL
      AND "credentialAuthTag" IS NOT NULL
    )
  );

-- Reforca a constraint de origem da OS.
--
-- A versao anterior garantia apenas que EXTERNAL tivesse provider + id. Ela
-- deixava passar uma linha com EXATAMENTE UM dos dois preenchido — por exemplo
-- uma OS INTERNAL com `externalProvider = 'MOCK'` e `externalId` nulo.
--
-- Essa linha e incoerente em dois sentidos: afirma pertencer a um sistema
-- externo sem dizer com que identificador, e a unique
-- (companyId, externalProvider, externalId) nao consegue distingui-la de
-- nenhuma outra igualmente meio-preenchida, porque NULL nao colide com NULL.
--
-- A regra passa a ser:
--   1. os dois campos sao nulos juntos ou preenchidos juntos, sempre;
--   2. EXTERNAL exige que estejam preenchidos.
--
-- INTERNAL continua livre para ter os dois nulos hoje e os dois preenchidos
-- depois, sem deixar de ser INTERNAL (PRD §122).
ALTER TABLE "service_orders" DROP CONSTRAINT "service_orders_external_identity_check";

ALTER TABLE "service_orders"
  ADD CONSTRAINT "service_orders_external_identity_check"
  CHECK (
    (("externalProvider" IS NULL) = ("externalId" IS NULL))
    AND ("origin" <> 'EXTERNAL' OR "externalProvider" IS NOT NULL)
  );
