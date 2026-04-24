import { Languages, Room } from "../types";
import { logger } from "../config/logger";

/**
 * In-memory fallback storage for when Redis is unavailable
 * This is NOT recommended for production but works for testing/development
 */

// In-memory storage
const roomStore = new Map<string, { data: Room; expiresAt: number }>();
const ROOM_TTL_MS = 3600 * 1000; // 1 hour in milliseconds

// Periodic cleanup of expired rooms
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [key, value] of roomStore.entries()) {
    if (value.expiresAt < now) {
      roomStore.delete(key);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    logger.debug(`Cleaned up ${cleaned} expired rooms from memory`);
  }
}, 60000); // Clean every minute

const getRoomKey = (roomId: string, isPrivate: boolean = false): string => {
  return isPrivate ? `room:${roomId}` : `publicRoom:${roomId}`;
};

export async function getInMemoryRoom(roomId: string): Promise<Room | null> {
  try {
    // Try private room first
    let key = getRoomKey(roomId, true);
    let entry = roomStore.get(key);
    
    // If not found, try public room
    if (!entry) {
      key = getRoomKey(roomId, false);
      entry = roomStore.get(key);
    }
    
    if (!entry) {
      return null;
    }
    
    // Check if expired
    if (entry.expiresAt < Date.now()) {
      roomStore.delete(key);
      return null;
    }
    
    return entry.data;
  } catch (error) {
    logger.error("Error getting room from in-memory store:", { roomId, error });
    return null;
  }
}

export async function setInMemoryRoom(roomId: string, roomData: Room): Promise<void> {
  try {
    const key = getRoomKey(roomId, roomData.isPrivate);
    const expiresAt = Date.now() + ROOM_TTL_MS;
    
    roomStore.set(key, {
      data: roomData,
      expiresAt,
    });
    
    logger.debug("Room data saved to in-memory store", { 
      roomId, 
      isPrivate: roomData.isPrivate,
      totalRooms: roomStore.size 
    });
  } catch (error) {
    logger.error("Error saving room to in-memory store:", { roomId, error });
    throw new Error("Failed to save room data");
  }
}

export async function deleteInMemoryRoom(roomId: string): Promise<void> {
  try {
    roomStore.delete(getRoomKey(roomId, true));
    roomStore.delete(getRoomKey(roomId, false));
    logger.info("Room deleted from in-memory store", { roomId });
  } catch (error) {
    logger.error("Error deleting room from in-memory store:", { roomId, error });
    throw new Error("Failed to delete room");
  }
}

export async function getInMemoryPublicRoom(
  language: Languages = Languages.en
): Promise<Room | null> {
  try {
    const now = Date.now();
    let bestRoom: Room | null = null;
    
    for (const [key, entry] of roomStore.entries()) {
      // Skip expired rooms
      if (entry.expiresAt < now) continue;
      
      // Skip private rooms
      if (!key.startsWith('publicRoom:')) continue;
      
      const room = entry.data;
      
      // Skip rooms with 0 players (ghost rooms)
      if (room.players.length === 0) {
        logger.warn("Found ghost public room with 0 players in memory, skipping", { roomId: room.roomId });
        // Clean up ghost room immediately
        roomStore.delete(key);
        continue;
      }
      
      // Check if room has space and matches language
      if (
        room.players.length < room.settings.players &&
        room.settings.language === language
      ) {
        // Prefer lobby rooms (not started), but allow in-progress rooms too.
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
    logger.error("Error finding public room in memory:", { language, error });
    return null;
  }
}

export async function getInMemoryPublicRooms(): Promise<string[]> {
  try {
    const roomIds: string[] = [];
    const now = Date.now();
    
    for (const [key, entry] of roomStore.entries()) {
      // Skip expired rooms
      if (entry.expiresAt < now) continue;
      
      if (key.startsWith('publicRoom:')) {
        roomIds.push(key.replace('publicRoom:', ''));
      }
    }
    
    return roomIds;
  } catch (error) {
    logger.error("Error getting public rooms from memory:", { error });
    return [];
  }
}

export async function extendInMemoryRoomTTL(roomId: string, isPrivate: boolean): Promise<void> {
  try {
    const key = getRoomKey(roomId, isPrivate);
    const entry = roomStore.get(key);
    
    if (entry) {
      entry.expiresAt = Date.now() + ROOM_TTL_MS;
      logger.debug("Room TTL extended in memory", { roomId });
    }
  } catch (error) {
    logger.error("Error extending room TTL in memory:", { roomId, error });
  }
}

export function getInMemoryStatus(): { connected: boolean; ready: boolean; roomCount: number } {
  return {
    connected: true,
    ready: true,
    roomCount: roomStore.size,
  };
}

