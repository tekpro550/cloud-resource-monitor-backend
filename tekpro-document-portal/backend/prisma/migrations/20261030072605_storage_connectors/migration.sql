-- CreateEnum
CREATE TYPE "StorageProvider" AS ENUM ('AWS_S3', 'LIGHTSAIL', 'S3_COMPATIBLE');

-- CreateEnum
CREATE TYPE "StorageAuthType" AS ENUM ('ASSUME_ROLE', 'ACCESS_KEY');

-- CreateEnum
CREATE TYPE "StorageConnectorStatus" AS ENUM ('PENDING_VERIFICATION', 'ACTIVE', 'FAILED', 'DISABLED');

-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "storageConnectorId" UUID;

-- CreateTable
CREATE TABLE "StorageConnector" (
    "id" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "provider" "StorageProvider" NOT NULL,
    "bucket" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "endpoint" TEXT,
    "forcePathStyle" BOOLEAN NOT NULL DEFAULT false,
    "authType" "StorageAuthType" NOT NULL,
    "roleArn" TEXT,
    "externalId" TEXT NOT NULL,
    "accessKeyId" TEXT,
    "secretCiphertext" TEXT,
    "status" "StorageConnectorStatus" NOT NULL DEFAULT 'PENDING_VERIFICATION',
    "lastVerifiedAt" TIMESTAMP(3),
    "lastCheck" JSONB,
    "createdByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StorageConnector_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StorageConnector_customerId_key" ON "StorageConnector"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "StorageConnector_id_customerId_key" ON "StorageConnector"("id", "customerId");

-- AddForeignKey
ALTER TABLE "StorageConnector" ADD CONSTRAINT "StorageConnector_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_storageConnectorId_customerId_fkey" FOREIGN KEY ("storageConnectorId", "customerId") REFERENCES "StorageConnector"("id", "customerId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written constraints -------------------------------------------------

CREATE INDEX "Document_storageConnectorId_status_idx" ON "Document"("storageConnectorId", "status");

-- Each auth type carries exactly the fields it needs.
ALTER TABLE "StorageConnector" ADD CONSTRAINT "StorageConnector_auth_fields_check" CHECK (
  ("authType" = 'ASSUME_ROLE' AND "roleArn" IS NOT NULL AND "accessKeyId" IS NULL AND "secretCiphertext" IS NULL)
  OR ("authType" = 'ACCESS_KEY' AND "accessKeyId" IS NOT NULL AND "secretCiphertext" IS NOT NULL AND "roleArn" IS NULL)
);

-- Only S3-compatible connectors may point at a custom endpoint.
ALTER TABLE "StorageConnector" ADD CONSTRAINT "StorageConnector_endpoint_check" CHECK (
  ("provider" = 'S3_COMPATIBLE') = ("endpoint" IS NOT NULL)
);
