import { Router, type Request, type Response, type NextFunction } from 'express';
import { listPairs, createPair, updatePair, deletePair } from '../services/pairs.service';
import { createPairSchema, updatePairSchema } from '../types/trading.types';
import { getUserId, getParam, parseBody } from './http';

export const pairsRouter = Router();

pairsRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await listPairs(getUserId(req));
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

pairsRouter.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const input = parseBody(createPairSchema, req.body);
    const data = await createPair(getUserId(req), input);
    res.status(201).json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

pairsRouter.patch('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const input = parseBody(updatePairSchema, req.body);
    const data = await updatePair(getUserId(req), getParam(req, "id"), input);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

pairsRouter.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await deletePair(getUserId(req), getParam(req, "id"));
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});
