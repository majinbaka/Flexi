DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM "tenant_onboarding_attempts"
        GROUP BY "idempotencyKey"
        HAVING COUNT(*) > 1
    ) THEN
        RAISE EXCEPTION 'Cannot add tenant_onboarding_attempts idempotency uniqueness while duplicate idempotencyKey rows exist.';
    END IF;
END $$;

-- CreateIndex
CREATE UNIQUE INDEX "tenant_onboarding_attempts_idempotencyKey_key" ON "tenant_onboarding_attempts"("idempotencyKey");

-- DropIndex
DROP INDEX "tenant_onboarding_attempts_idempotencyKey_idx";
