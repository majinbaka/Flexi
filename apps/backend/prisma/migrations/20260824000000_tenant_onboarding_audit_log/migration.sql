-- CreateTable
CREATE TABLE "tenant_onboarding_audit_logs" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "tenantId" TEXT,
    "actorIdentity" JSONB NOT NULL,
    "requestIdentity" JSONB NOT NULL,
    "safePayload" JSONB NOT NULL,
    "stepOutcomes" JSONB NOT NULL,
    "compensation" JSONB,
    "finalStatus" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_onboarding_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenant_onboarding_audit_logs_attemptId_key" ON "tenant_onboarding_audit_logs"("attemptId");

-- CreateIndex
CREATE INDEX "tenant_onboarding_audit_logs_tenantId_idx" ON "tenant_onboarding_audit_logs"("tenantId");

-- CreateIndex
CREATE INDEX "tenant_onboarding_audit_logs_finalStatus_idx" ON "tenant_onboarding_audit_logs"("finalStatus");
