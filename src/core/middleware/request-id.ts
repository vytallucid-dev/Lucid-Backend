import { Request, Response, NextFunction } from 'express';
import { v4 as uuid } from 'uuid';

export interface RequestWithId extends Request {
  id: string;
}

export function requestId(req: Request, res: Response, next: NextFunction): void {
  const id = (req.headers['x-request-id'] as string) || uuid();
  (req as RequestWithId).id = id;
  res.setHeader('x-request-id', id);
  next();
}
