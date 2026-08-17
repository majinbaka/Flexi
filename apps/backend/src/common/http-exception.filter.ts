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
    const { code, message } = this.resolveErrorPayload(
      exception,
      isHttpException,
    );

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `${request.method} ${request.url} -> ${status} ${message}`,
        (exception as Error)?.stack,
      );
    }

    const envelope: ApiErrorEnvelope = {
      success: false,
      data: null,
      error: { code, message },
    };

    response.status(status).json(envelope);
  }

  private resolveErrorPayload(
    exception: unknown,
    isHttpException: boolean,
  ): { code: string; message: string } {
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
      };
      const message = Array.isArray(body.message)
        ? body.message.join(', ')
        : body.message;

      return {
        code: body.error ?? HttpStatus[status] ?? 'HTTP_ERROR',
        message: message ?? httpException.message,
      };
    }

    return {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred',
    };
  }
}
