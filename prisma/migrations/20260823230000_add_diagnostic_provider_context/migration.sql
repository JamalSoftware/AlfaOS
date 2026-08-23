-- Contexto adicional que o provider entrega junto do estado de conectividade.
--
-- Aditiva e anulável: todo snapshot existente continua válido com os dois
-- campos nulos, e "o provider não informou" permanece distinguível de "o
-- provider informou vazio".
--
-- `technology` é TEXT e não um enum de propósito. O OpenAPI CallCenter declara
-- `tecnologia` como inteiro e NÃO documenta o significado de cada valor;
-- guardar o código cru é honesto, enquanto criar um enum exigiria inventar o
-- mapeamento. Quando o suporte do ReceitaNet documentar a tabela, uma migration
-- posterior pode normalizar.
ALTER TABLE "customer_diagnostic_snapshots"
  ADD COLUMN "technology" TEXT,
  ADD COLUMN "serverMaintenance" BOOLEAN;
