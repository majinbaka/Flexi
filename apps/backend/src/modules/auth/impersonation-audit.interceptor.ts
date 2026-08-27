import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { AuthAuditEvent, AuthenticatedUserDto } from '@flexi/shared-types';
import { Request } from 'express';
import { Observable, mergeMap } from 'rxjs';
import { AuthAuditService } from './auth-audit.service';

/**
 * Captures every successfully handled HTTP action made under an
 * impersonation token. Domain services that already write detailed audit
 * records are enriched by AuthAuditService via CLS as well; this record is
 * the complete request-level safety net for modules without their own audit
 * implementation (notably dynamic-table writes).
 */
@Injectable()
export class ImpersonationAuditInterceptor implements NestInterceptor {
  constructor(private readonly authAuditService: AuthAuditService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: AuthenticatedUserDto }>();
    const currentUser = request.user;

    if (!currentUser?.impersonatedBy || !currentUser.tenantId) {
      return next.handle();
    }

    return next.handle().pipe(
      mergeMap(async (result) => {
        await this.authAuditService.record({
          event: AuthAuditEvent.IMPERSONATED_ACTION,
          tenantId: currentUser.tenantId,
          subjectAuthAccountId: currentUser.authAccountId,
          actorAuthAccountId: currentUser.authAccountId,
          metadata: {
            method: request.method,
            path: request.route?.path ?? request.path,
          },
        });
        return result;
      }),
    );
  }
}
