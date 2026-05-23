import { Request, Response, NextFunction } from 'express';
import { logger } from '@core/utils/logger';
import { env } from '@config/env';

export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code?: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
    Error.captureStackTrace(this, this.constructor);
  }
}

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const requestId = (req as Request & { id?: string }).id;

  if (err instanceof AppError) {
    logger.warn(
      { err, requestId, statusCode: err.statusCode, code: err.code },
      `Handled error: ${err.message}`,
    );
    res.status(err.statusCode).json({
      error: {
        message: err.message,
        code: err.code,
        ...(env.NODE_ENV === 'development' && { details: err.details }),
      },
      requestId,
    });
    return;
  }

  logger.error({ err, requestId }, `Unhandled error: ${err.message}`);
  res.status(500).json({
    error: {
      message: env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
      code: 'INTERNAL_ERROR',
    },
    requestId,
  });
}

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: {
      message: `Route not found: ${req.method} ${req.path}`,
      code: 'NOT_FOUND',
    },
  });
}
