import { FieldDataType, LogLevel } from './enums';

/**
 * Lightweight DTOs mirroring the 14 core metadata models defined in
 * apps/backend/prisma/schema.prisma. These describe *shapes*, not
 * runtime behavior -- kept here so frontend and backend never drift
 * on field names/types for the metadata entities. Deep validation
 * (class-validator DTOs, zod schemas, etc.) is deferred to each
 * module's real implementation.
 */

export interface TenantDto {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  updatedAt: string;
}

export interface UserDto {
  id: string;
  tenantId: string;
  email: string;
  name: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RoleDto {
  id: string;
  tenantId: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PermissionDto {
  id: string;
  code: string;
  description: string | null;
  createdAt: string;
}

export interface RolePermissionDto {
  id: string;
  roleId: string;
  permissionId: string;
}

export interface DynamicTableDto {
  id: string;
  tenantId: string;
  name: string;
  slug: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DynamicFieldDto {
  id: string;
  tenantId: string;
  tableId: string;
  name: string;
  slug: string;
  dataType: FieldDataType;
  required: boolean;
  config: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowDto {
  id: string;
  tenantId: string;
  name: string;
  description: string | null;
  status: string;
  definition: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface PageDto {
  id: string;
  tenantId: string;
  name: string;
  path: string;
  status: string;
  definition: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface CronJobDto {
  id: string;
  tenantId: string;
  name: string;
  schedule: string;
  targetRef: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MailTemplateDto {
  id: string;
  tenantId: string;
  name: string;
  subject: string;
  body: string;
  variables: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface WikiPageDto {
  id: string;
  tenantId: string;
  title: string;
  slug: string;
  content: string;
  parentId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LogEntryDto {
  id: string;
  tenantId: string | null;
  level: LogLevel;
  message: string;
  context: Record<string, unknown> | null;
  createdAt: string;
}

export interface TranslationDto {
  id: string;
  locale: string;
  namespace: string;
  key: string;
  value: string;
}
