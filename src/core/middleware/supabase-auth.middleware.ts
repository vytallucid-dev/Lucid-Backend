import type { Request, Response, NextFunction } from 'express';
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { AppError } from './error-handler';
import { logger } from '@core/utils/logger';
import { env } from '@config/env';
import { prisma } from '@core/db/prisma';

export type AppRole = 'user' | 'admin';

export interface SupabaseJwtPayload extends JWTPayload {
  sub: string;
  email: string;
  app_metadata?: {
    role?: AppRole;
    provider?: string;
    providers?: string[];
  };
  user_metadata?: Record<string, unknown>;
  role?: string;
  aud: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: SupabaseJwtPayload;
  }
}

// Cached JWKS resolver. Initialized lazily so env validation runs first and so
// the network is not touched until the first JWT verification.
let jwksResolver: JWTVerifyGetKey | undefined;

function getJwks(): JWTVerifyGetKey {
  if (jwksResolver) return jwksResolver;
  jwksResolver = createRemoteJWKSet(
    new URL(`${env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`),
    {
      cacheMaxAge: 10 * 60 * 1000,
      cooldownDuration: 30 * 1000,
    },
  );
  return jwksResolver;
}

// Test-only hook: lets tests inject a mock JWKS resolver.
export function __setJwksResolverForTests(resolver: JWTVerifyGetKey | undefined): void {
  jwksResolver = resolver;
}

function unauthorized(): AppError {
  return new AppError(401, 'Authentication required', 'UNAUTHORIZED');
}

async function verifyAuth(req: Request): Promise<void> {
  const authHeader = req.header('authorization');

  if (!authHeader || !/^bearer\s/i.test(authHeader)) {
    logger.warn(
      { path: req.path, ip: req.ip },
      'Auth failed: missing or malformed authorization header',
    );
    throw unauthorized();
  }

  const token = authHeader.slice(authHeader.indexOf(' ') + 1).trim();
  if (!token) {
    logger.warn({ path: req.path, ip: req.ip }, 'Auth failed: empty bearer token');
    throw unauthorized();
  }

  let payload: JWTPayload;
  try {
    const result = await jwtVerify(token, getJwks(), {
      audience: 'authenticated',
      issuer: `${env.SUPABASE_URL}/auth/v1`,
    });
    payload = result.payload;
  } catch (err) {
    logger.warn(
      {
        path: req.path,
        ip: req.ip,
        error: err instanceof Error ? err.message : 'unknown',
      },
      'Auth failed: JWT verification error',
    );
    throw unauthorized();
  }

  const typed = payload as SupabaseJwtPayload;
  if (typeof typed.sub !== 'string' || typeof typed.email !== 'string') {
    logger.warn({ path: req.path }, 'Auth failed: JWT missing required claims (sub/email)');
    throw unauthorized();
  }

  req.user = typed;
}

/**
 * Verify a Supabase-issued JWT from the Authorization: Bearer <token> header.
 *
 * On success: req.user is set to the verified payload, next() is called.
 * On any failure (missing header, bad format, expired, wrong audience, missing
 * claims, etc.) a generic 401 is forwarded via next(err). The specific reason
 * is logged at warn level for ops, but never leaked to the client.
 *
 * Wraps the async work and routes rejections to next() so Express 4's
 * synchronous error machinery picks them up.
 */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  verifyAuth(req).then(() => next()).catch(next);
}

/**
 * Require a specific role on the authenticated user. Must be composed AFTER
 * requireAuth — if req.user is missing this returns 500 (programmer error,
 * not an auth failure).
 *
 * Role is read from the `users` table (DB-authoritative), NOT from the JWT
 * app_metadata. This allows role changes to take effect without re-issuing
 * tokens.
 */
export function requireRole(role: AppRole) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      logger.error(
        { path: req.path },
        'requireRole invoked without prior requireAuth — middleware misconfiguration',
      );
      return next(new AppError(500, 'Authentication required', 'AUTH_CONFIG_ERROR'));
    }

    try {
      const dbUser = await prisma.user.findUnique({
        where: { id: req.user.sub },
        select: { role: true },
      });

      const userRole = dbUser?.role as AppRole | undefined;
      if (!dbUser || userRole !== role) {
        logger.warn(
          {
            path: req.path,
            userId: req.user.sub,
            userRole: userRole ?? 'not_found',
            requiredRole: role,
          },
          'Authorization denied: insufficient role',
        );
        return next(new AppError(403, 'Insufficient permissions', 'FORBIDDEN'));
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}
