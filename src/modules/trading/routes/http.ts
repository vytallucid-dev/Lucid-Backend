import type { Request } from 'express';
import { z } from 'zod';
import { AppError } from '@core/middleware/error-handler';

/** Pulls the authenticated Supabase user id (set by requireAuth) or throws 401. */
export function getUserId(req: Request): string {
  const id = req.user?.sub;
  if (!id) throw new AppError(401, 'Authentication required', 'UNAUTHORIZED');
  return id;
}

/** Reads a route param as a single string (Express types params loosely). */
export function getParam(req: Request, name: string): string {
  const v = req.params[name];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Validates a body against a Zod schema, throwing a 400 VALIDATION_ERROR on
 * failure. Returns the schema's *output* type so `.default()`/transforms are
 * reflected (no longer optional) in the result.
 */
export function parseBody<S extends z.ZodTypeAny>(schema: S, body: unknown): z.infer<S> {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    throw new AppError(400, 'Invalid request body', 'VALIDATION_ERROR', parsed.error.flatten());
  }
  return parsed.data;
}
