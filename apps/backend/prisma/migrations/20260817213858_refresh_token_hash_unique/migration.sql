-- DropIndex
DROP INDEX "refresh_tokens_tokenHash_idx";

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_tokenHash_key" ON "refresh_tokens"("tokenHash");
