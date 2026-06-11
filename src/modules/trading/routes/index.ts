import { Router } from 'express';
import { accountsRouter } from './accounts.routes';
import { tradesRouter } from './trades.routes';
import { plannedRouter } from './planned.routes';
import { modelsRouter } from './models.routes';
import { pairsRouter } from './pairs.routes';

// Trading Hub API. Mounted under /api/trading with requireAuth applied at the
// mount point in app.ts — every handler can rely on req.user being present.
export const tradingRouter = Router();

tradingRouter.use('/accounts', accountsRouter);
tradingRouter.use('/trades', tradesRouter);
tradingRouter.use('/planned', plannedRouter);
tradingRouter.use('/models', modelsRouter);
tradingRouter.use('/pairs', pairsRouter);

tradingRouter.get('/', (_req, res) => {
  res.json({ message: 'Trading Hub API' });
});
