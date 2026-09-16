-- DIAG-AUTO-1 — a reserva que impede dois ciclos de consultarem o mesmo cliente.
--
-- Medido antes de existir: dois ciclos disparados no mesmo instante
-- processaram as SEIS conexões elegíveis cada um — doze chamadas ao provider
-- para seis clientes. A elegibilidade sozinha não protege, porque os dois leem
-- a lista antes de qualquer escrita.
--
-- A reserva é reivindicada por `updateMany` com o prazo no predicado: o banco
-- serializa o UPDATE, quem casa uma linha consulta o provider, quem casa zero
-- segue adiante. Mesmo mecanismo da reivindicação de evento do outbox.
--
-- O prazo existe para que um processo morto no meio do ciclo não deixe o
-- cliente trancado: vencido, ele volta a ser reivindicável.
--
-- Não é estado de conectividade e nenhuma tela a lê. Aditiva, anulável, sem
-- backfill: linha existente nasce sem reserva, que é exatamente "livre".

ALTER TABLE "customer_diagnostic_snapshots" ADD COLUMN "refreshLeaseUntil" TIMESTAMP(3);
