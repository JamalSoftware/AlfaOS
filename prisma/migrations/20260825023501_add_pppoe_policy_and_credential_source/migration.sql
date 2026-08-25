-- CreateEnum
CREATE TYPE "PppoePasswordPolicy" AS ENUM ('MANUAL_ONLY', 'DOCUMENT_LAST4');

-- CreateEnum
CREATE TYPE "ConnectionUsernameSource" AS ENUM ('MANUAL', 'RECEITANET');

-- CreateEnum
CREATE TYPE "ConnectionPasswordSource" AS ENUM ('MANUAL', 'AUTO_DOCUMENT_LAST4');

-- AlterTable
ALTER TABLE "companies" ADD COLUMN     "pppoePasswordPolicy" "PppoePasswordPolicy" NOT NULL DEFAULT 'MANUAL_ONLY';

-- AlterTable
ALTER TABLE "customer_connections" ADD COLUMN     "passwordSource" "ConnectionPasswordSource" NOT NULL DEFAULT 'MANUAL',
ADD COLUMN     "usernameSource" "ConnectionUsernameSource" NOT NULL DEFAULT 'MANUAL';
