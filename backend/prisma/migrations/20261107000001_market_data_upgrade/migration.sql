-- AlterTable
ALTER TABLE "historical_prices" ALTER COLUMN "open" SET DATA TYPE DECIMAL(14,4),
ALTER COLUMN "high" SET DATA TYPE DECIMAL(14,4),
ALTER COLUMN "low" SET DATA TYPE DECIMAL(14,4),
ALTER COLUMN "close" SET DATA TYPE DECIMAL(14,4);

-- CreateTable
CREATE TABLE "system_configs" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "system_configs_pkey" PRIMARY KEY ("key")
);
