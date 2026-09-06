-- CreateEnum
CREATE TYPE "CtoPortAdministrativeState" AS ENUM ('AVAILABLE', 'RESERVED', 'DAMAGED');

-- AlterTable
ALTER TABLE "companies" ADD COLUMN     "ctoNetworkEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "ctos" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "capacity" INTEGER NOT NULL,
    "latitude" DECIMAL(10,7),
    "longitude" DECIMAL(10,7),
    "addressReference" TEXT,
    "notes" TEXT,
    "photoStorageKey" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ctos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cto_ports" (
    "id" TEXT NOT NULL,
    "ctoId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "administrativeState" "CtoPortAdministrativeState" NOT NULL DEFAULT 'AVAILABLE',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cto_ports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ctos_companyId_idx" ON "ctos"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "ctos_companyId_name_key" ON "ctos"("companyId", "name");

-- CreateIndex
CREATE INDEX "cto_ports_companyId_idx" ON "cto_ports"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "cto_ports_ctoId_number_key" ON "cto_ports"("ctoId", "number");

-- AddForeignKey
ALTER TABLE "ctos" ADD CONSTRAINT "ctos_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cto_ports" ADD CONSTRAINT "cto_ports_ctoId_fkey" FOREIGN KEY ("ctoId") REFERENCES "ctos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cto_ports" ADD CONSTRAINT "cto_ports_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Invariantes estruturais que o Prisma nao modela.
--
-- Escritas aqui, no SQL da migration, como o projeto ja faz com
-- `service_orders_number_positive_check` e o CHECK de identidade externa da OS.
--
-- `capacity > 0`: uma caixa com zero posicoes nao e uma caixa.
--
-- `number > 0`: a posicao e 1-based. Isto e o piso estrutural, NAO a faixa
-- ofertavel. A faixa `1..capacity` e regra de APLICACAO por construcao — um
-- CHECK entre `cto_ports.number` e `ctos.capacity` seria cross-table (exigiria
-- trigger) e, pior, seria incompativel com a propria politica de capacidade:
-- reduzir capacidade preserva as portas acima como historico, entao linhas com
-- `number > capacity` DEVEM sobreviver. O banco garante o que e imutavel por
-- linha; a ofertabilidade muda no tempo e e decidida na transacao que escreve.
ALTER TABLE "ctos"
  ADD CONSTRAINT "ctos_capacity_positive_check" CHECK ("capacity" > 0);

ALTER TABLE "cto_ports"
  ADD CONSTRAINT "cto_ports_number_positive_check" CHECK ("number" > 0);
