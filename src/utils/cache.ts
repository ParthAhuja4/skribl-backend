import { redisClient } from "./redis";
import { logger } from "../config/logger";

/**
 * Caching utilities for performance optimization
 */

interface CacheOptions {
  ttl?: number; // Time to live in seconds
  prefix?: string;
}

class CacheManager {
  private memoryCache: Map<string, { value: any; expires: number }>;
  private defaultTTL: number = 300; // 5 minutes

  constructor() {
    this.memoryCache = new Map();
    this.startCleanupInterval();
  }

  /**
   * Get value from cache (checks memory first, then Redis)
   */
  async get<T>(key: string, options?: CacheOptions): Promise<T | null> {
    const fullKey = this.getFullKey(key, options?.prefix);

    // Check memory cache first
    const memCache = this.memoryCache.get(fullKey);
    if (memCache && memCache.expires > Date.now()) {
      logger.debug("Cache hit (memory)", { key: fullKey });
      return memCache.value as T;
    }

    // Check Redis
    try {
      const value = await redisClient.get(fullKey);
      if (value) {
        logger.debug("Cache hit (Redis)", { key: fullKey });
        const parsed = JSON.parse(value);
        
        // Store in memory cache for faster access
        this.memoryCache.set(fullKey, {
          value: parsed,
          expires: Date.now() + (options?.ttl || this.defaultTTL) * 1000,
        });
        
        return parsed as T;
      }
    } catch (error) {
      logger.error("Cache get error", { key: fullKey, error });
    }

    logger.debug("Cache miss", { key: fullKey });
    return null;
  }

  /**
   * Set value in cache (both memory and Redis)
   */
  async set(key: string, value: any, options?: CacheOptions): Promise<void> {
    const fullKey = this.getFullKey(key, options?.prefix);
    const ttl = options?.ttl || this.defaultTTL;

    try {
      // Store in memory
      this.memoryCache.set(fullKey, {
        value,
        expires: Date.now() + ttl * 1000,
      });

      // Store in Redis
      await redisClient.setex(fullKey, ttl, JSON.stringify(value));
      logger.debug("Cache set", { key: fullKey, ttl });
    } catch (error) {
      logger.error("Cache set error", { key: fullKey, error });
    }
  }

  /**
   * Delete value from cache
   */
  async delete(key: string, options?: CacheOptions): Promise<void> {
    const fullKey = this.getFullKey(key, options?.prefix);

    // Delete from memory
    this.memoryCache.delete(fullKey);

    // Delete from Redis
    try {
      await redisClient.del(fullKey);
      logger.debug("Cache deleted", { key: fullKey });
    } catch (error) {
      logger.error("Cache delete error", { key: fullKey, error });
    }
  }

  /**
   * Clear all cache entries with a specific prefix
   */
  async clearPrefix(prefix: string): Promise<number> {
    let deletedCount = 0;

    // Clear from memory cache
    for (const key of this.memoryCache.keys()) {
      if (key.startsWith(`cache:${prefix}:`)) {
        this.memoryCache.delete(key);
        deletedCount++;
      }
    }

    // Clear from Redis
    try {
      const pattern = `cache:${prefix}:*`;
      let cursor = "0";
      
      do {
        const result = await redisClient.scan(cursor, "MATCH", pattern, "COUNT", 100);
        cursor = result[0];
        const keys = result[1];
        
        if (keys.length > 0) {
          await redisClient.del(...keys);
          deletedCount += keys.length;
        }
      } while (cursor !== "0");
      
      logger.info("Cache prefix cleared", { prefix, count: deletedCount });
    } catch (error) {
      logger.error("Cache clearPrefix error", { prefix, error });
    }

    return deletedCount;
  }

  /**
   * Get full cache key with prefix
   */
  private getFullKey(key: string, prefix?: string): string {
    return prefix ? `cache:${prefix}:${key}` : `cache:${key}`;
  }

  /**
   * Clean up expired entries from memory cache
   */
  private startCleanupInterval(): void {
    setInterval(() => {
      const now = Date.now();
      let cleaned = 0;

      for (const [key, cache] of this.memoryCache.entries()) {
        if (cache.expires <= now) {
          this.memoryCache.delete(key);
          cleaned++;
        }
      }

      if (cleaned > 0) {
        logger.debug("Memory cache cleanup", { cleaned });
      }
    }, 60000); // Clean every minute
  }

  /**
   * Get cache statistics
   */
  getStats(): {
    memoryEntries: number;
    memorySize: number;
  } {
    return {
      memoryEntries: this.memoryCache.size,
      memorySize: JSON.stringify([...this.memoryCache.entries()]).length,
    };
  }
}

// Singleton instance
export const cache = new CacheManager();

/**
 * Decorator for caching function results
 */
export function Cacheable(options?: CacheOptions) {
  return function (
    target: any,
    propertyKey: string,
    descriptor: PropertyDescriptor
  ) {
    const originalMethod = descriptor.value;

    descriptor.value = async function (...args: any[]) {
      const cacheKey = `${propertyKey}:${JSON.stringify(args)}`;
      
      // Try to get from cache
      const cached = await cache.get(cacheKey, options);
      if (cached !== null) {
        return cached;
      }

      // Execute original method
      const result = await originalMethod.apply(this, args);

      // Store in cache
      await cache.set(cacheKey, result, options);

      return result;
    };

    return descriptor;
  };
}

/**
 * Memoization for frequently called functions
 */
const memoCache = new Map<string, { value: any; timestamp: number }>();
const MEMO_TTL = 5000; // 5 seconds

export function memoize<T extends (...args: any[]) => any>(
  fn: T,
  ttl: number = MEMO_TTL
): T {
  return ((...args: any[]) => {
    const key = JSON.stringify(args);
    const cached = memoCache.get(key);
    
    if (cached && Date.now() - cached.timestamp < ttl) {
      return cached.value;
    }

    const result = fn(...args);
    memoCache.set(key, { value: result, timestamp: Date.now() });

    return result;
  }) as T;
}

// Clean up memoization cache
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of memoCache.entries()) {
    if (now - entry.timestamp > MEMO_TTL * 2) {
      memoCache.delete(key);
    }
  }
}, 60000);

export default cache;

