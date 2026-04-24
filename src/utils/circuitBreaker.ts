import { logger } from "../config/logger";

enum CircuitState {
  CLOSED = "CLOSED", // Normal operation
  OPEN = "OPEN", // Failing, reject requests
  HALF_OPEN = "HALF_OPEN", // Testing if service recovered
}

interface CircuitBreakerConfig {
  failureThreshold: number; // Number of failures before opening
  successThreshold: number; // Number of successes to close from half-open
  timeout: number; // Time in ms before trying half-open
}

class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failureCount: number = 0;
  private successCount: number = 0;
  private nextAttempt: number = Date.now();
  private config: CircuitBreakerConfig;

  constructor(config: CircuitBreakerConfig) {
    this.config = config;
  }

  async execute<T>(fn: () => Promise<T>, fallback: () => Promise<T>): Promise<T> {
    if (this.state === CircuitState.OPEN) {
      if (Date.now() < this.nextAttempt) {
        logger.debug("Circuit breaker OPEN, using fallback");
        return fallback();
      }
      // Try half-open
      this.state = CircuitState.HALF_OPEN;
      logger.info("Circuit breaker entering HALF_OPEN state");
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      logger.warn("Circuit breaker caught error, using fallback", { error });
      return fallback();
    }
  }

  private onSuccess(): void {
    this.failureCount = 0;

    if (this.state === CircuitState.HALF_OPEN) {
      this.successCount++;
      if (this.successCount >= this.config.successThreshold) {
        this.state = CircuitState.CLOSED;
        this.successCount = 0;
        logger.info("Circuit breaker CLOSED - service recovered");
      }
    }
  }

  private onFailure(): void {
    this.failureCount++;
    this.successCount = 0;

    if (this.failureCount >= this.config.failureThreshold) {
      this.state = CircuitState.OPEN;
      this.nextAttempt = Date.now() + this.config.timeout;
      logger.error("Circuit breaker OPEN - too many failures", {
        failureCount: this.failureCount,
        nextAttemptIn: this.config.timeout + "ms",
      });
    }
  }

  getState(): CircuitState {
    return this.state;
  }

  reset(): void {
    this.state = CircuitState.CLOSED;
    this.failureCount = 0;
    this.successCount = 0;
    logger.info("Circuit breaker manually reset");
  }
}

// Export singleton with sensible defaults for Redis
export const redisCircuitBreaker = new CircuitBreaker({
  failureThreshold: 5, // Open after 5 failures
  successThreshold: 2, // Close after 2 successes in half-open
  timeout: 10000, // Try again after 10 seconds
});

