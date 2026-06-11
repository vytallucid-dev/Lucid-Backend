import { Router, type Request, type Response, type NextFunction } from 'express';
import {
  listPlanned,
  getPlanned,
  createPlanned,
  updatePlanned,
  deletePlanned,
} from '../services/planned.service';
import { createPlannedSchema, updatePlannedSchema } from '../types/trading.types';
import { getUserId, getParam, parseBody } from './http';

export const plannedRouter = Router();

plannedRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await listPlanned(getUserId(req));
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

plannedRouter.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const input = parseBody(createPlannedSchema, req.body);
    const data = await createPlanned(getUserId(req), input);
    res.status(201).json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

plannedRouter.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await getPlanned(getUserId(req), getParam(req, "id"));
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

plannedRouter.patch('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const input = parseBody(updatePlannedSchema, req.body);
    const data = await updatePlanned(getUserId(req), getParam(req, "id"), input);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

plannedRouter.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await deletePlanned(getUserId(req), getParam(req, "id"));
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});
