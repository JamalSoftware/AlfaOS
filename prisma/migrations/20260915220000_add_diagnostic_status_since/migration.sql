-- DIAG-AUTO-1 — "desde quando" deixa de ser adivinhado.
--
-- `observedAt` responde "quando conferimos pela última vez" e é reescrito a
-- cada verificação bem-sucedida, inclusive quando o estado não mudou. Com a
-- verificação automática de 5 em 5 minutos isso passaria a significar que todo
-- cliente está no estado atual há no máximo 5 minutos — e um cliente offline
-- há nove dias apareceria como "offline há 5 minutos".
--
-- `statusSince` data a TRANSIÇÃO: só anda quando `connectivityStatus` muda.
-- Não é uma segunda autoridade de estado; o estado continua sendo
-- `connectivityStatus`, e não existe coluna nova de status em lugar nenhum.
--
-- Aditiva: uma coluna, zero DROP, zero dado apagado.

-- 1. Nasce anulável, porque a tabela já tem linhas e não há default honesto.
ALTER TABLE "customer_diagnostic_snapshots" ADD COLUMN "statusSince" TIMESTAMP(3);

-- 2. Backfill conservador: para a linha legada, o único instante em que se SABE
--    que o estado já era aquele é a própria observação. O começo real pode ser
--    anterior, e ninguém o registrou — inventar uma data mais antiga seria
--    afirmar uma duração que nunca foi medida.
UPDATE "customer_diagnostic_snapshots"
SET "statusSince" = "observedAt"
WHERE "statusSince" IS NULL;

-- 3. Só então a coluna passa a ser obrigatória: a partir daqui não existe
--    snapshot sem início de estado, e o código não precisa tratar o nulo.
ALTER TABLE "customer_diagnostic_snapshots" ALTER COLUMN "statusSince" SET NOT NULL;
