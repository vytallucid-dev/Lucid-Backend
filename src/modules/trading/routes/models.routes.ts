import { Router, type Request, type Response, type NextFunction } from 'express';
import {
  listModels,
  createModel,
  updateModel,
  deleteModel,
} from '../services/models.service';
import { createModelSchema, updateModelSchema } from '../types/trading.types';
import { getUserId, getParam, parseBody } from './http';

export const modelsRouter = Router();

modelsRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await listModels(getUserId(req));
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

modelsRouter.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const input = parseBody(createModelSchema, req.body);
    const data = await createModel(getUserId(req), input);
    res.status(201).json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

modelsRouter.patch('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const input = parseBody(updateModelSchema, req.body);
    const data = await updateModel(getUserId(req), getParam(req, "id"), input);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

modelsRouter.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await deleteModel(getUserId(req), getParam(req, "id"));
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});
