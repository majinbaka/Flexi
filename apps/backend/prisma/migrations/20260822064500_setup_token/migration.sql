-- CreateTable
CREATE TABLE "setup_tokens" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "setup_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "setup_tokens_tokenHash_key" ON "setup_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "setup_tokens_tenantId_idx" ON "setup_tokens"("tenantId");

-- AddForeignKey
ALTER TABLE "setup_tokens" ADD CONSTRAINT "setup_tokens_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
