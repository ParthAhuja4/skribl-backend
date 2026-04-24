import { redisClient } from "./redis";
import { logger } from "../config/logger";
import { GameMetrics } from "./metrics";

/**
 * System health monitoring utilities
 */

export interface HealthStatus {
  status: "healthy" | "degraded" | "unhealthy";
  timestamp: string;
  uptime: number;
  checks: {
    redis: HealthCheck;
    memory: HealthCheck;
    eventLoop: HealthCheck;
  };
  metrics?: {
    activeRooms: number;
    activePlayers: number;
    activeGames: number;
  };
}

export interface HealthCheck {
  status: "pass" | "warn" | "fail";
  message?: string;
  responseTime?: number;
  details?: Record<string, any>;
}

/**
 * Check Redis connection health
 */
export async function checkRedisHealth(): Promise<HealthCheck> {
  const start = Date.now();
  try {
    await redisClient.ping();
    const responseTime = Date.now() - start;

    // Get Redis info
    const info = await redisClient.info("memory");
    const usedMemory = parseInt(
      info.match(/used_memory:(\d+)/)?.[1] || "0"
    );
    const maxMemory = parseInt(
      info.match(/maxmemory:(\d+)/)?.[1] || "0"
    );

    const memoryUsagePercent = maxMemory > 0 ? (usedMemory / maxMemory) * 100 : 0;

    return {
      status: responseTime < 100 ? "pass" : "warn",
      message: `Redis responding in ${responseTime}ms`,
      responseTime,
      details: {
        usedMemory: `${(usedMemory / 1024 / 1024).toFixed(2)} MB`,
        memoryUsagePercent: `${memoryUsagePercent.toFixed(2)}%`,
      },
    };
  } catch (error: any) {
    logger.error("Redis health check failed", { error: error.message });
    return {
      status: "fail",
      message: `Redis connection failed: ${error.message}`,
      responseTime: Date.now() - start,
    };
  }
}

/**
 * Check memory usage
 */
export function checkMemoryHealth(): HealthCheck {
  const used = process.memoryUsage();
  const heapUsedMB = used.heapUsed / 1024 / 1024;
  const heapTotalMB = used.heapTotal / 1024 / 1024;
  const heapUsagePercent = (used.heapUsed / used.heapTotal) * 100;
  const rssMB = used.rss / 1024 / 1024;

  // Warn if heap usage is above 80%
  const status = heapUsagePercent > 80 ? "warn" : "pass";

  return {
    status,
    message: `Heap usage: ${heapUsedMB.toFixed(2)}MB / ${heapTotalMB.toFixed(2)}MB (${heapUsagePercent.toFixed(2)}%)`,
    details: {
      heapUsed: `${heapUsedMB.toFixed(2)} MB`,
      heapTotal: `${heapTotalMB.toFixed(2)} MB`,
      heapUsagePercent: `${heapUsagePercent.toFixed(2)}%`,
      rss: `${rssMB.toFixed(2)} MB`,
      external: `${(used.external / 1024 / 1024).toFixed(2)} MB`,
    },
  };
}

/**
 * Check event loop lag
 */
export async function checkEventLoopHealth(): Promise<HealthCheck> {
  return new Promise((resolve) => {
    const start = Date.now();
    setImmediate(() => {
      const lag = Date.now() - start;
      const status = lag > 100 ? "warn" : lag > 500 ? "fail" : "pass";

      resolve({
        status,
        message: `Event loop lag: ${lag}ms`,
        responseTime: lag,
      });
    });
  });
}

/**
 * Get comprehensive health status
 */
export async function getHealthStatus(): Promise<HealthStatus> {
  const [redis, memory, eventLoop] = await Promise.all([
    checkRedisHealth(),
    Promise.resolve(checkMemoryHealth()),
    checkEventLoopHealth(),
  ]);

  // Determine overall status
  let status: "healthy" | "degraded" | "unhealthy" = "healthy";
  if (
    redis.status === "fail" ||
    memory.status === "fail" ||
    eventLoop.status === "fail"
  ) {
    status = "unhealthy";
  } else if (
    redis.status === "warn" ||
    memory.status === "warn" ||
    eventLoop.status === "warn"
  ) {
    status = "degraded";
  }

  return {
    status,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    checks: {
      redis,
      memory,
      eventLoop,
    },
  };
}

/**
 * Start periodic health monitoring
 */
export function startHealthMonitoring(intervalSeconds: number = 60): NodeJS.Timeout {
  const interval = setInterval(async () => {
    try {
      const health = await getHealthStatus();

      if (health.status === "unhealthy") {
        logger.error("System health check: UNHEALTHY", { health });
      } else if (health.status === "degraded") {
        logger.warn("System health check: DEGRADED", { health });
      } else {
        logger.debug("System health check: HEALTHY", { health });
      }
    } catch (error) {
      logger.error("Health monitoring failed", { error });
    }
  }, intervalSeconds * 1000);

  logger.info(`Health monitoring started (interval: ${intervalSeconds}s)`);
  return interval;
}

/**
 * Graceful shutdown handler
 */
export async function gracefulShutdown(
  server: any,
  io: any,
  signal: string
): Promise<void> {
  logger.info(`${signal} received, starting graceful shutdown...`);

  // Stop accepting new connections
  server.close(() => {
    logger.info("HTTP server closed");
  });

  // Close all Socket.IO connections gracefully
  const sockets = await io.fetchSockets();
  logger.info(`Closing ${sockets.length} active socket connections`);

  for (const socket of sockets) {
    socket.emit("server_shutdown", {
      message: "Server is shutting down. Please reconnect in a moment.",
    });
    socket.disconnect(true);
  }

  // Close Socket.IO server
  io.close(() => {
    logger.info("Socket.IO server closed");
  });

  // Close Redis connection
  await redisClient.quit();
  logger.info("Redis connection closed");

  // Give some time for cleanup
  await new Promise((resolve) => setTimeout(resolve, 1000));

  logger.info("Graceful shutdown completed");
  process.exit(0);
}

