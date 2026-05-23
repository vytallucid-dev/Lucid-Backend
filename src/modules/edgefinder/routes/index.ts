import { Router } from 'express';

export const edgefinderRouter = Router();

// TODO(auth): Add Supabase Auth middleware once auth is built.
// EdgeFinder routes will be built in a later phase.

edgefinderRouter.get('/', (_req, res) => {
  res.json({ message: 'EdgeFinder API. Build pending.' });
});
