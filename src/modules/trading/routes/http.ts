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
 *
 * Failures come back as a flat `problems: [{ field, message }]` list keyed by
 * the FULL dotted path — `executions.0.risk_pct`, not just `executions`. Zod's
 * own `.flatten()` collapses everything nested under its first path segment,
 * which for a create-trade payload means every fill-level rule lands on one
 * key and the client cannot tell which account row it belongs to. The shape
 * matches what the service layer raises for the cross-object rules it enforces
 * itself, so a client has one error format to read, not two.
 *
 * The thrown message repeats the first problem so the error is specific even
 * where `details` is stripped (see errorHandler — details are development-only).
 */
export function parseBody<S extends z.ZodTypeAny>(schema: S, body: unknown): z.infer<S> {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => ({
      field: issue.path.join('.'),
      message: issue.message,
    }));
    throw new AppError(
      400,
      problems[0]?.message ?? 'Invalid request body',
      'VALIDATION_ERROR',
      { problems },
    );
  }
  return parsed.data;
}
