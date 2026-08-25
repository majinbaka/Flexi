ALTER TABLE "tenant_onboarding_attempts"
  DROP CONSTRAINT "tenant_onboarding_attempts_status_check",
  ADD CONSTRAINT "tenant_onboarding_attempts_status_check"
  CHECK (
    "status" IN (
      'accepted',
      'provisioning',
      'failed',
      'succeeded',
      'failed-needs-manual-cleanup'
    )
  );
