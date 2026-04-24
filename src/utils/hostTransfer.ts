import { Server } from "socket.io";
import { Room, GameEvent } from "../types";
import { setRedisRoom } from "./redis";
import { logger } from "../config/logger";

/**
 * Transfer host to another player using priority system
 * Priority: Highest score -> Earliest join time
 */
export async function transferHost(
  room: Room,
  io: Server,
  excludePlayerId?: string
): Promise<string | null> {
  try {
    // Filter out the old host if specified
    const eligiblePlayers = room.players.filter(
      (p) => p.playerId !== excludePlayerId
    );

    if (eligiblePlayers.length === 0) {
      logger.warn("No eligible players for host transfer", { roomId: room.roomId });
      return null;
    }

    // Sort by score (highest first), then by join order (first in array = earliest)
    const sortedPlayers = [...eligiblePlayers].sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score; // Higher score first
      }
      // If scores are equal, maintain array order (earlier = higher priority)
      return 0;
    });

    const newHost = sortedPlayers[0];
    const oldCreator = room.creator;

    // Update room creator
    room.creator = newHost.playerId;
    await setRedisRoom(room.roomId, room);

    // Notify all players of host transfer
    io.to(room.roomId).emit(GameEvent.HOST_TRANSFERRED, {
      oldHostId: oldCreator,
      newHostId: newHost.playerId,
      newHostName: newHost.name,
    });

    // Send special notification to new host
    io.to(newHost.playerId).emit("you_are_host", {
      message: "You are now the host!",
    });

    logger.info("Host transferred", {
      roomId: room.roomId,
      oldHost: oldCreator,
      newHost: newHost.playerId,
      newHostName: newHost.name,
    });

    return newHost.playerId;
  } catch (error) {
    logger.error("Error transferring host", { error });
    return null;
  }
}

/**
 * Check if host transfer is needed and perform it
 */
export async function checkAndTransferHost(
  room: Room,
  disconnectedPlayerId: string,
  io: Server
): Promise<void> {
  // Only transfer if the disconnected player was the host
  if (room.creator !== disconnectedPlayerId) {
    return;
  }

  // Transfer to next eligible player (private and public rooms).
  await transferHost(room, io, disconnectedPlayerId);
}



