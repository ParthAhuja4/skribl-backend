import { Server } from "socket.io";
import { redisClient } from "./redis";
import { logger } from "../config/logger";
import { config } from "../config/env";
import { getRedisRoom, setRedisRoom, deleteRedisRoom } from "./redis";
import { RoomState, RounEndReason } from "../types";
import { transferHost } from "./hostTransfer";
import { GameEvent } from "../types";

const RECONNECTION_PREFIX = "reconnection:";
const CLEANUP_INTERVAL_MS = 5000; // Check every 5 seconds

// Validation: Ensure Redis TTL is longer than timeout + cleanup interval
const REQUIRED_TTL = config.RECONNECTION_TIMEOUT_SECONDS + Math.ceil(CLEANUP_INTERVAL_MS / 1000) + 2; // +2s safety buffer
if (config.RECONNECTION_TTL_SECONDS < REQUIRED_TTL) {
  logger.warn("⚠️  RECONNECTION_TTL_SECONDS is too short! Player removal may fail.", {
    current: config.RECONNECTION_TTL_SECONDS,
    recommended: REQUIRED_TTL,
    reason: "TTL must be > TIMEOUT + CLEANUP_INTERVAL to prevent race conditions",
  });
}

interface ReconnectionData {
  roomId: string;
  playerData: {
    playerId: string;
    name: string;
    avatar: number;
    score: number;
  };
  disconnectedAt: number;
  wasHost: boolean;
}

let cleanupInterval: NodeJS.Timeout | null = null;

/**
 * Start periodic cleanup of expired reconnection data
 * This replaces setTimeout which gets lost on Cloud Run restarts
 */
export function startReconnectionCleanup(io: Server): void {
  if (cleanupInterval) {
    logger.warn("Reconnection cleanup already running");
    return;
  }

  logger.info("Starting reconnection cleanup worker", {
    intervalMs: CLEANUP_INTERVAL_MS,
    intervalSeconds: CLEANUP_INTERVAL_MS / 1000,
    timeoutSeconds: config.RECONNECTION_TIMEOUT_SECONDS,
    redisTtlSeconds: config.RECONNECTION_TTL_SECONDS,
    worstCaseDelaySeconds: config.RECONNECTION_TIMEOUT_SECONDS + Math.ceil(CLEANUP_INTERVAL_MS / 1000),
  });

  cleanupInterval = setInterval(async () => {
    try {
      await cleanupExpiredReconnections(io);
    } catch (error) {
      logger.error("Error in reconnection cleanup", { error });
    }
  }, CLEANUP_INTERVAL_MS);

  // Initial cleanup on start
  cleanupExpiredReconnections(io).catch((error) => {
    logger.error("Error in initial reconnection cleanup", { error });
  });
}

/**
 * Stop the cleanup worker
 */
export function stopReconnectionCleanup(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
    logger.info("Stopped reconnection cleanup worker");
  }
}

/**
 * Check all reconnection data and remove expired players
 */
async function cleanupExpiredReconnections(io: Server): Promise<void> {
  try {
    // Get all reconnection keys
    const keys = await redisClient.keys(`${RECONNECTION_PREFIX}*`);
    
    if (keys.length === 0) {
      return; // No disconnected players to check
    }

    logger.debug(`Checking ${keys.length} reconnection entries for expiry`);

    const now = Date.now();
    const timeoutMs = config.RECONNECTION_TIMEOUT_SECONDS * 1000;

    for (const key of keys) {
      try {
        const dataStr = await redisClient.get(key);
        if (!dataStr) {
          logger.debug("Reconnection key exists but no data (possibly expired)", { key });
          continue;
        }

        const reconnectionData: ReconnectionData = JSON.parse(dataStr);
        const timeSinceDisconnect = now - reconnectionData.disconnectedAt;

        // Check if grace period expired
        if (timeSinceDisconnect >= timeoutMs) {
          logger.info("Found expired reconnection data, removing player", {
            playerName: reconnectionData.playerData.name,
            playerId: reconnectionData.playerData.playerId,
            roomId: reconnectionData.roomId,
            disconnectedFor: `${Math.round(timeSinceDisconnect / 1000)}s`,
            timeoutSeconds: config.RECONNECTION_TIMEOUT_SECONDS,
          });

          await removeDisconnectedPlayer(io, reconnectionData, key);
        } else {
          // Log players still in grace period
          const remainingTime = Math.ceil((timeoutMs - timeSinceDisconnect) / 1000);
          logger.debug("Player still in reconnection grace period", {
            playerName: reconnectionData.playerData.name,
            roomId: reconnectionData.roomId,
            disconnectedFor: `${Math.round(timeSinceDisconnect / 1000)}s`,
            remainingSeconds: remainingTime,
          });
        }
      } catch (error) {
        logger.error("Error processing reconnection entry", { key, error });
      }
    }
  } catch (error) {
    logger.error("Error in cleanupExpiredReconnections", { error });
  }
}

/**
 * Remove a disconnected player from their room
 */
async function removeDisconnectedPlayer(
  io: Server,
  reconnectionData: ReconnectionData,
  redisKey: string
): Promise<void> {
  try {
    const { roomId, playerData, wasHost } = reconnectionData;
    const playerIdToRemove = playerData.playerId;

    // Get room from Redis
    let currentRoom = await getRedisRoom(roomId);
    
    if (!currentRoom) {
      logger.info("Room no longer exists, cleaning up reconnection data", {
        roomId,
        playerName: playerData.name,
      });
      await redisClient.del(redisKey);
      return;
    }

    // Find player in room
    const playerIndex = currentRoom.players.findIndex(
      (p) => p.playerId === playerIdToRemove
    );

    if (playerIndex === -1) {
      logger.info("Player not found in room, cleaning up reconnection data", {
        roomId,
        playerName: playerData.name,
        playerId: playerIdToRemove,
      });
      await redisClient.del(redisKey);
      return;
    }

    const removedPlayer = currentRoom.players[playerIndex];

    logger.info("Removing player after reconnection timeout", {
      playerName: removedPlayer.name,
      playerId: playerIdToRemove,
      roomId: currentRoom.roomId,
      wasHost,
      remainingPlayers: currentRoom.players.length - 1,
    });

    // Handle game state if player is current drawer/chooser
    const isGameInProgress = currentRoom.gameState.currentRound !== 0;
    const isCurrentTurnPlayer =
      currentRoom.players[currentRoom.gameState.currentPlayer]?.playerId === playerIdToRemove;

    if (isGameInProgress && isCurrentTurnPlayer) {
      if (currentRoom.gameState.roomState === RoomState.DRAWING) {
        // Import dynamically to avoid circular dependencies
        const { endRound } = await import("../game/roomController");
        await endRound(currentRoom.roomId, io, RounEndReason.LEFT);
        
        // Reload updated room state after endRound
        currentRoom = await getRedisRoom(currentRoom.roomId);
        if (!currentRoom) {
          await redisClient.del(redisKey);
          return;
        }
      } else if (currentRoom.gameState.roomState === RoomState.CHOOSING_WORD) {
        const { clearTimers } = await import("../game/roomController");
        clearTimers(currentRoom.roomId);
      }
    }

    // Remove player from room
    currentRoom.players.splice(playerIndex, 1);

    // Adjust currentPlayer index after removal
    if (currentRoom.players.length > 0) {
      if (playerIndex < currentRoom.gameState.currentPlayer) {
        currentRoom.gameState.currentPlayer -= 1;
      }
      if (currentRoom.gameState.currentPlayer >= currentRoom.players.length) {
        currentRoom.gameState.currentPlayer = 0;
      }
    }

    // Transfer host if needed (for both private and public rooms)
    if (wasHost && currentRoom.players.length > 0) {
      await transferHost(currentRoom, io, playerIdToRemove);
      logger.info("Host transferred after reconnection timeout", {
        roomId: currentRoom.roomId,
        oldHost: playerIdToRemove,
        newHost: currentRoom.creator,
        isPrivate: currentRoom.isPrivate,
      });
    }

    // Clear auto-start timer if only 1 player in lobby
    if (currentRoom.players.length === 1 && currentRoom.gameState.currentRound === 0) {
      const { clearAllRoomTimers } = await import("../game/roomController");
      clearAllRoomTimers(currentRoom.roomId);
      logger.info("Cleared auto-start timer: only 1 player remaining in lobby", {
        roomId: currentRoom.roomId,
      });
    }

    await setRedisRoom(currentRoom.roomId, currentRoom);

    // Restart word selection if needed
    if (
      currentRoom.gameState.currentRound !== 0 &&
      currentRoom.gameState.roomState === RoomState.CHOOSING_WORD &&
      currentRoom.gameState.word === "" &&
      currentRoom.players.length > 0
    ) {
      const { nextRound } = await import("../game/roomController");
      await nextRound(currentRoom.roomId, io);
    }

    // Emit events to notify other players
    io.to(currentRoom.roomId).emit(GameEvent.PLAYER_LEFT, removedPlayer);
    io.to(currentRoom.roomId).emit(GameEvent.JOINED_ROOM, currentRoom);

    logger.info("Player removed after reconnection timeout", {
      playerName: removedPlayer.name,
      roomId: currentRoom.roomId,
      remainingPlayers: currentRoom.players.length,
    });

    // Delete room if empty
    if (currentRoom.players.length === 0) {
      const { clearAllRoomTimers } = await import("../game/roomController");
      clearAllRoomTimers(currentRoom.roomId);
      await deleteRedisRoom(currentRoom.roomId);
      logger.info("Room deleted - no players remaining", {
        roomId: currentRoom.roomId,
      });
    }

    // Clean up reconnection data
    await redisClient.del(redisKey);
    
    logger.info("Cleaned up reconnection data", {
      playerName: playerData.name,
      roomId,
    });
  } catch (error) {
    logger.error("Error removing disconnected player", {
      roomId: reconnectionData.roomId,
      playerName: reconnectionData.playerData.name,
      error,
    });
  }
}
