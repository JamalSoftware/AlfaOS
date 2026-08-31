-- Fila operacional de OS — fundacao de persistencia (PRD Parte XII, DQ-1).
--
-- ADITIVA. Duas tabelas novas e nada mais: nenhum DROP, nenhum ALTER em tabela
-- existente, nenhum dado tocado. `ServiceOrderPriority` e `ServiceOrderStatus`
-- ficam exatamente como estao — reordenar o enum de prioridade reordenaria, em
-- silencio, a fila de todos os tecnicos, e a precedencia passou a viver no
-- dominio (`src/lib/dispatch-queue.ts`) justamente para nao depender dele.
--
-- NENHUMA FILA E CRIADA AQUI. O backfill das OS ja atribuidas e o DQ-2: uma
-- migration que escreve linha de dominio esconde regra de negocio num lugar
-- que ninguem testa.
--
-- As quatro uniques, e o que cada uma impede:
--
--   queues (technicianId)               duas filas para o mesmo tecnico.
--                                       A composta abaixo sozinha PERMITIRIA
--                                       isso sob companyIds diferentes, porque
--                                       o schema nao usa FK composta em lugar
--                                       nenhum e nada obriga queue.companyId a
--                                       concordar com technician.companyId.
--
--   queues (companyId, technicianId)    chave de busca com o TENANT no
--                                       predicado: a fila e achada por empresa
--                                       + tecnico, nunca navegando a FK.
--
--   entries (serviceOrderId)            a mesma OS em duas filas. E ela que
--                                       torna a reatribuicao segura por
--                                       construcao: inserir em B antes de
--                                       remover de A falha no banco.
--
--   entries (queueId, position)         I-11: duas OS na mesma posicao da
--                                       mesma fila. Tambem e o indice de
--                                       leitura ordenada.
--
-- ON DELETE segue o padrao das entidades satelite da OS (ServiceOrderExecution,
-- ServiceOrderCheckIn, ServiceOrderCompletion): Company CASCADE, ServiceOrder
-- CASCADE, Technician RESTRICT. RESTRICT no tecnico e deliberado — desativar
-- (`technicians.active`) e a operacao suportada, e nenhuma outra relacao do
-- Technician usa CASCADE.

-- CreateTable
CREATE TABLE "technician_dispatch_queues" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "technicianId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "technician_dispatch_queues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "technician_dispatch_queue_entries" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "queueId" TEXT NOT NULL,
    "serviceOrderId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "technician_dispatch_queue_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "technician_dispatch_queues_technicianId_key" ON "technician_dispatch_queues"("technicianId");

-- CreateIndex
CREATE UNIQUE INDEX "technician_dispatch_queues_companyId_technicianId_key" ON "technician_dispatch_queues"("companyId", "technicianId");

-- CreateIndex
CREATE UNIQUE INDEX "technician_dispatch_queue_entries_serviceOrderId_key" ON "technician_dispatch_queue_entries"("serviceOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "technician_dispatch_queue_entries_queueId_position_key" ON "technician_dispatch_queue_entries"("queueId", "position");

-- AddForeignKey
ALTER TABLE "technician_dispatch_queues" ADD CONSTRAINT "technician_dispatch_queues_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "technician_dispatch_queues" ADD CONSTRAINT "technician_dispatch_queues_technicianId_fkey" FOREIGN KEY ("technicianId") REFERENCES "technicians"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "technician_dispatch_queue_entries" ADD CONSTRAINT "technician_dispatch_queue_entries_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "technician_dispatch_queue_entries" ADD CONSTRAINT "technician_dispatch_queue_entries_queueId_fkey" FOREIGN KEY ("queueId") REFERENCES "technician_dispatch_queues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "technician_dispatch_queue_entries" ADD CONSTRAINT "technician_dispatch_queue_entries_serviceOrderId_fkey" FOREIGN KEY ("serviceOrderId") REFERENCES "service_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
