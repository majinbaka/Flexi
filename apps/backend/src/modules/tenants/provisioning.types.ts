export const TENANT_PROVISIONING_QUEUE_NAME = 'tenant-provisioning';

export const TENANT_PROVISIONING_START_JOB = 'tenant-lifecycle-start';

export interface TenantProvisioningJobData {
  attemptId: string;
}
