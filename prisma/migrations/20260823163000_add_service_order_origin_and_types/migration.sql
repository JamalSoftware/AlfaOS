-- Renomeia o enum de origem em vez de somar um campo novo.
--
-- `ServiceOrderSource { MANUAL, IMPORTED }` ja carregava exatamente a semantica
-- de origem definida no PRD §122, gravada explicitamente no ponto de criacao e
-- nunca inferida de `externalId`. Criar um `origin` ao lado dele produziria
-- dois campos obrigados a concordar para sempre, e todo caminho de escrita
-- futuro que atualizasse um e esquecesse o outro geraria divergencia silenciosa.
--
-- RENAME preserva os dados: nenhuma linha e reescrita, nenhum valor e perdido.
ALTER TYPE "ServiceOrderSource" RENAME TO "ServiceOrderOrigin";
ALTER TYPE "ServiceOrderOrigin" RENAME VALUE 'MANUAL' TO 'INTERNAL';
ALTER TYPE "ServiceOrderOrigin" RENAME VALUE 'IMPORTED' TO 'EXTERNAL';

-- AlterTable
ALTER TABLE "service_orders" RENAME COLUMN "source" TO "origin";
ALTER TABLE "service_orders" ALTER COLUMN "origin" SET DEFAULT 'INTERNAL';

-- Uma OS EXTERNAL sem identidade externa e um registro que afirma ter nascido
-- em outro sistema sem dizer em qual nem com que id — ela nunca poderia ser
-- reconciliada nem reimportada de forma idempotente.
--
-- A regra vive no banco, e nao apenas na aplicacao, porque este e o unico lugar
-- onde um caminho de escrita futuro nao consegue esquece-la.
ALTER TABLE "service_orders"
  ADD CONSTRAINT "service_orders_external_identity_check"
  CHECK (
    "origin" <> 'EXTERNAL'
    OR ("externalProvider" IS NOT NULL AND "externalId" IS NOT NULL)
  );

-- CreateTable
CREATE TABLE "service_order_types" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "service_order_types_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "service_order_types_companyId_active_sortOrder_idx" ON "service_order_types"("companyId", "active", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "service_order_types_companyId_name_key" ON "service_order_types"("companyId", "name");

-- AlterTable
ALTER TABLE "service_orders" ADD COLUMN "typeId" TEXT;

-- CreateIndex
CREATE INDEX "service_orders_companyId_origin_idx" ON "service_orders"("companyId", "origin");

-- CreateIndex
CREATE INDEX "service_orders_typeId_idx" ON "service_orders"("typeId");

-- AddForeignKey
ALTER TABLE "service_order_types" ADD CONSTRAINT "service_order_types_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- `Restrict`: um tipo em uso por uma OS nao pode ser apagado. Desativar e a
-- operacao suportada, e ela nao afeta OS historica — o rotulo ja esta gravado
-- em `service_orders.type`.
-- AddForeignKey
ALTER TABLE "service_orders" ADD CONSTRAINT "service_orders_typeId_fkey" FOREIGN KEY ("typeId") REFERENCES "service_order_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
