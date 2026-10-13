/**
 * Request-scoped helpers: correlation metadata for audit rows and Zod parsing
 * that produces the same error envelope as the rest of the API.
 */
import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';

import { ValidationError } from './errors';

/** Client metadata recorded on sessions and audit entries (§3.9). */
export interface RequestContext {
  readonly userAgent?: string | undefined;
  readonly ipAddress?: string | undefined;
}

export function requestContext(request: FastifyRequest): RequestContext {
  const userAgent = request.headers['user-agent'];
  return {
    userAgent: typeof userAgent === 'string' ? userAgent.slice(0, 300) : undefined,
    ipAddress: request.ip,
  };
}

/**
 * Parses and validates a payload, converting Zod issues into a 400 with
 * field-level detail so the UI can highlight the offending input.
 */
export function parseBody<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new ValidationError('Request validation failed', {
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
  return result.data;
}

export function parseParams<T extends z.ZodTypeAny>(schema: T, params: unknown): z.infer<T> {
  const result = schema.safeParse(params);
  if (!result.success) {
    throw new ValidationError('Invalid path parameters', {
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
  return result.data;
}

export function parseQuery<T extends z.ZodTypeAny>(schema: T, query: unknown): z.infer<T> {
  const result = schema.safeParse(query);
  if (!result.success) {
    throw new ValidationError('Invalid query parameters', {
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
  return result.data;
}
