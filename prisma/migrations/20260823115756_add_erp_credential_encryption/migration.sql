-- AlterTable
ALTER TABLE "erp_integrations" ADD COLUMN     "credentialAuthTag" TEXT,
ADD COLUMN     "credentialCiphertext" TEXT,
ADD COLUMN     "credentialIv" TEXT,
ADD COLUMN     "credentialLast4" TEXT,
ADD COLUMN     "credentialUpdatedAt" TIMESTAMP(3);
