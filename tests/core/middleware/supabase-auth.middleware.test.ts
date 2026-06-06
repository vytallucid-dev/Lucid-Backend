import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('@config/env', () => ({
  env: {
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_ANON_KEY: 'anon',
    SUPABASE_SERVICE_ROLE_KEY: 'service',
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    ALLOWED_ORIGINS: ['http://localhost:3000'],
  },
}));

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    user: { findUnique: vi.fn() },
  },
}));

vi.mock('@core/db/prisma', () => ({
  prisma: prismaMock,
}));

const jwtVerifyMock = vi.fn();

vi.mock('jose', async () => {
  const actual = await vi.importActual<typeof import('jose')>('jose');
  return {
    ...actual,
    createRemoteJWKSet: () => () => Promise.resolve({ type: 'mock' }),
    jwtVerify: (...args: unknown[]) => jwtVerifyMock(...args),
  };
});

import {
  requireAuth,
  requireRole,
  type SupabaseJwtPayload,
} from '@core/middleware/supabase-auth.middleware';
import { errorHandler } from '@core/middleware/error-handler';

function appWithRequireAuth() {
  const app = express();
  app.get('/protected', requireAuth, (req, res) => {
    res.json({ ok: true, sub: req.user?.sub, email: req.user?.email });
  });
  app.use(errorHandler);
  return app;
}

function appWithRoleCheck(role: 'admin', mockUser?: SupabaseJwtPayload) {
  const app = express();
  // Optional injector to set req.user without going through requireAuth
  app.use((req, _res, next) => {
    if (mockUser !== undefined) req.user = mockUser;
    next();
  });
  app.get('/admin', requireRole(role), (_req, res) => {
    res.json({ ok: true });
  });
  app.use(errorHandler);
  return app;
}

const validPayload: SupabaseJwtPayload = {
  sub: 'user-uuid-123',
  email: 'aman@example.com',
  aud: 'authenticated',
  app_metadata: { role: 'user' },
};

describe('requireAuth', () => {
  beforeEach(() => {
    jwtVerifyMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('passes when JWT is valid and populates req.user', async () => {
    jwtVerifyMock.mockResolvedValueOnce({ payload: validPayload });
    const res = await request(appWithRequireAuth())
      .get('/protected')
      .set('Authorization', 'Bearer valid.jwt.token');
    expect(res.status).toBe(200);
    expect(res.body.sub).toBe('user-uuid-123');
    expect(res.body.email).toBe('aman@example.com');
  });

  it('returns 401 when Authorization header is missing', async () => {
    const res = await request(appWithRequireAuth()).get('/protected');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(res.body.error.message).toBe('Authentication required');
    expect(jwtVerifyMock).not.toHaveBeenCalled();
  });

  it('returns 401 when Authorization is not Bearer', async () => {
    const res = await request(appWithRequireAuth())
      .get('/protected')
      .set('Authorization', 'Basic abc==');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(jwtVerifyMock).not.toHaveBeenCalled();
  });

  it('returns 401 when token after Bearer is empty', async () => {
    const res = await request(appWithRequireAuth())
      .get('/protected')
      .set('Authorization', 'Bearer ');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(jwtVerifyMock).not.toHaveBeenCalled();
  });

  it('returns 401 when jwtVerify throws (expired / invalid signature / wrong audience)', async () => {
    jwtVerifyMock.mockRejectedValueOnce(new Error('JWTExpired'));
    const res = await request(appWithRequireAuth())
      .get('/protected')
      .set('Authorization', 'Bearer expired.jwt.token');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(res.body.error.message).toBe('Authentication required');
    // Generic message — no leak of "expired" to client
    expect(JSON.stringify(res.body)).not.toContain('JWTExpired');
  });

  it('returns 401 when JWT is missing sub', async () => {
    jwtVerifyMock.mockResolvedValueOnce({
      payload: { email: 'x@y.com', aud: 'authenticated' },
    });
    const res = await request(appWithRequireAuth())
      .get('/protected')
      .set('Authorization', 'Bearer token');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('returns 401 when JWT is missing email', async () => {
    jwtVerifyMock.mockResolvedValueOnce({
      payload: { sub: 'abc', aud: 'authenticated' },
    });
    const res = await request(appWithRequireAuth())
      .get('/protected')
      .set('Authorization', 'Bearer token');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('verifies with correct audience and issuer', async () => {
    jwtVerifyMock.mockResolvedValueOnce({ payload: validPayload });
    await request(appWithRequireAuth())
      .get('/protected')
      .set('Authorization', 'Bearer token');
    expect(jwtVerifyMock).toHaveBeenCalledTimes(1);
    const opts = jwtVerifyMock.mock.calls[0][2] as { audience: string; issuer: string };
    expect(opts.audience).toBe('authenticated');
    expect(opts.issuer).toBe('https://test.supabase.co/auth/v1');
  });
});

describe('requireRole', () => {
  it('passes when user has matching role', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ role: 'admin' });
    const admin: SupabaseJwtPayload = {
      sub: 'u1',
      email: 'a@b.com',
      aud: 'authenticated',
      app_metadata: { role: 'admin' },
    };
    const res = await request(appWithRoleCheck('admin', admin)).get('/admin');
    expect(res.status).toBe(200);
  });

  it('returns 403 when user has wrong role', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ role: 'user' });
    const user: SupabaseJwtPayload = {
      sub: 'u1',
      email: 'a@b.com',
      aud: 'authenticated',
      app_metadata: { role: 'user' },
    };
    const res = await request(appWithRoleCheck('admin', user)).get('/admin');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('returns 403 when app_metadata.role is undefined', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);
    const user: SupabaseJwtPayload = {
      sub: 'u1',
      email: 'a@b.com',
      aud: 'authenticated',
    };
    const res = await request(appWithRoleCheck('admin', user)).get('/admin');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('returns 500 AUTH_CONFIG_ERROR when requireAuth was not applied first', async () => {
    const res = await request(appWithRoleCheck('admin', undefined)).get('/admin');
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('AUTH_CONFIG_ERROR');
  });
});
