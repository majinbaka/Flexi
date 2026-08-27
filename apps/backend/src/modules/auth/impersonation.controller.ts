import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  AuthenticatedUserDto,
  ImpersonationTokenDto,
} from '@flexi/shared-types';
import { TenantIdHeader } from '../../common/tenant-context.decorator';
import { CurrentUser } from './decorators/current-user.decorator';
import { ImpersonateDto } from './dto/impersonate.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { ImpersonationService } from './impersonation.service';

/**
 * Support-only delegation. The client retains its original System Admin
 * session locally and resumes it after DELETE; this API never exposes a
 * refresh token for, or derives one from, an impersonation session.
 */
@Controller('admin/impersonation')
@UseGuards(JwtAuthGuard)
export class ImpersonationController {
  constructor(private readonly impersonationService: ImpersonationService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  start(
    @Body() dto: ImpersonateDto,
    @CurrentUser() currentUser: AuthenticatedUserDto,
    @TenantIdHeader() tenantId?: string,
  ): Promise<ImpersonationTokenDto> {
    return this.impersonationService.start(
      currentUser,
      tenantId,
      dto.tenantUserId,
    );
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  async end(@CurrentUser() currentUser: AuthenticatedUserDto): Promise<void> {
    await this.impersonationService.end(currentUser);
  }
}
