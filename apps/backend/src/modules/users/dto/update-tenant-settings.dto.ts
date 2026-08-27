import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
} from 'class-validator';

/**
 * Upper bound on the domain whitelist. Not a business rule -- it bounds
 * the size of one request and of the array column behind it; a tenant that
 * genuinely accepts more domains than this wants an empty list ("any
 * domain") plus another control, not a longer one.
 */
export const MAX_ALLOWED_EMAIL_DOMAINS = 50;

/**
 * Body for `PATCH /api/tenant-settings`.
 *
 * Every field is optional and absence means "leave alone", so a caller
 * that only wants to flip the toggle does not have to echo back the rest
 * of the policy and risk clobbering a concurrent change to it.
 *
 * `defaultRoleId` accepts `null` on purpose, and `@IsOptional()` lets it
 * through -- clearing the role is a real operation, distinct from omitting
 * the field. The service tells the two apart by `undefined` vs `null`.
 *
 * Only the shape is asserted here. Domain normalization (lowercase, strip
 * a leading `@`, drop blanks) and the rule that `defaultRoleId` must name
 * a role of the target tenant live in the service, next to the tenant
 * whose roles they are checked against.
 */
export class UpdateTenantSettingsDto {
  @IsOptional()
  @IsBoolean()
  allowSelfRegistration?: boolean;

  @IsOptional()
  @IsBoolean()
  allowSystemImpersonation?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_ALLOWED_EMAIL_DOMAINS)
  @IsString({ each: true })
  allowedEmailDomains?: string[];

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  defaultRoleId?: string | null;

  @IsOptional()
  @IsBoolean()
  requireApproval?: boolean;
}
