import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { AppError } from '@core/middleware/error-handler';
import {
  listTrades,
  getTrade,
  createTrade,
  updateTrade,
  deleteTrade,
} from '../services/trades.service';
import { createTradeSchema, updateTradeSchema } from '../types/trading.types';
import { getUserId, getParam, parseBody } from './http';

export const tradesRouter = Router();

const listQuerySchema = z.object({ account_id: z.string().min(1).optional() });

tradesRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new AppError(400, 'Invalid query', 'VALIDATION_ERROR', parsed.error.flatten());
    }
    const data = await listTrades(getUserId(req), parsed.data.account_id);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

tradesRouter.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const input = parseBody(createTradeSchema, req.body);
    const data = await createTrade(getUserId(req), input);
    res.status(201).json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

tradesRouter.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await getTrade(getUserId(req), getParam(req, "id"));
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

tradesRouter.patch('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const input = parseBody(updateTradeSchema, req.body);
    const data = await updateTrade(getUserId(req), getParam(req, "id"), input);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

tradesRouter.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await deleteTrade(getUserId(req), getParam(req, "id"));
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});
