import { Controller, Get } from '@nestjs/common';
import { NotImplementedStatus } from '@flexi/shared-types';
import { AuthService } from './auth.service';

/**
 * Stub controller for the "auth" feature area.
 * Single placeholder route: GET /api/auth -> { success:true, data:{ status:'not-implemented' } }
 * (envelope applied globally by ResponseInterceptor).
 */
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Get()
  getStatus(): NotImplementedStatus {
    return this.authService.getStatus();
  }
}
