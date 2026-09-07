-- CreateEnum
CREATE TYPE "CustomerNetworkConnectionSource" AS ENUM ('FIELD', 'WEB');

-- CreateTable
CREATE TABLE "customer_network_connections" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "ctoPortId" TEXT NOT NULL,
    "serviceOrderId" TEXT,
    "technicianId" TEXT,
    "connectedAt" TIMESTAMP(3) NOT NULL,
    "disconnectedAt" TIMESTAMP(3),
    "source" "CustomerNetworkConnectionSource" NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_network_connections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customer_network_connections_companyId_customerId_idx" ON "customer_network_connections"("companyId", "customerId");

-- CreateIndex
CREATE INDEX "customer_network_connections_companyId_ctoPortId_idx" ON "customer_network_connections"("companyId", "ctoPortId");

-- CreateIndex
CREATE INDEX "customer_network_connections_serviceOrderId_idx" ON "customer_network_connections"("serviceOrderId");

-- CreateIndex
CREATE INDEX "customer_network_connections_technicianId_idx" ON "customer_network_connections"("technicianId");

-- AddForeignKey
ALTER TABLE "customer_network_connections" ADD CONSTRAINT "customer_network_connections_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_network_connections" ADD CONSTRAINT "customer_network_connections_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_network_connections" ADD CONSTRAINT "customer_network_connections_ctoPortId_fkey" FOREIGN KEY ("ctoPortId") REFERENCES "cto_ports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_network_connections" ADD CONSTRAINT "customer_network_connections_serviceOrderId_fkey" FOREIGN KEY ("serviceOrderId") REFERENCES "service_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_network_connections" ADD CONSTRAINT "customer_network_connections_technicianId_fkey" FOREIGN KEY ("technicianId") REFERENCES "technicians"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- As duas uniques que o DSL do Prisma NAO expressa
--
-- A regra nao e "um vinculo por porta" — e "no maximo UM vinculo ATIVO por
-- porta". A tabela existe justamente para guardar os inativos: um cliente pode
-- ter estado na porta 4 em marco e outro estar nela agora, e as duas linhas
-- precisam coexistir.
--
-- `@@unique([ctoPortId])` no schema seria uma regra DIFERENTE e errada:
-- proibiria o historico. A clausula `WHERE` e o que separa as duas coisas, e
-- ela so existe em SQL.
--
-- Mesmo padrao de `checklist_templates_company_default_key`
-- (20260827180000), pelo mesmo motivo.
--
-- Elas sao a ULTIMA barreira, nao a primeira: o lock da CTO e o do Customer
-- serializam quem passa pelo servico; estes indices respondem por todo o resto
-- — um caminho novo que esqueca o lock, uma corrida que escape da janela, um
-- INSERT direto. Validacao em codigo de aplicacao nao substitui nenhum dos
-- dois.
-- ---------------------------------------------------------------------------

-- No maximo um cliente ativo por porta.
CREATE UNIQUE INDEX "customer_network_connections_active_port_key"
  ON "customer_network_connections"("ctoPortId")
  WHERE "disconnectedAt" IS NULL;

-- No maximo uma porta ativa por cliente.
--
-- Faltava no contrato original e `CTO-AC05` prometia "o cliente fica em
-- exatamente UMA porta ativa" sem nada no banco que garantisse isso: duas
-- movimentacoes concorrentes do mesmo cliente para portas DIFERENTES satisfazem
-- a unique de porta e deixariam o cliente em duas caixas.
CREATE UNIQUE INDEX "customer_network_connections_active_customer_key"
  ON "customer_network_connections"("customerId")
  WHERE "disconnectedAt" IS NULL;
