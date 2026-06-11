import { Router, type Request, type Response, type NextFunction } from 'express';
import {
  listAccounts,
  getAccount,
  createAccount,
  updateAccount,
  deleteAccount,
  addCashFlow,
} from '../services/accounts.service';
import {
  createAccountSchema,
  updateAccountSchema,
  cashFlowSchema,
} from '../types/trading.types';
import { getUserId, getParam, parseBody } from './http';

export const accountsRouter = Router();

accountsRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await listAccounts(getUserId(req));
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

accountsRouter.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const input = parseBody(createAccountSchema, req.body);
    const data = await createAccount(getUserId(req), input);
    res.status(201).json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

accountsRouter.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await getAccount(getUserId(req), getParam(req, "id"));
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

accountsRouter.patch('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const input = parseBody(updateAccountSchema, req.body);
    const data = await updateAccount(getUserId(req), getParam(req, "id"), input);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

accountsRouter.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await deleteAccount(getUserId(req), getParam(req, "id"));
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

accountsRouter.post('/:id/cash-flows', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const input = parseBody(cashFlowSchema, req.body);
    const data = await addCashFlow(getUserId(req), getParam(req, "id"), input);
    res.status(201).json({ success: true, data });
  } catch (err) {
    next(err);
  }
});
