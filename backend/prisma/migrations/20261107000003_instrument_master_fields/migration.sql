-- AlterTable: Add instrument master fields to stocks table
ALTER TABLE "stocks" ADD COLUMN "exchangeToken" TEXT,
ADD COLUMN "expiryDate" TIMESTAMPTZ,
ADD COLUMN "instrumentType" TEXT NOT NULL DEFAULT 'EQUITY',
ADD COLUMN "lotSize" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "segment" TEXT NOT NULL DEFAULT 'NSE_EQ',
ADD COLUMN "tickSize" DECIMAL(10,4);

-- Set segment for existing BSE stocks
UPDATE "stocks" SET "segment" = 'BSE_EQ' WHERE "instrumentToken" LIKE 'BSE_EQ%';

-- Drop old index on (exchangeId, symbol)
DROP INDEX IF EXISTS "stocks_exchangeId_symbol_key";

-- Create unique index on instrumentToken
CREATE UNIQUE INDEX "stocks_instrumentToken_key" ON "stocks"("instrumentToken");

-- Create unique index on (exchangeId, symbol, segment)
CREATE UNIQUE INDEX "stocks_exchangeId_symbol_segment_key" ON "stocks"("exchangeId", "symbol", "segment");

-- Create indexes for performance
CREATE INDEX "stocks_instrumentType_idx" ON "stocks"("instrumentType");
CREATE INDEX "stocks_segment_idx" ON "stocks"("segment");
