-- CreateTable
CREATE TABLE "tenant_onboarding_attempts" (
    "id" TEXT NOT NULL,
    "actorSystemUserId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'accepted',
    "safePayload" JSONB NOT NULL,
    "actorIdentity" JSONB NOT NULL,
    "requestIdentity" JSONB NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "idempotencyIdentity" JSONB NOT NULL,
    "stepOutcomes" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_onboarding_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tenant_onboarding_attempts_actorSystemUserId_idx" ON "tenant_onboarding_attempts"("actorSystemUserId");

-- CreateIndex
CREATE INDEX "tenant_onboarding_attempts_status_idx" ON "tenant_onboarding_attempts"("status");

-- CreateIndex
CREATE INDEX "tenant_onboarding_attempts_createdAt_idx" ON "tenant_onboarding_attempts"("createdAt");

-- CreateIndex
CREATE INDEX "tenant_onboarding_attempts_idempotencyKey_idx" ON "tenant_onboarding_attempts"("idempotencyKey");

-- AddForeignKey
ALTER TABLE "tenant_onboarding_attempts" ADD CONSTRAINT "tenant_onboarding_attempts_actorSystemUserId_fkey" FOREIGN KEY ("actorSystemUserId") REFERENCES "system_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
