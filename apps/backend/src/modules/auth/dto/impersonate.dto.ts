import { IsNotEmpty, IsString } from 'class-validator';

/** Target TenantUser for a short-lived support impersonation session. */
export class ImpersonateDto {
  @IsString()
  @IsNotEmpty()
  tenantUserId!: string;
}
