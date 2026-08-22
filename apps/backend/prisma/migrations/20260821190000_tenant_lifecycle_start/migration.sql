ALTER TABLE "tenants"
  ADD COLUMN "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "onboardingAttemptId" TEXT;

ALTER TABLE "tenant_onboarding_attempts"
  ADD COLUMN "provisioningJobId" TEXT;

CREATE UNIQUE INDEX "tenants_onboardingAttemptId_key"
  ON "tenants"("onboardingAttemptId");

CREATE INDEX "tenants_status_idx"
  ON "tenants"("status");

CREATE UNIQUE INDEX "tenant_onboarding_attempts_provisioningJobId_key"
  ON "tenant_onboarding_attempts"("provisioningJobId");

CREATE INDEX "tenant_onboarding_attempts_provisioningJobId_idx"
  ON "tenant_onboarding_attempts"("provisioningJobId");

ALTER TABLE "tenants"
  ADD CONSTRAINT "tenants_onboardingAttemptId_fkey"
  FOREIGN KEY ("onboardingAttemptId")
  REFERENCES "tenant_onboarding_attempts"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;
