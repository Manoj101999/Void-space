/**
 * Application error taxonomy (SRS FR-2.4: 401 for expired/malformed tokens, 403
 * for insufficient scope, 409 for conflicts such as publishing a non-approved
 * asset).
 *
 * Every error carries a stable `code` the frontend can branch on (instead of
 * matching on prose) and an `expose` flag controlling whether the message is
 * safe to return to the caller.
 */

export interface AppErrorOptions {
  readonly statusCode?: number;
  readonly code: string;
  readonly details?: unknown;
  readonly expose?: boolean;
  readonly cause?: unknown;
}

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;
  readonly expose: boolean;

  constructor(message: string, options: AppErrorOptions) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.statusCode = options.statusCode ?? 500;
    this.code = options.code;
    this.details = options.details;
    this.expose = options.expose ?? this.statusCode < 500;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, { statusCode: 400, code: 'VALIDATION_ERROR', details });
  }
}

export class UnauthenticatedError extends AppError {
  constructor(message = 'Authentication required', code = 'UNAUTHENTICATED') {
    super(message, { statusCode: 401, code });
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to perform this action', code = 'FORBIDDEN', details?: unknown) {
    super(message, { statusCode: 403, code, details });
  }
}

export class NotFoundError extends AppError {
  constructor(resource = 'Resource') {
    super(`${resource} not found`, { statusCode: 404, code: 'NOT_FOUND' });
  }
}

export class ConflictError extends AppError {
  constructor(message: string, code = 'CONFLICT', details?: unknown) {
    super(message, { statusCode: 409, code, details });
  }
}

export class RateLimitError extends AppError {
  constructor(retryAfterSeconds: number) {
    super('Rate limit exceeded', {
      statusCode: 429,
      code: 'RATE_LIMITED',
      details: { retryAfterSeconds },
    });
  }
}

export class ServiceUnavailableError extends AppError {
  /**
   * `details` exists because the message is not exposed for a 5xx (see the error handler: "5xx
   * messages are never leaked to the caller"). That policy is right — an upstream failure message
   * can carry a hostname or a driver string — but it left a caller unable to tell "the vendor says
   * the model is gone (404)" from "the vendor is down", which are different things to do something
   * about. Structured `details` is the sanctioned channel for exactly that, so an upstream status
   * goes here rather than into the message.
   */
  constructor(message: string, code = 'SERVICE_UNAVAILABLE', details?: unknown) {
    super(message, { statusCode: 503, code, details });
  }
}

/** True when an unknown throwable is one of ours (so its message is safe). */
export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
