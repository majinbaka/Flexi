import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

export interface ApiErrorEnvelope {
  success: false;
  data: null;
  error: {
    code: string;
    message: string;
    fields?: Record<string, string>;
    existingAttemptId?: string;
    checks?: Record<string, 'ok' | 'error'>;
  };
}

/**
 * Global exception filter -- catches everything (HttpException and
 * unhandled errors alike) and normalizes it into the standard
 * `{ success:false, error:{ code, message } }` envelope so callers never
 * see Nest's default error shape.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const isHttpException = exception instanceof HttpException;
    const status = isHttpException
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;
    const { code, message, fields, existingAttemptId, checks } =
      this.resolveErrorPayload(exception, isHttpException);

    const error: ApiErrorEnvelope['error'] = {
      code,
      message,
      ...(fields ? { fields } : {}),
      ...(existingAttemptId ? { existingAttemptId } : {}),
      ...(checks ? { checks } : {}),
    };

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `${request.method} ${request.url} -> ${status} ${message}`,
        (exception as Error)?.stack,
      );
    }

    const envelope: ApiErrorEnvelope = {
      success: false,
      data: null,
      error,
    };

    response.status(status).json(envelope);
  }

  private resolveErrorPayload(
    exception: unknown,
    isHttpException: boolean,
  ): {
    code: string;
    message: string;
    fields?: Record<string, string>;
    existingAttemptId?: string;
    checks?: Record<string, 'ok' | 'error'>;
  } {
    if (isHttpException) {
      const httpException = exception as HttpException;
      const status = httpException.getStatus();
      const responseBody = httpException.getResponse();

      if (typeof responseBody === 'string') {
        return {
          code: HttpStatus[status] ?? 'HTTP_ERROR',
          message: responseBody,
        };
      }

      // responseBody can legitimately be a non-string, non-plain-object value
      // (e.g. null, a number) for some HttpException subclasses/custom
      // throws -- guard so property reads below never throw inside the
      // filter itself.
      const body = (responseBody ?? {}) as {
        message?: string | string[];
        error?: string;
        fields?: unknown;
        existingAttemptId?: unknown;
        checks?: unknown;
      };
      const message = Array.isArray(body.message)
        ? body.message.join(', ')
        : body.message;

      return {
        code: body.error ?? HttpStatus[status] ?? 'HTTP_ERROR',
        message: message ?? httpException.message,
        fields: this.resolveSafeFields(body.fields),
        existingAttemptId: this.resolveSafeExistingAttemptId(
          status,
          body.error,
          body.existingAttemptId,
        ),
        checks: this.resolveSafeChecks(body.checks),
      };
    }

    return {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred',
    };
  }

  private resolveSafeFields(
    fields: unknown,
  ): Record<string, string> | undefined {
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
      return undefined;
    }

    const safeFields = Object.entries(fields).reduce<Record<string, string>>(
      (accumulator, [key, value]) => {
        if (typeof value === 'string') {
          accumulator[key] = value;
        }

        return accumulator;
      },
      {},
    );

    return Object.keys(safeFields).length > 0 ? safeFields : undefined;
  }

  private resolveSafeExistingAttemptId(
    status: number,
    code: string | undefined,
    existingAttemptId: unknown,
  ): string | undefined {
    if (
      status !== HttpStatus.CONFLICT ||
      code !== 'IDEMPOTENCY_CONFLICT' ||
      typeof existingAttemptId !== 'string'
    ) {
      return undefined;
    }

    return existingAttemptId;
  }

  private resolveSafeChecks(
    checks: unknown,
  ): Record<string, 'ok' | 'error'> | undefined {
    if (!checks || typeof checks !== 'object' || Array.isArray(checks)) {
      return undefined;
    }

    const safeChecks = Object.entries(checks).reduce<
      Record<string, 'ok' | 'error'>
    >((accumulator, [key, value]) => {
      if (value === 'ok' || value === 'error') {
        accumulator[key] = value;
      }

      return accumulator;
    }, {});

    return Object.keys(safeChecks).length > 0 ? safeChecks : undefined;
  }
}
