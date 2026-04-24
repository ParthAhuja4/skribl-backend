import { Server, Socket } from "socket.io";
import { Player, Room, RoomState } from "../types";
import { redisClient } from "./redis";
import { logger } from "../config/logger";
import { config } from "../config/env";

// Reconnection data stored in Redis with TTL
interface ReconnectionData {
  roomId: string;
  playerData: Player;
  disconnectedAt: number;
  wasHost: boolean;
}

const RECONNECTION_TTL = config.RECONNECTION_TTL_SECONDS; // Redis TTL (must be longer than setTimeout to ensure data exists when timeout fires)
const RECONNECTION_PREFIX = "reconnection:";

/**
 * Store reconnection data when player disconnects
 */
export async function storeReconnectionData(
  socket: Socket,
  room: Room,
  player: Player
): Promise<void> {
  try {
    const auth = socket.handshake.auth as { playerToken?: string };
    const playerToken = auth?.playerToken;
    
    if (!playerToken) {
      logger.warn("No player token for reconnection", { socketId: socket.id });
      return;
    }

    const reconnectionData: ReconnectionData = {
      roomId: room.roomId,
      playerData: player,
      disconnectedAt: Date.now(),
      wasHost: room.creator === socket.id,
    };

    const key = `${RECONNECTION_PREFIX}${playerToken}`;
    await redisClient.setex(key, RECONNECTION_TTL, JSON.stringify(reconnectionData));
    
    logger.info("Stored reconnection data", { 
      playerToken, 
      roomId: room.roomId,
      playerName: player.name 
    });
  } catch (error) {
    logger.error("Error storing reconnection data", { error });
  }
}

/**
 * Handle player reconnection
 */
export async function handleReconnection(
  socket: Socket,
  oldSocketId: string,
  io: Server
): Promise<boolean> {
  try {
    const auth = socket.handshake.auth as { playerToken?: string };
    const playerToken = auth?.playerToken;
    
    if (!playerToken) {
      logger.warn("No player token for reconnection", { socketId: socket.id });
      return false;
    }

    // Get reconnection data
    const key = `${RECONNECTION_PREFIX}${playerToken}`;
    const dataStr = await redisClient.get(key);
    
    if (!dataStr) {
      logger.info("No reconnection data found", { playerToken });
      return false;
    }

    const reconnectionData: ReconnectionData = JSON.parse(dataStr);
    
    // Check if grace period expired
    const timeSinceDisconnect = Date.now() - reconnectionData.disconnectedAt;
    if (timeSinceDisconnect > RECONNECTION_TTL * 1000) {
      logger.info("Reconnection grace period expired", { playerToken });
      await redisClient.del(key);
      return false;
    }

    // Get room from Redis
    const { getRedisRoom, setRedisRoom } = await import("./redis");
    const room = await getRedisRoom(reconnectionData.roomId);
    
    if (!room) {
      logger.info("Room no longer exists", { roomId: reconnectionData.roomId });
      await redisClient.del(key);
      return false;
    }

    // Find player in room
    const playerIndex = room.players.findIndex(
      (p) => p.playerId === oldSocketId
    );

    if (playerIndex === -1) {
      logger.info("Player no longer in room", { 
        oldSocketId,
        roomId: room.roomId 
      });
      await redisClient.del(key);
      return false;
    }

    // Update player's socket ID
    room.players[playerIndex].playerId = socket.id;
    
    // Update creator if they were host
    if (room.creator === oldSocketId) {
      room.creator = socket.id;
    }

    await setRedisRoom(room.roomId, room);

    // Join socket to room
    socket.join(room.roomId);
    (socket as any).currentRoomId = room.roomId;

    // Notify player of successful reconnection
    socket.emit("reconnected", {
      room,
      message: "Successfully reconnected!",
    });
    
    // If game is in progress, send proper game state
    if (room.gameState.roomState !== RoomState.NOT_STARTED) {
      const { handleInBetweenJoin } = await import("../game/roomController");
      await handleInBetweenJoin(room.roomId, socket, io);
    }

    // Notify other players
    socket.to(room.roomId).emit("player_reconnected", {
      playerName: room.players[playerIndex].name,
      playerId: socket.id,
    });

    // Clean up reconnection data
    await redisClient.del(key);

    logger.info("Player reconnected successfully", {
      playerToken,
      oldSocketId,
      newSocketId: socket.id,
      roomId: room.roomId,
    });

    return true;
  } catch (error) {
    logger.error("Error handling reconnection", { error });
    return false;
  }
}

/**
 * Clear reconnection data
 */
export async function clearReconnectionData(playerToken: string): Promise<void> {
  try {
    const key = `${RECONNECTION_PREFIX}${playerToken}`;
    await redisClient.del(key);
  } catch (error) {
    logger.error("Error clearing reconnection data", { error });
  }
}

/**
 * Get reconnection data
 */
export async function getReconnectionData(
  playerToken: string
): Promise<ReconnectionData | null> {
  try {
    const key = `${RECONNECTION_PREFIX}${playerToken}`;
    const dataStr = await redisClient.get(key);
    
    if (!dataStr) return null;
    
    return JSON.parse(dataStr);
  } catch (error) {
    logger.error("Error getting reconnection data", { error });
    return null;
  }
}
