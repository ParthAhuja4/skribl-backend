import express, { Request, Response } from "express";
import { Server } from "socket.io";
import { asyncHandler } from "../utils/errors";
import { logger } from "../config/logger";
import { metrics, GameMetrics } from "../utils/metrics";
import { AntiCheat } from "../utils/antiCheat";
import { getPublicRooms, getRedisRoom } from "../utils/redis";
import { cache } from "../utils/cache";
import { Languages } from "../types";
import { config } from "../config/env";

/**
 * Admin API routes for monitoring and management
 */

export function setupAdminRoutes(app: express.Application, io: Server) {
  const router = express.Router();

  // Middleware to check admin authentication (implement based on your needs)
  const requireAdmin = (req: Request, res: Response, next: any) => {
    const apiKey = req.headers["x-api-key"];
    
    // TODO: Implement proper authentication
    if (process.env.ADMIN_API_KEY && apiKey === process.env.ADMIN_API_KEY) {
      next();
    } else {
      res.status(403).json({ error: "Forbidden" });
    }
  };

  // GET /admin - Admin dashboard info
  router.get(
    "/",
    asyncHandler(async (req: Request, res: Response) => {
      res.json({
        message: "SyncDrawGuess Admin API",
        version: "1.0.0",
        endpoints: [
          "GET /admin/stats - Server statistics",
          "GET /admin/rooms - List all rooms",
          "GET /admin/rooms/:roomId - Get room details",
          "DELETE /admin/rooms/:roomId - Delete a room",
          "GET /admin/metrics - Server metrics",
          "GET /admin/health - Detailed health status",
          "GET /admin/anti-cheat - Anti-cheat statistics",
          "POST /admin/anti-cheat/ban - Ban an IP address",
          "DELETE /admin/anti-cheat/ban/:ip - Unban an IP address",
          "POST /admin/broadcast - Broadcast message to all clients",
          "POST /admin/cache/clear - Clear cache",
        ],
      });
    })
  );

  // GET /admin/stats - Get server statistics
  router.get(
    "/stats",
    requireAdmin,
    asyncHandler(async (req: Request, res: Response) => {
      const sockets = await io.fetchSockets();
      const roomIds = await getPublicRooms();

      // Calculate active rooms and players
      let activeRooms = 0;
      let activePlayers = 0;
      let activeGames = 0;

      for (const roomId of roomIds) {
        const room = await getRedisRoom(roomId);
        if (room) {
          activeRooms++;
          activePlayers += room.players.length;
          if (room.gameState.currentRound > 0) {
            activeGames++;
          }
        }
      }

      // Update gauges
      GameMetrics.setActiveRooms(activeRooms);
      GameMetrics.setActivePlayers(activePlayers);
      GameMetrics.setActiveGames(activeGames);

      res.json({
        server: {
          uptime: process.uptime(),
          memory: process.memoryUsage(),
          nodeVersion: process.version,
          environment: process.env.NODE_ENV,
        },
        connections: {
          total: sockets.length,
          activePlayers,
          activeRooms,
          activeGames,
        },
        config: {
          reconnection: {
            timeoutSeconds: config.RECONNECTION_TIMEOUT_SECONDS,
            ttlSeconds: config.RECONNECTION_TTL_SECONDS,
            timeoutMs: config.RECONNECTION_TIMEOUT_SECONDS * 1000,
            ttlMs: config.RECONNECTION_TTL_SECONDS * 1000,
          },
        },
        cache: cache.getStats(),
        antiCheat: AntiCheat.getStats(),
      });
    })
  );

  // GET /admin/rooms - List all rooms
  router.get(
    "/rooms",
    requireAdmin,
    asyncHandler(async (req: Request, res: Response) => {
      const roomIds = await getPublicRooms();
      const rooms: Array<{
        roomId: string;
        isPrivate: boolean;
        playerCount: number;
        maxPlayers: number;
        currentRound: number;
        totalRounds: number;
        language: Languages;
        creator: string | null;
      }> = [];

      for (const roomId of roomIds) {
        const room = await getRedisRoom(roomId);
        if (room) {
          rooms.push({
            roomId: room.roomId,
            isPrivate: room.isPrivate,
            playerCount: room.players.length,
            maxPlayers: room.settings.players,
            currentRound: room.gameState.currentRound,
            totalRounds: room.settings.rounds,
            language: room.settings.language,
            creator: room.creator,
          });
        }
      }

      res.json({ rooms, count: rooms.length });
    })
  );

  // GET /admin/rooms/:roomId - Get room details
  router.get(
    "/rooms/:roomId",
    requireAdmin,
    asyncHandler(async (req: Request, res: Response) => {
      const { roomId } = req.params;
      const room = await getRedisRoom(roomId);

      if (!room) {
        return res.status(404).json({ error: "Room not found" });
      }

      res.json({ room });
    })
  );

  // DELETE /admin/rooms/:roomId - Delete a room
  router.delete(
    "/rooms/:roomId",
    requireAdmin,
    asyncHandler(async (req: Request, res: Response) => {
      const { roomId } = req.params;
      const room = await getRedisRoom(roomId);

      if (!room) {
        return res.status(404).json({ error: "Room not found" });
      }

      // Disconnect all players in the room
      io.to(roomId).emit("room_closed", {
        message: "This room has been closed by an administrator",
      });

      // Delete the room
      await import("../utils/redis").then((m) => m.deleteRedisRoom(roomId));

      logger.info("Room deleted by admin", { roomId });

      res.json({ message: "Room deleted successfully" });
    })
  );

  // GET /admin/metrics - Get metrics
  router.get(
    "/metrics",
    requireAdmin,
    asyncHandler(async (req: Request, res: Response) => {
      res.json(metrics.getMetrics());
    })
  );

  // GET /admin/anti-cheat - Get anti-cheat statistics
  router.get(
    "/anti-cheat",
    requireAdmin,
    asyncHandler(async (req: Request, res: Response) => {
      res.json({
        stats: AntiCheat.getStats(),
        bannedIPs: AntiCheat.getBannedIPs(),
      });
    })
  );

  // POST /admin/anti-cheat/ban - Ban an IP address
  router.post(
    "/anti-cheat/ban",
    requireAdmin,
    asyncHandler(async (req: Request, res: Response) => {
      const { ip, reason } = req.body;

      if (!ip) {
        return res.status(400).json({ error: "IP address is required" });
      }

      AntiCheat.banIP(ip, reason || "Banned by administrator");

      res.json({ message: `IP ${ip} has been banned` });
    })
  );

  // DELETE /admin/anti-cheat/ban/:ip - Unban an IP address
  router.delete(
    "/anti-cheat/ban/:ip",
    requireAdmin,
    asyncHandler(async (req: Request, res: Response) => {
      const { ip } = req.params;

      AntiCheat.unbanIP(ip);

      res.json({ message: `IP ${ip} has been unbanned` });
    })
  );

  // POST /admin/broadcast - Broadcast message to all clients
  router.post(
    "/broadcast",
    requireAdmin,
    asyncHandler(async (req: Request, res: Response) => {
      const { message } = req.body;

      if (!message) {
        return res.status(400).json({ error: "Message is required" });
      }

      io.emit("admin_broadcast", { message });

      logger.info("Admin broadcast sent", { message });

      res.json({ message: "Broadcast sent successfully" });
    })
  );

  // POST /admin/cache/clear - Clear cache
  router.post(
    "/cache/clear",
    requireAdmin,
    asyncHandler(async (req: Request, res: Response) => {
      const { prefix } = req.body;

      if (prefix) {
        const count = await cache.clearPrefix(prefix);
        res.json({ message: `Cleared ${count} cache entries with prefix: ${prefix}` });
      } else {
        // Clear all cache (implement if needed)
        res.json({ message: "Cache clearing not fully implemented yet" });
      }
    })
  );

  return router;
}

