-- AlterTable
ALTER TABLE "idempotency_records" ADD COLUMN     "leaseExpiresAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "outbox_events" ADD COLUMN     "leaseExpiresAt" TIMESTAMP(3);
