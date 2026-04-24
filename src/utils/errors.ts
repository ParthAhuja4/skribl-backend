import { Request, Response, NextFunction } from "express";
import { logger } from "../config/logger";
import { GameMetrics } from "./metrics";

/**
 * Error classes for different types of errors
 */

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly isOperational: boolean;
  public readonly code?: string;

  constructor(
    message: string,
    statusCode: number = 500,
    isOperational: boolean = true,
    code?: string
  ) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    this.code = code;

    Error.captureStackTrace(this, this.constructor);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, code?: string) {
    super(message, 400, true, code || "VALIDATION_ERROR");
  }
}

export class NotFoundError extends AppError {
  constructor(message: string = "Resource not found") {
    super(message, 404, true, "NOT_FOUND");
  }
}

export class UnauthorizedError extends AppError {
  constructor(message: string = "Unauthorized") {
    super(message, 401, true, "UNAUTHORIZED");
  }
}

export class ForbiddenError extends AppError {
  constructor(message: string = "Forbidden") {
    super(message, 403, true, "FORBIDDEN");
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, 409, true, "CONFLICT");
  }
}

export class RateLimitError extends AppError {
  constructor(message: string = "Too many requests") {
    super(message, 429, true, "RATE_LIMIT_EXCEEDED");
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message: string = "Service temporarily unavailable") {
    super(message, 503, true, "SERVICE_UNAVAILABLE");
  }
}

/**
 * Error handler middleware
 */
export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  let error = err;

  // Convert non-AppError to AppError
  if (!(error instanceof AppError)) {
    const statusCode = 500;
    const message = error.message || "Internal server error";
    error = new AppError(message, statusCode, false);
  }

  const appError = error as AppError;

  // Log error
  if (appError.statusCode >= 500) {
    logger.error("Server error", {
      error: appError.message,
      stack: appError.stack,
      url: req.url,
      method: req.method,
      ip: req.ip,
    });
    GameMetrics.trackError("server");
  } else {
    logger.warn("Client error", {
      error: appError.message,
      code: appError.code,
      url: req.url,
      method: req.method,
      ip: req.ip,
    });
    GameMetrics.trackError("client");
  }

  // Send error response
  res.status(appError.statusCode).json({
    status: "error",
    code: appError.code,
    message: appError.message,
    ...(process.env.NODE_ENV === "development" && {
      stack: appError.stack,
    }),
  });
}

/**
 * Not found handler
 */
export function notFoundHandler(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const error = new NotFoundError(`Route ${req.url} not found`);
  next(error);
}

/**
 * Async error wrapper
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<any>
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * Socket.IO error handler
 */
export function handleSocketError(socket: any, error: Error): void {
  if (error instanceof AppError) {
    socket.emit("error", {
      code: error.code,
      message: error.message,
    });
    
    logger.warn("Socket error", {
      socketId: socket.id,
      error: error.message,
      code: error.code,
    });
  } else {
    socket.emit("error", {
      code: "INTERNAL_ERROR",
      message: "An unexpected error occurred",
    });
    
    logger.error("Unexpected socket error", {
      socketId: socket.id,
      error: error.message,
      stack: error.stack,
    });
  }

  GameMetrics.trackError("socket");
}

/**
 * Circuit breaker for external services
 */
export class CircuitBreaker {
  private failures: number = 0;
  private lastFailureTime: number = 0;
  private state: "CLOSED" | "OPEN" | "HALF_OPEN" = "CLOSED";

  constructor(
    private threshold: number = 5,
    private timeout: number = 60000 // 1 minute
  ) {}

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === "OPEN") {
      if (Date.now() - this.lastFailureTime > this.timeout) {
        this.state = "HALF_OPEN";
      } else {
        throw new ServiceUnavailableError("Service circuit breaker is open");
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    this.failures = 0;
    this.state = "CLOSED";
  }

  private onFailure(): void {
    this.failures++;
    this.lastFailureTime = Date.now();

    if (this.failures >= this.threshold) {
      this.state = "OPEN";
      logger.error("Circuit breaker opened", { failures: this.failures });
    }
  }

  getState(): string {
    return this.state;
  }

  reset(): void {
    this.failures = 0;
    this.state = "CLOSED";
    logger.info("Circuit breaker reset");
  }
}

/**
 * Retry mechanism with exponential backoff
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  baseDelay: number = 1000
): Promise<T> {
  let lastError: Error;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      
      if (attempt < maxRetries - 1) {
        const delay = baseDelay * Math.pow(2, attempt);
        logger.warn(`Retry attempt ${attempt + 1}/${maxRetries} after ${delay}ms`, {
          error: lastError.message,
        });
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError!;
}

export default {
  AppError,
  ValidationError,
  NotFoundError,
  UnauthorizedError,
  ForbiddenError,
  ConflictError,
  RateLimitError,
  ServiceUnavailableError,
  errorHandler,
  notFoundHandler,
  asyncHandler,
  handleSocketError,
  CircuitBreaker,
  retryWithBackoff,
};

