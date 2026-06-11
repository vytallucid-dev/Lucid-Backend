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

    // The name captured at signup lives in user_metadata. Accept the common
    // keys (full_name is what this app's signup sets) and never fall back to
    // the email.
    const meta = req.user!.user_metadata ?? {};
    const rawName = (meta.full_name ?? meta.name ?? meta.display_name) as unknown;
    const name = typeof rawName === 'string' && rawName.trim() ? rawName.trim() : null;

    // The auth.users → public.users trigger may have already created the row
    // (historically with a missing/incorrect display name). Backfill the name
    // on first load and repair any row whose display name is blank or was left
    // as the email — but never clobber a real, user-set name.
    const existing = await prisma.user.findUnique({
      where: { id: sub },
      select: { displayName: true },
    });
    const displayNameNeedsFix =
      !existing ||
      existing.displayName == null ||
      existing.displayName.trim() === '' ||
      existing.displayName === email;

    const dbUser = await prisma.user.upsert({
      where: { id: sub },
      update: displayNameNeedsFix && name ? { displayName: name } : {},
      create: {
        id: sub,
        email,
        displayName: name,
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
