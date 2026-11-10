-- AlterTable: add isDefault and indexes to watchlists
ALTER TABLE "watchlists" ADD COLUMN "isDefault" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "watchlists_userId_idx" ON "watchlists"("userId");
CREATE UNIQUE INDEX "watchlists_userId_name_key" ON "watchlists"("userId", "name");

-- CreateTable
CREATE TABLE "stock_alerts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "stockId" TEXT NOT NULL,
    "alertType" VARCHAR(32) NOT NULL,
    "targetValue" DECIMAL(14,4) NOT NULL,
    "notes" VARCHAR(255),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "triggeredAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "stock_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "stock_alerts_userId_idx" ON "stock_alerts"("userId");
CREATE INDEX "stock_alerts_stockId_idx" ON "stock_alerts"("stockId");
CREATE INDEX "stock_alerts_isActive_idx" ON "stock_alerts"("isActive");

-- AddForeignKey
ALTER TABLE "stock_alerts" ADD CONSTRAINT "stock_alerts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "stock_alerts" ADD CONSTRAINT "stock_alerts_stockId_fkey" FOREIGN KEY ("stockId") REFERENCES "stocks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill existing default watchlists
UPDATE "watchlists" SET "isDefault" = true WHERE "name" = 'Default Watchlist';
