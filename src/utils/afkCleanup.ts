import { Server } from "socket.io";
import { redisClient } from "./redis";
import { logger } from "../config/logger";
import { config } from "../config/env";
import { getPublicRooms, getRedisRoom, setRedisRoom } from "./redis";
import { RoomState, GameEvent } from "../types";
import { transferHost } from "./hostTransfer";

const AFK_PREFIX = "afk:";
const CLEANUP_INTERVAL_MS = config.AFK_CHECK_INTERVAL_SECONDS * 1000; // Check every minute

let cleanupInterval: NodeJS.Timeout | null = null;

// Validation: Ensure Redis TTL is longer than timeout + cleanup interval
const REQUIRED_AFK_TTL = config.AFK_TIMEOUT_SECONDS + Math.ceil(CLEANUP_INTERVAL_MS / 1000) + 10; // +10s safety buffer
const ACTUAL_AFK_TTL = config.AFK_TIMEOUT_SECONDS + 60; // From updatePlayerActivity line 24
if (ACTUAL_AFK_TTL < REQUIRED_AFK_TTL) {
  logger.warn("⚠️  AFK_TIMEOUT_SECONDS TTL is too short! Player removal may fail.", {
    actualTTL: ACTUAL_AFK_TTL,
    recommendedTTL: REQUIRED_AFK_TTL,
    reason: "TTL must be > TIMEOUT + CLEANUP_INTERVAL to prevent race conditions",
  });
}

/**
 * Update player's last activity timestamp
 */
export async function updatePlayerActivity(
  roomId: string,
  playerId: string
): Promise<void> {
  try {
    const key = `${AFK_PREFIX}${roomId}:${playerId}`;
    const now = Date.now();
    await redisClient.setex(key, config.AFK_TIMEOUT_SECONDS + 60, now.toString());
  } catch (error) {
    logger.error("Error updating player activity", { roomId, playerId, error });
  }
}

/**
 * Get player's last activity timestamp
 */
async function getPlayerLastActivity(
  roomId: string,
  playerId: string
): Promise<number | null> {
  try {
    const key = `${AFK_PREFIX}${roomId}:${playerId}`;
    const timestamp = await redisClient.get(key);
    return timestamp ? parseInt(timestamp, 10) : null;
  } catch (error) {
    logger.error("Error getting player activity", { roomId, playerId, error });
    return null;
  }
}

/**
 * Clear player's activity timestamp (when they leave)
 */
export async function clearPlayerActivity(
  roomId: string,
  playerId: string
): Promise<void> {
  try {
    const key = `${AFK_PREFIX}${roomId}:${playerId}`;
    await redisClient.del(key);
  } catch (error) {
    logger.error("Error clearing player activity", { roomId, playerId, error });
  }
}

/**
 * Start AFK cleanup worker
 */
export function startAfkCleanup(io: Server): void {
  if (cleanupInterval) {
    logger.warn("AFK cleanup already running");
    return;
  }

  logger.info("Starting AFK cleanup worker", {
    intervalMs: CLEANUP_INTERVAL_MS,
    timeoutSeconds: config.AFK_TIMEOUT_SECONDS,
  });

  cleanupInterval = setInterval(async () => {
    try {
      await checkAfkPlayers(io);
    } catch (error) {
      logger.error("Error in AFK cleanup", { error });
    }
  }, CLEANUP_INTERVAL_MS);

  // Initial cleanup on start
  checkAfkPlayers(io).catch((error) => {
    logger.error("Error in initial AFK cleanup", { error });
  });
}

/**
 * Stop AFK cleanup worker
 */
export function stopAfkCleanup(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
    logger.info("Stopped AFK cleanup worker");
  }
}

/**
 * Check all rooms for AFK players and remove them
 * Also cleans up empty/ghost public rooms
 */
async function checkAfkPlayers(io: Server): Promise<void> {
  try {
    // Only check public rooms (private rooms can have their own rules)
    const publicRoomIds = await getPublicRooms();
    
    if (publicRoomIds.length === 0) {
      return;
    }

    logger.debug(`Checking ${publicRoomIds.length} public rooms for AFK players and cleanup`);

    const now = Date.now();
    const timeoutMs = config.AFK_TIMEOUT_SECONDS * 1000;

    for (const roomId of publicRoomIds) {
      try {
        const room = await getRedisRoom(roomId);
        
        if (!room) {
          // Ghost room in Redis - clean it up
          const { deleteRedisRoom } = await import("./redis");
          await deleteRedisRoom(roomId);
          logger.info("Cleaned up ghost room (not found)", { roomId });
          continue;
        }
        
        // Clean up empty rooms
        if (room.players.length === 0) {
          const { clearAllRoomTimers } = await import("../game/roomController");
          const { deleteRedisRoom } = await import("./redis");
          clearAllRoomTimers(room.roomId);
          await deleteRedisRoom(room.roomId);
          logger.info("Cleaned up empty public room", { roomId });
          continue;
        }
        
        // Check AFK players in all game states (lobby and during game)
        const isInGame = room.gameState.roomState !== RoomState.NOT_STARTED;

        // Check each player's activity
        for (const player of room.players) {
          const lastActivity = await getPlayerLastActivity(roomId, player.playerId);
          
          // If no activity record, create one (give them the benefit of the doubt)
          if (lastActivity === null) {
            await updatePlayerActivity(roomId, player.playerId);
            continue;
          }

          const idleTime = now - lastActivity;
          
          // Kick if AFK for too long
          if (idleTime >= timeoutMs) {
            const gameState = isInGame ? 'during game' : 'from lobby';
            logger.info(`Kicking AFK player ${gameState}`, {
              roomId,
              playerName: player.name,
              playerId: player.playerId,
              idleSeconds: Math.round(idleTime / 1000),
              roomState: room.gameState.roomState,
            });

            await kickAfkPlayer(io, room.roomId, player.playerId, isInGame);
          }
        }
      } catch (error) {
        logger.error("Error checking AFK players in room", { roomId, error });
      }
    }
  } catch (error) {
    logger.error("Error in checkAfkPlayers", { error });
  }
}

/**
 * Kick an AFK player from the room
 */
async function kickAfkPlayer(
  io: Server,
  roomId: string,
  playerId: string,
  isInGame: boolean = false
): Promise<void> {
  try {
    let room = await getRedisRoom(roomId);
    if (!room) return;

    const playerIndex = room.players.findIndex((p) => p.playerId === playerId);
    if (playerIndex === -1) {
      logger.warn("AFK player not found in room", { roomId, playerId });
      return;
    }

    const kickedPlayer = room.players[playerIndex];
    const wasHost = room.creator === playerId;
    const wasCurrentDrawer = isInGame && room.players[room.gameState.currentPlayer]?.playerId === playerId;

    // Remove player
    room.players.splice(playerIndex, 1);

    // If the kicked player was the current drawer, end the round
    if (wasCurrentDrawer && isInGame) {
      logger.info("Current drawer was AFK - ending round", {
        roomId,
        playerName: kickedPlayer.name,
      });

      // Import and call endRound to handle the turn properly
      const { endRound } = await import("../game/roomController");
      const { RounEndReason } = await import("../types");
      
      // End the round due to player leaving
      await endRound(room.roomId, io, RounEndReason.LEFT);
      
      // Refresh room after endRound
      room = await getRedisRoom(roomId);
      if (!room) return;
    }

    // Transfer host if needed (for both private and public rooms)
    if (wasHost && room.players.length > 0) {
      await transferHost(room, io, playerId);
      logger.info("Host transferred after AFK kick", {
        roomId,
        oldHost: playerId,
        newHost: room.creator,
        isPrivate: room.isPrivate,
      });
    }

    // Clear auto-start timer if only 1 player left in lobby
    if (room.players.length === 1 && room.gameState.currentRound === 0) {
      const { clearAllRoomTimers } = await import("../game/roomController");
      clearAllRoomTimers(room.roomId);
    }

    await setRedisRoom(room.roomId, room);

    // Emit events
    io.to(room.roomId).emit(GameEvent.PLAYER_LEFT, kickedPlayer);
    io.to(room.roomId).emit(GameEvent.JOINED_ROOM, room);
    
    // Notify the kicked player
    io.to(playerId).emit("afk_kicked", {
      message: "You were removed for inactivity",
    });

    logger.info("AFK player removed", {
      roomId,
      playerName: kickedPlayer.name,
      remainingPlayers: room.players.length,
      wasDrawer: wasCurrentDrawer,
    });

    // Delete room if empty
    if (room.players.length === 0) {
      const { clearAllRoomTimers } = await import("../game/roomController");
      const { deleteRedisRoom } = await import("./redis");
      clearAllRoomTimers(room.roomId);
      await deleteRedisRoom(room.roomId);
      logger.info("Room deleted - empty after AFK kick", { roomId });
    }

    // Clear activity tracking
    await clearPlayerActivity(roomId, playerId);
  } catch (error) {
    logger.error("Error kicking AFK player", { roomId, playerId, error });
  }
}
