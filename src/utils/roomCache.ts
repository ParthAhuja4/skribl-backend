import { Room } from "../types";
import { logger } from "../config/logger";

interface CacheEntry {
  room: Room;
  lastAccessed: number;
  dirty: boolean; // Needs to be synced back to Redis
}

class RoomCache {
  private cache: Map<string, CacheEntry>;
  private readonly MAX_CACHE_SIZE = 1000; // Store up to 1000 active rooms
  private readonly CACHE_TTL = 60000; // 60 seconds
  private readonly CLEANUP_INTERVAL = 30000; // Clean every 30 seconds
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.cache = new Map();
    this.startCleanup();
  }

  // Get room from cache
  get(roomId: string): Room | null {
    const entry = this.cache.get(roomId);
    if (!entry) return null;

    // Check if expired
    if (Date.now() - entry.lastAccessed > this.CACHE_TTL) {
      this.cache.delete(roomId);
      return null;
    }

    // Update last accessed
    entry.lastAccessed = Date.now();
    return entry.room;
  }

  // Set room in cache
  set(roomId: string, room: Room, dirty: boolean = false): void {
    // Enforce max size
    if (this.cache.size >= this.MAX_CACHE_SIZE && !this.cache.has(roomId)) {
      this.evictOldest();
    }

    this.cache.set(roomId, {
      room,
      lastAccessed: Date.now(),
      dirty,
    });
  }

  // Mark room as dirty (needs Redis sync)
  markDirty(roomId: string): void {
    const entry = this.cache.get(roomId);
    if (entry) {
      entry.dirty = true;
    }
  }

  // Get all dirty rooms (for batch sync to Redis)
  getDirtyRooms(): Array<{ roomId: string; room: Room }> {
    const dirtyRooms: Array<{ roomId: string; room: Room }> = [];
    
    for (const [roomId, entry] of this.cache.entries()) {
      if (entry.dirty) {
        dirtyRooms.push({ roomId, room: entry.room });
        entry.dirty = false; // Reset dirty flag
      }
    }

    return dirtyRooms;
  }

  // Delete room from cache
  delete(roomId: string): void {
    this.cache.delete(roomId);
  }

  // Clear entire cache
  clear(): void {
    this.cache.clear();
  }

  // Get cache stats
  getStats(): { size: number; maxSize: number; hitRate: number } {
    return {
      size: this.cache.size,
      maxSize: this.MAX_CACHE_SIZE,
      hitRate: 0, // TODO: Track hits/misses for accurate rate
    };
  }

  // Evict oldest entry
  private evictOldest(): void {
    let oldestRoomId: string | null = null;
    let oldestTime = Date.now();

    for (const [roomId, entry] of this.cache.entries()) {
      if (entry.lastAccessed < oldestTime) {
        oldestTime = entry.lastAccessed;
        oldestRoomId = roomId;
      }
    }

    if (oldestRoomId) {
      logger.debug("Evicting oldest cached room", { roomId: oldestRoomId });
      this.cache.delete(oldestRoomId);
    }
  }

  // Cleanup expired entries
  private cleanup(): void {
    const now = Date.now();
    const toDelete: string[] = [];

    for (const [roomId, entry] of this.cache.entries()) {
      if (now - entry.lastAccessed > this.CACHE_TTL) {
        toDelete.push(roomId);
      }
    }

    toDelete.forEach((roomId) => this.cache.delete(roomId));

    if (toDelete.length > 0) {
      logger.debug("Cleaned up expired cache entries", {
        count: toDelete.length,
        remainingSize: this.cache.size,
      });
    }
  }

  // Start periodic cleanup
  private startCleanup(): void {
    this.cleanupTimer = setInterval(() => {
      this.cleanup();
    }, this.CLEANUP_INTERVAL);
  }

  // Stop cleanup timer
  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}

// Export singleton instance
export const roomCache = new RoomCache();

