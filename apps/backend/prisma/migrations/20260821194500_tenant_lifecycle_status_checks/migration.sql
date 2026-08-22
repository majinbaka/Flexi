ALTER TABLE "tenants"
  ADD CONSTRAINT "tenants_status_check"
  CHECK ("status" IN ('PROVISIONING', 'ACTIVE', 'FAILED', 'SUSPENDED'));

ALTER TABLE "tenant_onboarding_attempts"
  ADD CONSTRAINT "tenant_onboarding_attempts_status_check"
  CHECK ("status" IN ('accepted', 'provisioning', 'failed'));
