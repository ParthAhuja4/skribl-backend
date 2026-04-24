import { logger } from "../config/logger";
import { getRedisHealth, RedisHealthStatus } from "./redis";

// Track Redis health history for monitoring
interface HealthCheckResult {
  timestamp: Date;
  healthy: boolean;
  mode: "redis" | "in-memory";
  lastError?: string;
}

const healthHistory: HealthCheckResult[] = [];
const MAX_HISTORY_SIZE = 100;
let consecutiveFailures = 0;
let lastAlertTime = 0;
const ALERT_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes between alerts

/**
 * Start monitoring Redis health periodically
 */
export function startRedisHealthMonitoring(intervalMs: number = 30000): NodeJS.Timeout {
  logger.info("Starting Redis health monitoring", { intervalMs });
  
  // Initial check
  checkRedisHealth();
  
  // Periodic checks
  return setInterval(async () => {
    await checkRedisHealth();
  }, intervalMs);
}

/**
 * Check Redis health and log warnings/alerts
 */
async function checkRedisHealth(): Promise<void> {
  try {
    const health = await getRedisHealth();
    const isHealthy = health.ready || health.mode === "in-memory";
    
    // Record in history
    healthHistory.push({
      timestamp: new Date(),
      healthy: isHealthy,
      mode: health.mode,
      lastError: health.lastError,
    });
    
    // Trim history
    if (healthHistory.length > MAX_HISTORY_SIZE) {
      healthHistory.shift();
    }
    
    // Track consecutive failures
    if (!health.ready && health.mode === "redis") {
      consecutiveFailures++;
      
      // Alert on prolonged failures
      if (consecutiveFailures === 3) {
        sendAlert("warning", "Redis connection unstable", health);
      } else if (consecutiveFailures === 10) {
        sendAlert("critical", "Redis connection down for extended period", health);
      } else if (consecutiveFailures >= 20 && consecutiveFailures % 10 === 0) {
        sendAlert("critical", `Redis still down (${consecutiveFailures} consecutive failures)`, health);
      }
    } else if (health.ready) {
      // Reset on recovery
      if (consecutiveFailures > 0) {
        logger.info("Redis connection recovered", {
          previousFailures: consecutiveFailures,
          mode: health.mode,
        });
        consecutiveFailures = 0;
      }
    }
    
    // Check for high memory usage
    if (health.memory && health.memory.fragmentation > 2.0) {
      logger.warn("High Redis memory fragmentation", {
        fragmentation: health.memory.fragmentation,
        used: health.memory.used,
      });
    }
    
    // Check for degraded performance
    if (health.stats && health.stats.opsPerSec < 100 && health.ready) {
      logger.warn("Low Redis operations per second", {
        opsPerSec: health.stats.opsPerSec,
      });
    }
    
    // Log periodic health summary (every 10 checks = ~5 minutes if interval is 30s)
    if (healthHistory.length % 10 === 0 && healthHistory.length > 0) {
      logHealthSummary();
    }
  } catch (error) {
    logger.error("Error checking Redis health", { error });
  }
}

/**
 * Send alert for Redis issues
 */
function sendAlert(
  level: "info" | "warning" | "critical",
  message: string,
  health: RedisHealthStatus
): void {
  const now = Date.now();
  
  // Rate limit alerts
  if (now - lastAlertTime < ALERT_COOLDOWN_MS) {
    logger.debug("Alert suppressed due to cooldown", { message, level });
    return;
  }
  
  lastAlertTime = now;
  
  const alertData = {
    level,
    message,
    redis: {
      available: health.available,
      connected: health.connected,
      ready: health.ready,
      status: health.status,
      mode: health.mode,
      lastError: health.lastError,
      consecutiveFailures,
    },
    timestamp: new Date().toISOString(),
  };
  
  switch (level) {
    case "critical":
      logger.error("🚨 REDIS CRITICAL ALERT", alertData);
      // TODO: Integrate with alerting system (PagerDuty, Slack, etc.)
      break;
    case "warning":
      logger.warn("⚠️  REDIS WARNING", alertData);
      // TODO: Integrate with alerting system
      break;
    case "info":
      logger.info("ℹ️  REDIS INFO", alertData);
      break;
  }
}

/**
 * Log health summary from recent history
 */
function logHealthSummary(): void {
  if (healthHistory.length === 0) return;
  
  const recentChecks = healthHistory.slice(-10);
  const healthyCount = recentChecks.filter((h) => h.healthy).length;
  const failureCount = recentChecks.length - healthyCount;
  const healthPercentage = (healthyCount / recentChecks.length) * 100;
  
  const mode = recentChecks[recentChecks.length - 1]?.mode || "unknown";
  
  logger.info("Redis health summary", {
    period: "last 10 checks",
    healthy: healthyCount,
    failures: failureCount,
    healthPercentage: `${healthPercentage.toFixed(1)}%`,
    currentMode: mode,
    consecutiveFailures,
  });
}

/**
 * Get recent health history
 */
export function getHealthHistory(limit: number = 20): HealthCheckResult[] {
  return healthHistory.slice(-limit);
}

/**
 * Get health statistics
 */
export function getHealthStats(): {
  totalChecks: number;
  healthyChecks: number;
  failedChecks: number;
  healthPercentage: number;
  consecutiveFailures: number;
  currentMode: string;
} {
  const healthyCount = healthHistory.filter((h) => h.healthy).length;
  const totalCount = healthHistory.length;
  
  return {
    totalChecks: totalCount,
    healthyChecks: healthyCount,
    failedChecks: totalCount - healthyCount,
    healthPercentage: totalCount > 0 ? (healthyCount / totalCount) * 100 : 100,
    consecutiveFailures,
    currentMode: healthHistory[healthHistory.length - 1]?.mode || "unknown",
  };
}

/**
 * Stop monitoring
 */
export function stopRedisHealthMonitoring(interval: NodeJS.Timeout): void {
  clearInterval(interval);
  logger.info("Stopped Redis health monitoring");
}
