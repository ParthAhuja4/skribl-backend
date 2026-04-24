import Redis from "ioredis";
import { Languages, Room } from "../types";
import { config } from "../config/env";
import { logger } from "../config/logger";
import * as inMemory from "./inMemoryStore";
import { roomCache } from "./roomCache";
import { redisCircuitBreaker } from "./circuitBreaker";

// Create Redis client with proper configuration
const client = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  lazyConnect: true, // Don't connect immediately on creation
  retryStrategy: (times) => {
    if (times > 5) {
      logger.warn("Redis connection failed after 5 attempts, using in-memory fallback");
      return null; // Stop retrying
    }
    const delay = Math.min(times * 50, 2000);
    logger.warn(`Redis retry attempt ${times}, waiting ${delay}ms`);
    return delay;
  },
  reconnectOnError: (err) => {
    const targetError = "READONLY";
    if (err.message.includes(targetError)) {
      // Reconnect when Redis is in READONLY mode
      return true;
    }
    return false;
  },
});

// Track if Redis is available
let redisAvailable = false;

// Redis event handlers
client.on("error", (err) => {
  logger.error("Redis connection error:", { error: err.message, stack: err.stack });
  redisAvailable = false;
});

client.on("connect", () => {
  logger.info("Connected to Redis successfully");
  redisAvailable = true;
});

client.on("ready", () => {
  logger.info("Redis client is ready");
  redisAvailable = true;
});

client.on("reconnecting", () => {
  logger.warn("Reconnecting to Redis...");
  redisAvailable = false;
});

client.on("end", () => {
  logger.warn("Redis connection closed");
  redisAvailable = false;
});

// Connect to Redis asynchronously (non-blocking)
client.connect().catch((err) => {
  logger.error("Failed to connect to Redis on startup:", { error: err.message });
  logger.warn("Falling back to in-memory storage");
  redisAvailable = false;
  // Don't crash the server, use in-memory fallback
});

// Constants
const ROOM_PREFIX = "room:";
const PUBLIC_ROOM_PREFIX = "publicRoom:";
const ROOM_TTL = config.ROOM_TTL_SECONDS;

// Helper to get full key
const getRoomKey = (roomId: string, isPrivate: boolean = false): string => {
  return isPrivate ? `${ROOM_PREFIX}${roomId}` : `${PUBLIC_ROOM_PREFIX}${roomId}`;
};

/**
 * Get room data from Redis (or in-memory fallback) with caching and circuit breaker
 */
export async function getRedisRoom(roomId: string): Promise<Room | null> {
  // Check cache first
  const cachedRoom = roomCache.get(roomId);
  if (cachedRoom) {
    logger.debug("Room cache HIT", { roomId });
    return cachedRoom;
  }

  logger.debug("Room cache MISS", { roomId });

  // Use circuit breaker for Redis calls
  return redisCircuitBreaker.execute(
    async () => {
      // Use in-memory fallback if Redis is not available
      if (!redisAvailable) {
        throw new Error("Redis unavailable");
      }
      
      // Try private room first
      let data = await client.get(`${ROOM_PREFIX}${roomId}`);
      
      // If not found, try public room
      if (!data) {
        data = await client.get(`${PUBLIC_ROOM_PREFIX}${roomId}`);
      }
      
      if (!data) {
        return null;
      }
      
      const room = JSON.parse(data);
      // Store in cache
      roomCache.set(roomId, room);
      return room;
    },
    async () => {
      // Fallback to in-memory
      logger.debug("Using in-memory storage (circuit breaker)", { roomId });
      const room = await inMemory.getInMemoryRoom(roomId);
      if (room) roomCache.set(roomId, room);
      return room;
    }
  );
}

/**
 * Set room data in Redis (or in-memory fallback) with TTL and caching
 */
export async function setRedisRoom(roomId: string, roomData: Room): Promise<void> {
  try {
    // Update cache immediately
    roomCache.set(roomId, roomData);

    // Use in-memory fallback if Redis is not available
    if (!redisAvailable) {
      logger.debug("Using in-memory storage (Redis unavailable)", { roomId });
      return await inMemory.setInMemoryRoom(roomId, roomData);
    }
    
    const key = getRoomKey(roomId, roomData.isPrivate);
    const value = JSON.stringify(roomData);
    
    // Set with TTL to auto-expire inactive rooms
    await client.setex(key, ROOM_TTL, value);
    
    logger.debug("Room data saved to Redis", { roomId, isPrivate: roomData.isPrivate });
  } catch (error) {
    logger.error("Error saving room to Redis, using in-memory fallback:", { roomId, error });
    return await inMemory.setInMemoryRoom(roomId, roomData);
  }
}

/**
 * Delete room from Redis (or in-memory fallback) and cache
 */
export async function deleteRedisRoom(roomId: string): Promise<void> {
  try {
    // Delete from cache
    roomCache.delete(roomId);

    // CRITICAL FIX: Clean up memory leaks when deleting room
    // Import cleanup functions dynamically to avoid circular dependencies
    const { clearDrawSaveTimer } = await import("../game/roomController");
    const { clearRoomVoiceUsers } = await import("../socket/socketHandlers");
    
    clearDrawSaveTimer(roomId);
    clearRoomVoiceUsers(roomId);

    if (!redisAvailable) {
      return await inMemory.deleteInMemoryRoom(roomId);
    }
    
    const pipeline = client.pipeline();
    pipeline.del(`${ROOM_PREFIX}${roomId}`);
    pipeline.del(`${PUBLIC_ROOM_PREFIX}${roomId}`);
    await pipeline.exec();
    
    logger.info("Room deleted from Redis with cleanup", { roomId });
  } catch (error) {
    logger.error("Error deleting room from Redis:", { roomId, error });
    await inMemory.deleteInMemoryRoom(roomId);
  }
}

/**
 * Get available public room for a language (with fallback)
 * Uses SCAN instead of KEYS for better performance
 */
export async function getPublicRoom(
  language: Languages = Languages.en
): Promise<Room | null> {
  try {
    if (!redisAvailable) {
      return await inMemory.getInMemoryPublicRoom(language);
    }
    
    const rooms = await getPublicRooms();
    
    if (rooms.length === 0) {
      return null;
    }

    // Check each room for availability.
    // Prefer lobby rooms (not started), but allow joining rooms in-progress too.
    let bestRoom: Room | null = null;
    for (const roomId of rooms) {
      const room = await getRedisRoom(roomId);
      
      if (!room) continue;
      
      // Skip rooms with 0 players (ghost rooms that are about to be deleted)
      if (room.players.length === 0) {
        logger.warn("Found ghost public room with 0 players, skipping", { roomId });
        // Clean up ghost room immediately
        await deleteRedisRoom(roomId);
        continue;
      }
      
      // Check if room has space and matches language
      if (
        room.players.length < room.settings.players &&
        room.settings.language === language
      ) {
        // Prefer a room that hasn't started yet, but don't require it.
        if (!bestRoom) {
          bestRoom = room;
          continue;
        }
        const bestNotStarted = bestRoom.gameState.currentRound === 0;
        const candidateNotStarted = room.gameState.currentRound === 0;
        if (!bestNotStarted && candidateNotStarted) {
          bestRoom = room;
        }
      }
    }
    
    return bestRoom;
  } catch (error) {
    logger.error("Error finding public room:", { language, error });
    return await inMemory.getInMemoryPublicRoom(language);
  }
}

/**
 * Get all public room IDs using SCAN (more performant than KEYS)
 */
export async function getPublicRooms(): Promise<string[]> {
  try {
    if (!redisAvailable) {
      return await inMemory.getInMemoryPublicRooms();
    }
    
    const roomIds: string[] = [];
    let cursor = "0";
    
    // Use SCAN instead of KEYS for better performance
    do {
      const result = await client.scan(
        cursor,
        "MATCH",
        `${PUBLIC_ROOM_PREFIX}*`,
        "COUNT",
        100
      );
      
      cursor = result[0];
      const keys = result[1];
      
      // Remove prefix from keys to get room IDs
      roomIds.push(...keys.map((key) => key.replace(PUBLIC_ROOM_PREFIX, "")));
    } while (cursor !== "0");
    
    return roomIds;
  } catch (error) {
    logger.error("Error getting public rooms:", { error });
    return await inMemory.getInMemoryPublicRooms();
  }
}

/**
 * Delete all public rooms (for cleanup/testing)
 */
export async function deletePublicRooms(): Promise<number> {
  try {
    const roomIds = await getPublicRooms();
    
    if (roomIds.length === 0) {
      logger.info("No public rooms to delete");
      return 0;
    }

    // Delete in batches using pipeline
    const pipeline = client.pipeline();
    roomIds.forEach((roomId) => {
      pipeline.del(`${PUBLIC_ROOM_PREFIX}${roomId}`);
    });
    
    await pipeline.exec();
    
    logger.info(`Deleted ${roomIds.length} public rooms`);
    return roomIds.length;
  } catch (error) {
    logger.error("Error deleting public rooms:", { error });
    throw new Error("Failed to delete public rooms");
  }
}

/**
 * Extend room TTL (for active rooms)
 */
export async function extendRoomTTL(roomId: string, isPrivate: boolean): Promise<void> {
  try {
    if (!redisAvailable) {
      await inMemory.extendInMemoryRoomTTL(roomId, isPrivate);
      return;
    }
    
    const key = getRoomKey(roomId, isPrivate);
    await client.expire(key, ROOM_TTL);
    logger.debug("Room TTL extended", { roomId });
  } catch (error) {
    logger.error("Error extending room TTL:", { roomId, error });
    await inMemory.extendInMemoryRoomTTL(roomId, isPrivate);
  }
}

/**
 * Get detailed Redis client health status
 */
export interface RedisHealthStatus {
  available: boolean;
  connected: boolean;
  ready: boolean;
  status: string;
  mode: "redis" | "in-memory";
  uptime: number | null;
  url: string;
  lastError?: string;
  memory?: {
    used: string;
    peak: string;
    fragmentation: number;
  };
  stats?: {
    totalConnections: number;
    commandsProcessed: string;
    opsPerSec: number;
  };
  keyspace?: {
    keys: number;
    expires: number;
  };
}

let lastRedisError: string | undefined;

// Track last error for health reporting
client.on("error", (err) => {
  lastRedisError = err.message;
});

export async function getRedisHealth(): Promise<RedisHealthStatus> {
  const baseStatus: RedisHealthStatus = {
    available: redisAvailable,
    connected: false,
    ready: false,
    status: "disconnected",
    mode: redisAvailable ? "redis" : "in-memory",
    uptime: null,
    url: config.REDIS_URL.replace(/:[^:]*@/, ':***@'), // Hide password
    lastError: lastRedisError,
  };

  if (!redisAvailable) {
    const inMemoryStatus = inMemory.getInMemoryStatus();
    return {
      ...baseStatus,
      connected: inMemoryStatus.connected,
      ready: inMemoryStatus.ready,
      status: "in-memory-fallback",
    };
  }

  try {
    baseStatus.status = client.status;
    baseStatus.connected = client.status === "ready" || client.status === "connect";
    baseStatus.ready = client.status === "ready";

    // Get detailed Redis info if connected
    if (baseStatus.ready) {
      try {
        const info = await client.info();
        const infoObj = parseRedisInfo(info);

        // Server uptime
        baseStatus.uptime = parseInt(infoObj.Server?.uptime_in_seconds || "0", 10);

        // Memory info
        if (infoObj.Memory) {
          baseStatus.memory = {
            used: infoObj.Memory.used_memory_human || "0B",
            peak: infoObj.Memory.used_memory_peak_human || "0B",
            fragmentation: parseFloat(infoObj.Memory.mem_fragmentation_ratio || "1"),
          };
        }

        // Stats
        if (infoObj.Stats) {
          baseStatus.stats = {
            totalConnections: parseInt(infoObj.Stats.total_connections_received || "0", 10),
            commandsProcessed: infoObj.Stats.total_commands_processed || "0",
            opsPerSec: parseInt(infoObj.Stats.instantaneous_ops_per_sec || "0", 10),
          };
        }

        // Keyspace (count of keys)
        if (infoObj.Keyspace && infoObj.Keyspace.db0) {
          const dbInfo = infoObj.Keyspace.db0;
          const keysMatch = dbInfo.match(/keys=(\d+)/);
          const expiresMatch = dbInfo.match(/expires=(\d+)/);
          
          baseStatus.keyspace = {
            keys: keysMatch ? parseInt(keysMatch[1], 10) : 0,
            expires: expiresMatch ? parseInt(expiresMatch[1], 10) : 0,
          };
        }

        // Clear last error on successful connection
        if (lastRedisError) {
          lastRedisError = undefined;
        }
      } catch (infoError) {
        logger.warn("Failed to get detailed Redis info", { error: infoError });
        // Still return basic status even if INFO command fails
      }
    }

    return baseStatus;
  } catch (error) {
    logger.error("Error getting Redis health", { error });
    return {
      ...baseStatus,
      status: "error",
      lastError: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Parse Redis INFO command output into structured object
 */
function parseRedisInfo(info: string): Record<string, Record<string, string>> {
  const result: Record<string, Record<string, string>> = {};
  let currentSection = "";

  info.split("\r\n").forEach((line) => {
    if (line.startsWith("#")) {
      // Section header
      currentSection = line.substring(2).trim();
      result[currentSection] = {};
    } else if (line.includes(":")) {
      // Key-value pair
      const [key, value] = line.split(":");
      if (currentSection && key && value !== undefined) {
        result[currentSection][key] = value;
      }
    }
  });

  return result;
}

/**
 * Get basic Redis status (for backward compatibility)
 */
export function getRedisStatus(): { connected: boolean; ready: boolean } {
  if (!redisAvailable) {
    const status = inMemory.getInMemoryStatus();
    return {
      connected: status.connected,
      ready: status.ready,
    };
  }
  
  return {
    connected: client.status === "ready" || client.status === "connect",
    ready: client.status === "ready",
  };
}

// Export client for advanced usage
export { client as redisClient };
export default client;
