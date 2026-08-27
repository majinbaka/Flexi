import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

/**
 * Body for `PATCH /api/users/:userId`.
 *
 * Both fields are optional and absence means "leave alone", so a caller
 * renaming somebody does not have to echo their role back and risk
 * clobbering a concurrent change to it. `roleId: null` clears the user's
 * roles and is deliberately distinct from omitting the field --
 * `@IsOptional()` lets `null` through, and the service tells the two apart
 * by `undefined` vs `null`, exactly as `UpdateTenantSettingsDto` does for
 * `defaultRoleId`.
 *
 * Only the shape is asserted here. Whether the role belongs to the right
 * scope, and the rule that nobody may change their own role, live in the
 * service next to the caller they are checked against.
 */
export class UpdateUserDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  fullName?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  roleId?: string | null;
}
