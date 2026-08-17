import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

export interface ApiSuccessEnvelope<T> {
  success: true;
  data: T;
  error: null;
}

/**
 * Wraps every successful controller return value in the standard
 * `{ success, data, error }` envelope. Error responses are produced
 * separately by HttpExceptionFilter so the shape stays consistent
 * whether a request succeeds or throws.
 */
@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<
  T,
  ApiSuccessEnvelope<T>
> {
  intercept(
    _context: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<ApiSuccessEnvelope<T>> {
    return next.handle().pipe(
      map((data) => ({
        success: true as const,
        data,
        error: null,
      })),
    );
  }
}
