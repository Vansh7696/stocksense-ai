-- Create partial unique index to enforce exactly one default watchlist per user
CREATE UNIQUE INDEX "watchlists_userId_isDefault_unique_idx" ON "watchlists"("userId") WHERE "isDefault" = true;
