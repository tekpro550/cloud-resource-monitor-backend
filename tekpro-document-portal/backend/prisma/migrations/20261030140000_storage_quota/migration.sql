-- Optional per-customer storage limit (bytes); NULL means no limit.
ALTER TABLE "Customer" ADD COLUMN "storageQuotaBytes" BIGINT;
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_storageQuotaBytes_check" CHECK ("storageQuotaBytes" IS NULL OR "storageQuotaBytes" > 0);
