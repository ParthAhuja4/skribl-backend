import { redisClient } from "./redis";
import { logger } from "../config/logger";

/**
 * ✅ CRITICAL FIX: Simple distributed lock using Redis
 * Prevents race conditions when multiple players join a room simultaneously
 * 
 * Without this, when 5-6 players join at once:
 * - All read the room state at the same time (e.g., 1 player)
 * - All add themselves and write back
 * - Last write wins, losing some player joins!
 * 
 * With this lock:
 * - Only ONE player can modify the room at a time
 * - Others wait their turn
 * - All joins are properly recorded
 */

const LOCK_TTL = 5000; // 5 seconds max lock time (prevents deadlocks)
const LOCK_RETRY_DELAY = 50; // 50ms between retry attempts
const MAX_RETRIES = 40; // Max 2 seconds wait (40 * 50ms)

export class RedisLock {
  /**
   * Acquire a distributed lock
   * @param lockKey - Unique key for this lock (e.g., "room:lock:ABCD")
   * @param retries - Number of times to retry acquiring the lock
   * @returns true if lock acquired, false if failed
   */
  static async acquire(lockKey: string, retries = MAX_RETRIES): Promise<boolean> {
    for (let i = 0; i < retries; i++) {
      try {
        // Try to set the lock key with NX (only if not exists) and expiration
        const result = await redisClient.set(
          lockKey,
          Date.now().toString(),
          'PX', // Milliseconds
          LOCK_TTL,
          'NX' // Only set if not exists
        );

        if (result === 'OK') {
          logger.debug("Lock acquired", { lockKey, attempt: i + 1 });
          return true;
        }

        // Lock is held by someone else, wait and retry
        await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_DELAY));
      } catch (error) {
        logger.error("Error acquiring lock", { lockKey, error });
        // If Redis is down, proceed without lock (fail-open, not fail-closed)
        return true;
      }
    }

    logger.warn("Failed to acquire lock after retries", { 
      lockKey, 
      retries,
      waitTime: `${retries * LOCK_RETRY_DELAY}ms` 
    });
    return false;
  }

  /**
   * Release a distributed lock
   * @param lockKey - The lock key to release
   */
  static async release(lockKey: string): Promise<void> {
    try {
      await redisClient.del(lockKey);
      logger.debug("Lock released", { lockKey });
    } catch (error) {
      logger.error("Error releasing lock", { lockKey, error });
      // Non-fatal - lock will auto-expire after TTL
    }
  }

  /**
   * Execute a function with a lock (automatic acquire + release)
   * @param lockKey - The lock key
   * @param fn - Function to execute while holding the lock
   * @returns Result of the function
   */
  static async withLock<T>(
    lockKey: string,
    fn: () => Promise<T>
  ): Promise<T | null> {
    const acquired = await this.acquire(lockKey);
    
    if (!acquired) {
      logger.warn("Could not acquire lock, skipping operation", { lockKey });
      return null;
    }

    try {
      const result = await fn();
      return result;
    } finally {
      await this.release(lockKey);
    }
  }

  /**
   * Generate a room lock key
   */
  static getRoomLockKey(roomId: string): string {
    return `room:lock:${roomId}`;
  }
}

export default RedisLock;
