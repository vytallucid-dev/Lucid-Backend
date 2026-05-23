import { Router } from 'express';
import { indicatorsRouter } from './indicators.routes';

export const niftyRouter = Router();

// TODO(auth): Add Supabase Auth middleware once auth is built.

niftyRouter.use('/', indicatorsRouter);

niftyRouter.get('/', (_req, res) => {
  res.json({ message: 'NIFTY API' });
});
