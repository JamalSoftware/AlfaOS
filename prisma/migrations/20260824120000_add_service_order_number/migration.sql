-- Numero operacional da OS (PRD §17).
--
-- `ServiceOrder.id` continua sendo a identidade TECNICA: PK, chave estrangeira
-- e valor da URL. `number` e a identidade OPERACIONAL HUMANA: sequencial por
-- empresa, dizivel ao telefone e anotavel numa ficha de campo.
--
-- A migration e escrita a mao porque o passo central nao e DDL: e o backfill
-- deterministico das OS que ja existem.

-- CreateTable
CREATE TABLE "service_order_counters" (
    "companyId" TEXT NOT NULL,
    "lastNumber" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_order_counters_pkey" PRIMARY KEY ("companyId")
);

-- AddForeignKey
ALTER TABLE "service_order_counters" ADD CONSTRAINT "service_order_counters_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Coluna criada NULA para o backfill. O NOT NULL vem depois, ja com todas as
-- linhas preenchidas — nao ha default: um default tornaria possivel inserir
-- sem passar pelo alocador.
ALTER TABLE "service_orders" ADD COLUMN "number" INTEGER;

-- Backfill DETERMINISTICO, por empresa.
--
-- A ordem e (createdAt, id): `createdAt` da a sequencia cronologica que a
-- operacao espera, e `id` desempata quando duas OS foram criadas no mesmo
-- milissegundo — sem o desempate o resultado dependeria da ordem fisica das
-- linhas e duas execucoes da mesma migration poderiam numerar diferente.
--
-- Nenhuma linha e criada, apagada ou reidentificada: e um UPDATE de uma
-- coluna nova. Os `id` existentes ficam intactos.
WITH numbered AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "companyId"
      ORDER BY "createdAt" ASC, "id" ASC
    ) AS seq
  FROM "service_orders"
)
UPDATE "service_orders" AS so
SET "number" = numbered.seq
FROM numbered
WHERE so."id" = numbered."id";

-- Contador alinhado ao maior numero ja atribuido em cada empresa, para que a
-- proxima OS continue a sequencia em vez de recomecar e colidir.
INSERT INTO "service_order_counters" ("companyId", "lastNumber", "updatedAt")
SELECT "companyId", MAX("number"), CURRENT_TIMESTAMP
FROM "service_orders"
GROUP BY "companyId";

-- Obrigatorio a partir daqui.
ALTER TABLE "service_orders" ALTER COLUMN "number" SET NOT NULL;

-- Inteiro POSITIVO. Zero e negativo nao sao numeros de OS, e sem o CHECK um
-- alocador defeituoso escreveria 0 silenciosamente.
ALTER TABLE "service_orders"
  ADD CONSTRAINT "service_orders_number_positive_check" CHECK ("number" > 0);

-- CreateIndex
-- Sequencia INDEPENDENTE por empresa: a unique e (companyId, number), nunca
-- number sozinho. Empresa A e empresa B tem, cada uma, a sua OS Nº 1.
CREATE UNIQUE INDEX "service_orders_companyId_number_key" ON "service_orders"("companyId", "number");

-- Imutabilidade no BANCO, nao so na aplicacao.
--
-- Renumerar uma OS invalidaria todo papel, mensagem e conversa que ja citaram
-- o numero antigo, e o AlfaOS nao teria como saber que isso aconteceu: ao
-- contrario de um status, o numero nao deixa rastro na timeline quando muda.
-- O trigger e o unico ponto que nenhum caminho de escrita futuro consegue
-- esquecer.
CREATE OR REPLACE FUNCTION "service_orders_number_is_immutable"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."number" IS DISTINCT FROM OLD."number" THEN
    RAISE EXCEPTION 'ServiceOrder.number is immutable (id=%, % -> %)',
      OLD."id", OLD."number", NEW."number"
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "service_orders_number_immutable"
  BEFORE UPDATE ON "service_orders"
  FOR EACH ROW
  EXECUTE FUNCTION "service_orders_number_is_immutable"();
