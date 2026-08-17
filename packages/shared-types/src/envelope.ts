/**
 * Standard REST response envelope used by every apps/backend endpoint.
 * Mirrors apps/backend/src/common/response.interceptor.ts (success case)
 * and apps/backend/src/common/http-exception.filter.ts (error case).
 */
export interface ApiSuccessResponse<T> {
  success: true;
  data: T;
  error: null;
}

export interface ApiErrorPayload {
  code: string;
  message: string;
}

export interface ApiErrorResponse {
  success: false;
  data: null;
  error: ApiErrorPayload;
}

export type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;

/** Payload returned by every stub module's placeholder route. */
export interface NotImplementedStatus {
  status: 'not-implemented';
}
