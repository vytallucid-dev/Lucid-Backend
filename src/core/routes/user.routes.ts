import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '@core/db/prisma';
import { requireAuth } from '@core/middleware/supabase-auth.middleware';
import { logger } from '@core/utils/logger';

export const userRouter = Router();

userRouter.use(requireAuth);

/**
 * GET /api/user/me
 *
 * Returns the authenticated user's profile from the `users` table.
 * On first call (e.g. right after signup), upserts the record using JWT claims:
 *   - id          ← req.user.sub  (same UUID Supabase uses internally)
 *   - email       ← req.user.email
 *   - displayName ← req.user.user_metadata.full_name (captured at signup)
 *   - role        ← default "user" (admin must be assigned manually in DB)
 */
userRouter.get('/me', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { sub, email } = req.user!;
    const fullName = req.user!.user_metadata?.full_name as string | undefined;

    const dbUser = await prisma.user.upsert({
      where: { id: sub },
      update: {}, // never overwrite existing data on subsequent calls
      create: {
        id: sub,
        email,
        displayName: fullName ?? null,
      },
      select: {
        id: true,
        email: true,
        displayName: true,
        role: true,
        createdAt: true,
      },
    });

    logger.debug({ userId: sub }, 'User profile fetched/created');

    res.json({
      id: dbUser.id,
      email: dbUser.email,
      name: dbUser.displayName,
      role: dbUser.role,
      createdAt: dbUser.createdAt,
    });
  } catch (err) {
    next(err);
  }
});
