-- Separa as duas APIs do ReceitaNet na procedencia da conexao.
-- RENAME preserva as linhas existentes: nenhuma conexao perde a origem.
ALTER TYPE "ConnectionUsernameSource" RENAME VALUE 'RECEITANET' TO 'RECEITANET_CALLCENTER';
ALTER TYPE "ConnectionUsernameSource" ADD VALUE 'RECEITANET_CHATBOT';
ALTER TYPE "ConnectionPasswordSource" ADD VALUE 'RECEITANET_CHATBOT';

-- Uma credencial por (empresa, provider, API).
CREATE TYPE "ERPCredentialKind" AS ENUM ('CALLCENTER', 'CHATBOT');

CREATE TABLE "erp_credentials" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "provider" "ERPProvider" NOT NULL,
    "kind" "ERPCredentialKind" NOT NULL,
    "credentialCiphertext" TEXT NOT NULL,
    "credentialIv" TEXT NOT NULL,
    "credentialAuthTag" TEXT NOT NULL,
    "credentialLast4" TEXT,
    "aadVersion" TEXT NOT NULL DEFAULT 'v2',
    "credentialUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "erp_credentials_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "erp_credentials_companyId_provider_kind_key"
    ON "erp_credentials"("companyId", "provider", "kind");
CREATE INDEX "erp_credentials_companyId_idx" ON "erp_credentials"("companyId");

ALTER TABLE "erp_credentials" ADD CONSTRAINT "erp_credentials_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: a credencial que ja existia vira a do CALLCENTER.
--
-- `aadVersion = 'v1'` e o ponto critico. O AAD antigo liga o ciphertext a
-- (companyId, provider) e NAO inclui `kind`; recomputa-lo como v2 mudaria os
-- bytes e a verificacao GCM rejeitaria o token que a empresa ja tem
-- configurado. Marcando a linha como v1, ela continua decriptando, e a
-- proxima gravacao daquele token a promove para v2.
--
-- Nenhum token e inventado: so migra quem ja tinha ciphertext completo.
INSERT INTO "erp_credentials" (
    "id", "companyId", "provider", "kind",
    "credentialCiphertext", "credentialIv", "credentialAuthTag",
    "credentialLast4", "aadVersion", "credentialUpdatedAt",
    "createdAt", "updatedAt"
)
SELECT
    md5(random()::text || clock_timestamp()::text),
    i."companyId",
    i."provider",
    'CALLCENTER'::"ERPCredentialKind",
    i."credentialCiphertext",
    i."credentialIv",
    i."credentialAuthTag",
    i."credentialLast4",
    'v1',
    COALESCE(i."credentialUpdatedAt", CURRENT_TIMESTAMP),
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "erp_integrations" i
WHERE i."credentialCiphertext" IS NOT NULL
  AND i."credentialIv" IS NOT NULL
  AND i."credentialAuthTag" IS NOT NULL;
