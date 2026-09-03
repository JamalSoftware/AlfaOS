-- SGP-1 — o provider SGP passa a existir no domínio.
--
-- Estritamente ADITIVA: dois valores de enum, e nada mais. Nenhuma coluna,
-- nenhuma tabela, nenhuma unique alterada, nenhum dado tocado.
--
-- `ERPIntegration.companyId @unique` permanece: uma empresa continua tendo
-- ZERO OU UM ERP ativo. Este provider entra no catálogo global do AlfaOS, não
-- ao lado de outro dentro da mesma empresa.
--
-- Em PostgreSQL 12+ `ALTER TYPE ... ADD VALUE` roda dentro de transação desde
-- que o valor novo NÃO seja usado na mesma transação. Nada abaixo o usa.
--
-- Plano: docs/ERP-INTEGRATIONS.md §25 e docs/ERP-SGP.md.

-- AlterEnum
ALTER TYPE "ERPProvider" ADD VALUE 'SGP';

-- AlterEnum
--
-- `PUBLIC_API` nomeia a API Pública do SGP, que é UMA. Reaproveitar
-- `CALLCENTER` faria a linha mentir sobre qual API a credencial abre.
-- `CALLCENTER` e `CHATBOT` NÃO são renomeados: estão gravados em linhas reais e
-- participam do AAD `v2`.
ALTER TYPE "ERPCredentialKind" ADD VALUE 'PUBLIC_API';
