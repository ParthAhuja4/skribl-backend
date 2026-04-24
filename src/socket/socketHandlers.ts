import { Server, Socket } from "socket.io";
import { getRoomFromSocket } from "../game/gameController";
import { GameEvent, Languages, PlayerData, Settings, RoomState, RounEndReason } from "../types";
import {
  endGame,
  endRound,
  guessWord,
  handleDrawAction,
  handleNewPlayerJoin,
  handleNewRoom,
  handlePlayerLeft,
  handleSettingsChange,
  handleVoteKick,
  handleVoteKickCast,
  startGame,
  wordSelected,
  clearAllRoomTimers,
  scheduleDrawDataSave,
} from "../game/roomController";
import { logger } from "../config/logger";
import { config } from "../config/env";
import {
  playerDataSchema,
  languageSchema,
  roomIdSchema,
  guessSchema,
  drawDataSchema,
  startGameSchema,
  voteKickSchema,
  safeValidate,
} from "../utils/validation";
import { extendRoomTTL, getRedisRoom, setRedisRoom, deleteRedisRoom } from "../utils/redis";
import { GameMetrics } from "../utils/metrics";
import { AntiCheat } from "../utils/antiCheat";
import { 
  storeReconnectionData, 
  handleReconnection, 
  getReconnectionData,
  clearReconnectionData
} from "../utils/reconnection";
import { 
  checkExistingSession, 
  registerSession, 
  removeSession 
} from "../utils/sessionManager";
import { transferHost } from "../utils/hostTransfer";
import { updatePlayerActivity, clearPlayerActivity } from "../utils/afkCleanup";

// Rate limiting per socket
const socketRateLimits = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT_WINDOW = 1000; // 1 second
const MAX_REQUESTS_PER_WINDOW = 50;

// Specific rate limits for different actions
const guessRateLimits = new Map<string, { count: number; resetTime: number }>();
const GUESS_RATE_LIMIT_WINDOW = 1000; // 1 second
const MAX_GUESS_REQUESTS_PER_WINDOW = 5;

// Specific rate limits for drawing actions
const drawRateLimits = new Map<string, { count: number; resetTime: number }>();
const DRAW_RATE_LIMIT_WINDOW = 1000; // 1 second
const MAX_DRAW_REQUESTS_PER_WINDOW = 120; // Allow 120 draw events per second (2x 60 FPS)

// Track active voice users per room with their mic status
interface VoiceUserState {
  userId: string;
  inVoiceChat: boolean;
  micEnabled: boolean;
}
const roomVoiceUsers = new Map<string, Map<string, VoiceUserState>>();

// ✅ CRITICAL FIX: Track heartbeats to detect stale/frozen connections
const lastHeartbeat = new Map<string, number>();
const STALE_CONNECTION_TIMEOUT = 15000; // 15 seconds without heartbeat = stale

/**
 * Clean up voice users for a room (prevents memory leak)
 * Call this when a room is deleted
 */
export function clearRoomVoiceUsers(roomId: string): void {
  if (roomVoiceUsers.has(roomId)) {
    roomVoiceUsers.delete(roomId);
    logger.debug("Cleared voice users for room", { roomId });
  }
}

function checkRateLimit(socketId: string): boolean {
  const now = Date.now();
  const limit = socketRateLimits.get(socketId);

  if (!limit || now > limit.resetTime) {
    socketRateLimits.set(socketId, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
    return true;
  }

  if (limit.count >= MAX_REQUESTS_PER_WINDOW) {
    GameMetrics.trackRateLimitHit();
    return false;
  }

  limit.count++;
  return true;
}

function checkGuessRateLimit(socketId: string): boolean {
  const now = Date.now();
  const limit = guessRateLimits.get(socketId);

  if (!limit || now > limit.resetTime) {
    guessRateLimits.set(socketId, { count: 1, resetTime: now + GUESS_RATE_LIMIT_WINDOW });
    return true;
  }

  if (limit.count >= MAX_GUESS_REQUESTS_PER_WINDOW) {
    GameMetrics.trackRateLimitHit();
    return false;
  }

  limit.count++;
  return true;
}

function checkDrawRateLimit(socketId: string): boolean {
  const now = Date.now();
  const limit = drawRateLimits.get(socketId);

  if (!limit || now > limit.resetTime) {
    drawRateLimits.set(socketId, { count: 1, resetTime: now + DRAW_RATE_LIMIT_WINDOW });
    return true;
  }

  if (limit.count >= MAX_DRAW_REQUESTS_PER_WINDOW) {
    GameMetrics.trackRateLimitHit();
    logger.warn("Draw rate limit exceeded", { socketId });
    return false;
  }

  limit.count++;
  return true;
}

// Clean up rate limits periodically
setInterval(() => {
  const now = Date.now();
  for (const [socketId, limit] of socketRateLimits.entries()) {
    if (now > limit.resetTime) {
      socketRateLimits.delete(socketId);
    }
  }
  for (const [socketId, limit] of guessRateLimits.entries()) {
    if (now > limit.resetTime) {
      guessRateLimits.delete(socketId);
    }
  }
  // CRITICAL FIX: Clean up draw rate limits to prevent memory leak
  for (const [socketId, limit] of drawRateLimits.entries()) {
    if (now > limit.resetTime) {
      drawRateLimits.delete(socketId);
    }
  }
}, 60000); // Clean every minute

// ✅ CRITICAL FIX: Check for stale connections every 10 seconds
// This detects frozen/zombie connections that stop sending heartbeats
setInterval(() => {
  const now = Date.now();
  let staleCount = 0;
  
  for (const [socketId, lastBeat] of lastHeartbeat.entries()) {
    if (now - lastBeat > STALE_CONNECTION_TIMEOUT) {
      logger.warn("Stale connection detected, forcing disconnect", { 
        socketId,
        lastHeartbeat: new Date(lastBeat).toISOString(),
        timeSinceLastBeat: `${Math.round((now - lastBeat) / 1000)}s`
      });
      
      // Find and disconnect the stale socket
      const io = global.socketIoInstance as Server | undefined;
      if (io) {
        const socket = io.sockets.sockets.get(socketId);
        if (socket) {
          socket.disconnect(true);
        }
      }
      
      lastHeartbeat.delete(socketId);
      staleCount++;
    }
  }
  
  if (staleCount > 0) {
    logger.info("Cleaned up stale connections", { count: staleCount });
  }
}, 10000); // Check every 10 seconds

export function setupSocket(io: Server) {
  // ✅ Store io instance globally for stale connection cleanup
  (global as any).socketIoInstance = io;
  
  io.on(GameEvent.CONNECT, async (socket: Socket) => {
    // ✅ CRITICAL FIX: Heartbeat handler to detect stale connections
    // Support both callback and no-callback versions
    socket.on("heartbeat", (data: { timestamp: number; socketId?: string; afterBackground?: boolean }, callback?: () => void) => {
      lastHeartbeat.set(socket.id, Date.now());
      
      // If this is a verification ping after backgrounding, log it
      if (data.afterBackground) {
        logger.info("Client verified connection after backgrounding", { 
          socketId: socket.id 
        });
      }
      
      // Acknowledge if callback provided (for verification)
      if (typeof callback === 'function') {
        callback();
      }
    });

    // TIME SYNC (server authoritative clock)
    socket.on("time_sync", (clientSentAt: number, cb?: (serverNowMs: number) => void) => {
      try {
        if (typeof cb === "function") {
          cb(Date.now());
        }
      } catch (error) {
        logger.error("Error in time_sync", { socketId: socket.id, error });
      }
    });

    const clientIP = socket.handshake.address;
    const auth = socket.handshake.auth as { playerToken?: string };
    
    // Check if IP is banned
    if (AntiCheat.isIPBanned(clientIP)) {
      logger.warn("Banned IP attempted connection", { ip: clientIP });
      socket.emit("error", "You have been banned from this server");
      socket.disconnect(true);
      return;
    }

    logger.info("User connected", { 
      socketId: socket.id, 
      ip: clientIP,
      hasPlayerToken: !!auth?.playerToken,
      referer: socket.handshake.headers.referer,
      origin: socket.handshake.headers.origin
    });
    
    // DISABLED AUTOMATIC RECONNECTION ON CONNECT
    // Reason: Server-side URL parsing from headers is unreliable and causes
    // users to join wrong rooms. Instead, let the client handle reconnection
    // explicitly through JOIN_ROOM events.
    //
    // If reconnection data exists, we log it but don't act on it automatically.
    // The client will send JOIN_ROOM with the correct roomId if needed.
    if (auth?.playerToken) {
      const reconnectionData = await getReconnectionData(auth.playerToken);
      
      if (reconnectionData) {
        logger.info("Found reconnection data (not auto-reconnecting)", {
          socketId: socket.id,
          savedRoomId: reconnectionData.roomId,
          playerToken: auth.playerToken,
          note: "Client will send explicit JOIN_ROOM if user wants to join"
        });
        
        // DO NOT auto-reconnect here
        // Let the client decide via explicit JOIN_ROOM event
      }
    }

    // Rate limit middleware - EXEMPT DRAW events from rate limiting
    socket.use((packet, next) => {
      const eventName = packet[0];
      
      // Skip rate limiting for DRAW events (they need to be real-time)
      if (eventName === GameEvent.DRAW) {
        return next();
      }
      
      if (!checkRateLimit(socket.id)) {
        logger.warn("Rate limit exceeded", { socketId: socket.id, event: eventName });
        socket.emit("error", "Too many requests. Please slow down.");
        return;
      }
      next();
    });
    // JOIN ROOM with validation
    socket.on(
      GameEvent.JOIN_ROOM,
      async (
        playerData: PlayerData,
        language: Languages = Languages.en,
        roomId?: string,
        isPrivate?: boolean
      ) => {
        try {
          logger.info("JOIN_ROOM event received", {
            socketId: socket.id,
            playerName: playerData?.name,
            requestedRoomId: roomId,
            isPrivate,
            language,
            currentRooms: Array.from(socket.rooms)
          });

          // Track room join for anti-cheat
          if (!AntiCheat.trackRoomJoin(socket.id)) {
            socket.emit("error", "Too many room joins. Please slow down.");
            return;
          }

          // Validate player data
          const playerValidation = safeValidate(playerDataSchema, playerData);
          if (!playerValidation.success) {
            const errors = playerValidation.error.issues.map((e) => e.message).join(", ");
            socket.emit("error", `Invalid player data: ${errors}`);
            logger.warn("Invalid player data", { socketId: socket.id, errors });
            GameMetrics.trackValidationError("player_data");
            return;
          }

          // Validate language
          const langValidation = safeValidate(languageSchema, language);
          if (!langValidation.success) {
            logger.error("Language validation failed", {
              socketId: socket.id,
              receivedLanguage: language,
              languageType: typeof language,
              validationError: langValidation.error.issues
            });
            socket.emit("error", "Invalid language selection");
            GameMetrics.trackValidationError("language");
            return;
          }

          // Validate room ID if provided
          if (roomId) {
            const roomValidation = safeValidate(roomIdSchema, roomId);
            if (!roomValidation.success) {
              socket.emit("error", "Invalid room ID");
              GameMetrics.trackValidationError("room_id");
              return;
            }
          }

          // Proceed with join
          if (!roomId) {
            // User is explicitly creating a new room, clear old reconnection data
            if (auth?.playerToken) {
              const { clearReconnectionData } = await import("../utils/reconnection");
              await clearReconnectionData(auth.playerToken);
              logger.info("Cleared reconnection data for new room creation", { 
                socketId: socket.id,
                playerToken: auth.playerToken 
              });
            }
            
            logger.info("Creating new room for player", {
              socketId: socket.id,
              playerName: playerValidation.data.name,
              isPrivate
            });
            
            await handleNewRoom(
              io,
              socket,
              playerValidation.data,
              langValidation.data,
              isPrivate
            );
          } else {
            // User is explicitly joining an existing room, clear old reconnection data
            if (auth?.playerToken) {
              const oldReconnectionData = await getReconnectionData(auth.playerToken);
              if (oldReconnectionData && oldReconnectionData.roomId !== roomId) {
                await clearReconnectionData(auth.playerToken);
                logger.info("Cleared reconnection data for joining different room", { 
                  socketId: socket.id,
                  playerToken: auth.playerToken,
                  oldRoom: oldReconnectionData.roomId,
                  newRoom: roomId
                });
              }
            }
            
            logger.info("Player joining existing room", {
              socketId: socket.id,
              playerName: playerValidation.data.name,
              roomId
            });
            
            await handleNewPlayerJoin(
              roomId,
              socket,
              io,
              playerValidation.data,
              langValidation.data
            );
          }
          
          // Register session after successful join
          if (auth?.playerToken) {
            const room = await getRoomFromSocket(socket);
            if (room) {
              registerSession(auth.playerToken, socket.id, room.roomId);
              
              // Track player activity (for AFK detection)
              await updatePlayerActivity(room.roomId, socket.id);
              
              logger.info("JOIN_ROOM completed successfully", {
                socketId: socket.id,
                roomId: room.roomId,
                playerCount: room.players.length,
                socketRooms: Array.from(socket.rooms)
              });
            }
          }
        } catch (error) {
          logger.error("Error in JOIN_ROOM", { socketId: socket.id, error });
          socket.emit("error", "Failed to join room. Please try again.");
        }
      }
    );

    // START GAME with validation
    socket.on(GameEvent.START_GAME, async (data: unknown) => {
      try {
        const room = await getRoomFromSocket(socket);
        if (!room) {
          socket.emit("error", "Room not found");
          logger.error("START_GAME: Room not found", { socketId: socket.id });
          return;
        }

        logger.info("START_GAME attempt", {
          socketId: socket.id,
          roomId: room.roomId,
          playersCount: room.players.length,
          players: room.players.map(p => ({ name: p.name, id: p.playerId })),
          creator: room.creator,
          isCreator: room.creator === socket.id,
          currentRound: room.gameState.currentRound
        });

        // Check permissions
        if (room.creator !== socket.id) {
          socket.emit("error", "You are not the host");
          logger.warn("Non-host tried to start game", { 
            socketId: socket.id, 
            roomId: room.roomId,
            actualCreator: room.creator,
            attemptedBy: socket.id
          });
          return;
        }

        if (room.gameState.currentRound !== 0) {
          socket.emit("error", "Game already started");
          logger.warn("Game already started", { roomId: room.roomId });
          return;
        }

        if (room.players.length < 2) {
          socket.emit("error", "At least 2 players required to join game");
          logger.error("START_GAME: Not enough players", {
            roomId: room.roomId,
            playersCount: room.players.length,
            players: room.players.map(p => p.name)
          });
          return;
        }

        // Validate custom words if provided
        const validation = safeValidate(startGameSchema, data || {});
        if (!validation.success) {
          socket.emit("error", "Invalid game start data");
          return;
        }

        if (validation.data.words) {
          room.settings.customWords = validation.data.words;
        }

        await startGame(room, io);
        
        // Track player activity
        await updatePlayerActivity(room.roomId, socket.id);
        
        logger.info("Game started successfully", { roomId: room.roomId, players: room.players.length });
      } catch (error) {
        logger.error("Error in START_GAME", { socketId: socket.id, error });
        socket.emit("error", "Failed to start game");
      }
    });

    // DRAW with rate limiting and validation
    socket.on(GameEvent.DRAW, async (drawData: unknown) => {
      try {
        // Check rate limit
        if (!checkDrawRateLimit(socket.id)) {
          // Silently drop - drawing is high-frequency, no need to error
          return;
        }
        
        // Extract roomId from the data payload or socket rooms
        const data = drawData as any;
        let roomId = data?.roomId;
        
        // If roomId not in data, get it from socket rooms
        if (!roomId) {
          const rooms = Array.from(socket.rooms);
          roomId = rooms.find(r => r !== socket.id);
        }
        
        if (!roomId) {
          logger.warn("Draw event without valid roomId", { socketId: socket.id });
          return;
        }
        
        // Verify player is current drawer (anti-cheat)
        const room = await getRoomFromSocket(socket);
        if (room && room.gameState.roomState === RoomState.DRAWING) {
          // CRITICAL FIX: Validate currentPlayer index
          if (room.gameState.currentPlayer >= room.players.length) {
            logger.error("currentPlayer index out of bounds in DRAW event", {
              socketId: socket.id,
              roomId,
              currentPlayer: room.gameState.currentPlayer,
              playersLength: room.players.length
            });
            return;
          }
          
          const currentDrawer = room.players[room.gameState.currentPlayer];
          if (currentDrawer?.playerId !== socket.id) {
            logger.warn("Non-drawer attempting to draw", { 
              socketId: socket.id, 
              roomId,
              actualDrawer: currentDrawer?.playerId 
            });
            // Don't call flagSuspicious directly as it's private, just return
            return;
          }
        }
        
        // Track player activity (for AFK detection)
        if (room) {
          await updatePlayerActivity(room.roomId, socket.id);
        }
        
        // Extract the actual drawing data (remove roomId from broadcast payload)
        // Preserve the type field for fill, undo, redo operations
        const dataToSend = { ...data };
        if (dataToSend?.roomId) {
          delete dataToSend.roomId; // Don't broadcast roomId to clients
        }
        
        // Handle batched drawing data more efficiently
        if (dataToSend?.type === 'draw_batch' && dataToSend?.data?.batch) {
          // Batch contains multiple draw points - broadcast as a single payload
          const payload = {
            type: 'draw_batch',
            batch: dataToSend.data.batch,
          };
          socket.to(roomId).emit(GameEvent.DRAW_DATA, payload);

          // Persist for reconnect/mid-game join rehydration
          if (room && room.gameState.currentRound !== 0) {
            room.gameState.drawingData.push(payload);
            scheduleDrawDataSave(room.roomId, room);
          }
        } else if (dataToSend?.type === 'fill' || dataToSend?.type === 'undo' || dataToSend?.type === 'redo') {
          // Special operations - broadcast with type preserved
          socket.to(roomId).emit(GameEvent.DRAW_DATA, dataToSend);

          // Persist for reconnect/mid-game join rehydration
          if (room && room.gameState.currentRound !== 0) {
            room.gameState.drawingData.push(dataToSend);
            scheduleDrawDataSave(room.roomId, room);
          }
        } else {
          // Single draw point - backward compatibility
          socket.to(roomId).emit(GameEvent.DRAW_DATA, dataToSend);

          // Persist for reconnect/mid-game join rehydration
          if (room && room.gameState.currentRound !== 0) {
            room.gameState.drawingData.push(dataToSend);
            scheduleDrawDataSave(room.roomId, room);
          }
        }
      } catch (error) {
        logger.error("Error in DRAW event", { socketId: socket.id, error });
      }
    });

    // DRAW CLEAR
    socket.on(GameEvent.DRAW_CLEAR, async () => {
      try {
        const room = await getRoomFromSocket(socket);
        if (room) {
          // Track player activity (for AFK detection)
          await updatePlayerActivity(room.roomId, socket.id);
        }
        await handleDrawAction(socket, "CLEAR");
      } catch (error) {
        logger.error("Error in DRAW_CLEAR", { socketId: socket.id, error });
      }
    });

    // DRAW UNDO (deprecated - handled via DRAW event with type 'undo')
    socket.on(GameEvent.DRAW_UNDO, async () => {
      try {
        // For backward compatibility, broadcast undo event
        const rooms = Array.from(socket.rooms);
        const roomId = rooms.find(r => r !== socket.id);
        if (roomId) {
          socket.to(roomId).emit(GameEvent.DRAW_DATA, { type: 'undo' });
        }
      } catch (error) {
        logger.error("Error in DRAW_UNDO", { socketId: socket.id, error });
      }
    });

    // DRAW REDO (deprecated - handled via DRAW event with type 'redo')
    socket.on(GameEvent.DRAW_REDO, async () => {
      try {
        // For backward compatibility, broadcast redo event
        const rooms = Array.from(socket.rooms);
        const roomId = rooms.find(r => r !== socket.id);
        if (roomId) {
          socket.to(roomId).emit(GameEvent.DRAW_DATA, { type: 'redo' });
        }
      } catch (error) {
        logger.error("Error in DRAW_REDO", { socketId: socket.id, error });
      }
    });

    // GUESS with validation
    socket.on(GameEvent.GUESS, async (data: unknown) => {
      try {
        // Check guess rate limit
        if (!checkGuessRateLimit(socket.id)) {
          socket.emit("error", "You are guessing too fast. Please slow down.");
          return;
        }

        // Extract guess from data
        const guessData = data as { guess: string };
        const validation = safeValidate(guessSchema, guessData.guess);
        
        if (!validation.success) {
          socket.emit("error", "Invalid guess");
          GameMetrics.trackValidationError("guess");
          return;
        }

        const room = await getRoomFromSocket(socket);
        if (!room) {
          socket.emit("error", "Room not found");
          return;
        }

        // Extend room TTL on activity
        await extendRoomTTL(room.roomId, room.isPrivate);

        // Track player activity (for AFK detection)
        await updatePlayerActivity(room.roomId, socket.id);

        // Determine if guess is correct (before processing)
        const player = room.players.find((e) => e.playerId === socket.id);
        const isCorrect =
          player &&
          room.gameState.word === validation.data.toLowerCase() &&
          !player.guessed;

        // Track guess for anti-cheat
        AntiCheat.trackGuess(socket.id, isCorrect || false);
        
        await guessWord(room.roomId, validation.data, socket, io);
      } catch (error) {
        logger.error("Error in GUESS", { socketId: socket.id, error });
        GameMetrics.trackError("guess");
      }
    });

    // WORD SELECT with validation
    socket.on(GameEvent.WORD_SELECT, async (word: unknown) => {
      try {
        if (typeof word !== "string" || !word.trim()) {
          socket.emit("error", "Invalid word selection");
          logger.warn("Invalid word selection - empty or not string", {
            socketId: socket.id,
            word
          });
          return;
        }

        const room = await getRoomFromSocket(socket);
        if (!room) {
          socket.emit("error", "Room not found");
          return;
        }
        
        // Track player activity (for AFK detection)
        await updatePlayerActivity(room.roomId, socket.id);

        // CRITICAL FIX: Validate currentPlayer index
        if (room.gameState.currentPlayer >= room.players.length) {
          socket.emit("error", "Invalid game state. Please refresh.");
          logger.error("currentPlayer index out of bounds in WORD_SELECT", {
            socketId: socket.id,
            roomId: room.roomId,
            currentPlayer: room.gameState.currentPlayer,
            playersLength: room.players.length
          });
          return;
        }
        
        // Verify it's the current player's turn
        const currentPlayer = room.players[room.gameState.currentPlayer];
        if (!currentPlayer || currentPlayer.playerId !== socket.id) {
          socket.emit("error", "It's not your turn to select a word");
          logger.warn("Word selection attempted by non-current player", {
            socketId: socket.id,
            currentPlayerId: currentPlayer?.playerId
          });
          return;
        }

        // Verify word hasn't already been selected
        if (room.gameState.word && room.gameState.word !== "") {
          logger.warn("Word already selected for this round", { 
            roomId: room.roomId,
            existingWord: room.gameState.word 
          });
          return;
        }

        logger.info("Word selected by player", { 
          roomId: room.roomId,
          playerId: socket.id,
          playerName: currentPlayer.name,
          word 
        });

        await wordSelected(room.roomId, word, io);
      } catch (error) {
        logger.error("Error in WORD_SELECT", { socketId: socket.id, error });
        socket.emit("error", "Failed to select word");
      }
    });

    // CHANGE SETTINGS
    socket.on(
      GameEvent.CHANGE_SETTIING, // Keep typo for backwards compatibility, will fix in types
      async (setting: keyof Settings, value: unknown) => {
        try {
          const room = await getRoomFromSocket(socket);
          if (room) {
            // Track player activity (for AFK detection)
            await updatePlayerActivity(room.roomId, socket.id);
          }
          await handleSettingsChange(socket, io, setting, value);
        } catch (error) {
          logger.error("Error in CHANGE_SETTING", { socketId: socket.id, error });
          socket.emit("error", "Failed to change settings");
        }
      }
    );

    // VOTE KICK - Initiate vote
    socket.on(GameEvent.VOTE_KICK, async (playerId: unknown) => {
      try {
        const validation = safeValidate(voteKickSchema, { playerId });
        if (!validation.success) {
          socket.emit("error", "Invalid player ID");
          return;
        }

        await handleVoteKick(socket, io, validation.data.playerId);
      } catch (error) {
        logger.error("Error in VOTE_KICK", { socketId: socket.id, error });
      }
    });

    // VOTE KICK CAST - Cast a vote
    socket.on(GameEvent.VOTE_KICK_CAST, async (data: { targetPlayerId: string; vote: 'upvote' | 'downvote' }) => {
      try {
        if (!data || !data.targetPlayerId || !data.vote) {
          socket.emit("error", "Invalid vote data");
          return;
        }

        if (data.vote !== 'upvote' && data.vote !== 'downvote') {
          socket.emit("error", "Invalid vote type");
          return;
        }

        await handleVoteKickCast(socket, io, data.targetPlayerId, data.vote);
      } catch (error) {
        logger.error("Error in VOTE_KICK_CAST", { socketId: socket.id, error });
      }
    });

    // LEAVE ROOM - Handle explicit room leaving
    socket.on(GameEvent.LEAVE_ROOM, async () => {
      try {
        logger.info("User explicitly leaving room", { socketId: socket.id });
        
        // IMPORTANT: Get room BEFORE leaving it, so handlePlayerLeft can find it
        const room = await getRoomFromSocket(socket);
        const roomId = room?.roomId;
        
        // Get all rooms this socket is in
        const socketRooms = Array.from(socket.rooms);
        
        // Clean up voice users from all rooms before leaving
        socketRooms.forEach(roomIdToClean => {
          if (roomIdToClean !== socket.id) {
            if (roomVoiceUsers.has(roomIdToClean)) {
              roomVoiceUsers.get(roomIdToClean)!.delete(socket.id);
              
              // Clean up empty maps
              if (roomVoiceUsers.get(roomIdToClean)!.size === 0) {
                roomVoiceUsers.delete(roomIdToClean);
              }
              
              // Notify room that this user left voice
              socket.to(roomIdToClean).emit(GameEvent.VOICE_USER_LEFT, {
                playerId: socket.id
              });
              
              logger.info("Cleaned up voice user on leave room", {
                socketId: socket.id,
                roomId: roomIdToClean,
                remainingVoiceUsers: Array.from(roomVoiceUsers.get(roomIdToClean)?.keys() || [])
              });
            }
          }
        });
        
        // Handle player leaving logic for the game room (BEFORE leaving socket room)
        // This ensures getRoomFromSocket can find the room
        if (room) {
          await handlePlayerLeft(socket, io);
        }
        
        // Now leave all rooms after handling player left
        socketRooms.forEach(roomIdToLeave => {
          if (roomIdToLeave !== socket.id) {
            socket.leave(roomIdToLeave);
            logger.info("Socket left room", {
              socketId: socket.id,
              roomId: roomIdToLeave
            });
          }
        });
      } catch (error) {
        logger.error("Error in LEAVE_ROOM", { socketId: socket.id, error });
      }
    });

    // DISCONNECT
    socket.on(GameEvent.DISCONNECT, async () => {
      try {
        const auth = socket.handshake.auth as { playerToken?: string };
        
        logger.info("User disconnected", { socketId: socket.id });

        // ✅ Clean up heartbeat tracking
        lastHeartbeat.delete(socket.id);

        // Get room before handling player left
        const room = await getRoomFromSocket(socket);
        const player = room?.players.find((p) => p.playerId === socket.id);

        // ✅ CRITICAL FIX: Add timeout to Redis operations to prevent blocking
        // Update lastSeenAt timestamp for reconnection timeout tracking
        if (room && player) {
          player.lastSeenAt = new Date();
          
          try {
            // Timeout Redis operation after 1 second
            await Promise.race([
              setRedisRoom(room.roomId, room),
              new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Redis timeout')), 1000)
              )
            ]);
          } catch (error) {
            logger.error("Failed to update room on disconnect (non-fatal)", { 
              socketId: socket.id, 
              roomId: room.roomId,
              error 
            });
            // Continue with disconnect - don't block on Redis failure
          }
        }

        // Store reconnection data if player was in a game
        if (room && player && auth?.playerToken) {
          try {
            // Timeout reconnection data storage after 1 second
            await Promise.race([
              storeReconnectionData(socket, room, player),
              new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Redis timeout')), 1000)
              )
            ]);
            
            // Don't immediately remove player - give grace period
            // Broadcast "player disconnected" instead of "player left"
            socket.to(room.roomId).emit("player_disconnected", {
              playerName: player.name,
              playerId: socket.id,
            });
            
            logger.info("Player disconnected, reconnection data stored", {
              playerName: player.name,
              socketId: socket.id,
              roomId: room.roomId,
              timeoutSeconds: config.RECONNECTION_TIMEOUT_SECONDS,
              ttlSeconds: config.RECONNECTION_TTL_SECONDS,
            });
            
            // NOTE: Player removal after timeout is handled by the reconnectionCleanup worker
            // This is Cloud Run compatible - the worker checks Redis periodically for expired reconnection data
          } catch (error) {
            logger.warn("Failed to store reconnection data, removing player immediately", { 
              socketId: socket.id,
              error 
            });
            // If Redis is down, remove player immediately instead of waiting
            await handlePlayerLeft(socket, io);
          }
        } else {
          // Not in a game or no token, remove immediately
          await handlePlayerLeft(socket, io);
        }

        // Clear AFK activity tracking for this player
        if (room) {
          await clearPlayerActivity(room.roomId, socket.id);
        }

        // Clean up voice users - remove from all rooms
        if (room?.roomId) {
          if (roomVoiceUsers.has(room.roomId)) {
            roomVoiceUsers.get(room.roomId)!.delete(socket.id);
            
            // Clean up empty maps
            if (roomVoiceUsers.get(room.roomId)!.size === 0) {
              roomVoiceUsers.delete(room.roomId);
            }
            
            // Notify room that this user left voice
            socket.to(room.roomId).emit(GameEvent.VOICE_USER_LEFT, {
              playerId: socket.id
            });
            
            logger.info("Cleaned up voice user on disconnect", {
              socketId: socket.id,
              roomId: room.roomId,
              remainingVoiceUsers: Array.from(roomVoiceUsers.get(room.roomId)?.keys() || [])
            });
          }
        }

        // Remove session
        if (auth?.playerToken) {
          removeSession(auth.playerToken);
        }

        // Track disconnect for anti-cheat
        AntiCheat.trackDisconnect(socket.id);
        
        // Clean up rate limits
        socketRateLimits.delete(socket.id);
        guessRateLimits.delete(socket.id);
        drawRateLimits.delete(socket.id);

        // Clean up anti-cheat data after some time
        setTimeout(() => {
          AntiCheat.clearBehavior(socket.id);
        }, 5 * 60 * 1000); // 5 minutes
      } catch (error) {
        logger.error("Error in DISCONNECT", { socketId: socket.id, error });
        GameMetrics.trackError("disconnect");
      }
    });

    // RECONNECT - Handle player reconnection
    socket.on("reconnect_request", async (oldSocketId: string) => {
      try {
        const success = await handleReconnection(socket, oldSocketId, io);
        if (!success) {
          socket.emit("reconnect_failed", {
            message: "Unable to reconnect. Please join a new game.",
          });
        }
      } catch (error) {
        logger.error("Error in RECONNECT", { socketId: socket.id, error });
        socket.emit("reconnect_failed", {
          message: "Reconnection failed. Please try again.",
        });
      }
    });

    // VOICE SIGNAL - WebRTC signaling relay
    socket.on(GameEvent.VOICE_SIGNAL, (data: { from: string; to: string; signal: any; roomId: string }) => {
      try {
        const { to, signal, roomId } = data;
        
        logger.info("Relaying voice signal", {
          from: socket.id,
          to,
          roomId,
          signalType: signal.type
        });

        // Forward the signal to the target peer
        io.to(to).emit(GameEvent.VOICE_SIGNAL, {
          from: socket.id,
          to,
          signal,
          roomId
        });
      } catch (error) {
        logger.error("Error in VOICE_SIGNAL", { socketId: socket.id, error });
      }
    });

    // VOICE USER JOINED - Notify room that user joined voice chat
    socket.on(GameEvent.VOICE_USER_JOINED, async (data: { roomId: string }) => {
      try {
        const { roomId } = data;
        
        logger.info("User joined voice chat", {
          socketId: socket.id,
          roomId
        });

        // Track this user in the room's voice users with mic status
        if (!roomVoiceUsers.has(roomId)) {
          roomVoiceUsers.set(roomId, new Map());
        }
        
        // Add user with initial state (in voice, mic off/silent track)
        roomVoiceUsers.get(roomId)!.set(socket.id, {
          userId: socket.id,
          inVoiceChat: true,
          micEnabled: false // Starts with silent track
        });

        // Get list of current voice users (excluding the one who just joined)
        const existingUsersMap = roomVoiceUsers.get(roomId)!;
        const currentVoiceUsers = Array.from(existingUsersMap.values())
          .filter(user => user.userId !== socket.id)
          .map(user => ({
            playerId: user.userId,
            inVoiceChat: user.inVoiceChat,
            micEnabled: user.micEnabled
          }));

        logger.info("Current voice users in room", {
          roomId,
          voiceUsers: currentVoiceUsers.map(u => ({ id: u.playerId, mic: u.micEnabled }))
        });

        // Send the list of current voice users to the new joiner
        socket.emit(GameEvent.VOICE_USER_JOINED, {
          playerId: socket.id, // Their own ID
          existingUsers: currentVoiceUsers // List with mic status
        });

        // Notify all other users in the room that this user joined
        socket.to(roomId).emit(GameEvent.VOICE_USER_JOINED, {
          playerId: socket.id
        });

        // ✅ Server-determined peer creation - prevents race conditions
        // Tell each existing user to create a connection with the new user (they initiate)
        currentVoiceUsers.forEach(existingUser => {
          io.to(existingUser.playerId).emit(GameEvent.VOICE_ADD_PEER, {
            peerId: socket.id,
            shouldCreateOffer: true // Existing users initiate to new user
          });
          
          logger.debug("Instructing existing user to connect", {
            existingUser: existingUser.playerId,
            newUser: socket.id,
            shouldCreateOffer: true
          });
        });

        // Tell the new user to prepare for connections (they wait for offers)
        currentVoiceUsers.forEach(existingUser => {
          socket.emit(GameEvent.VOICE_ADD_PEER, {
            peerId: existingUser.playerId,
            shouldCreateOffer: false // New user waits for offers from existing users
          });
          
          logger.debug("Instructing new user to await connection", {
            newUser: socket.id,
            existingUser: existingUser.playerId,
            shouldCreateOffer: false
          });
        });
      } catch (error) {
        logger.error("Error in VOICE_USER_JOINED", { socketId: socket.id, error });
      }
    });

    // VOICE USER LEFT - Notify room that user left voice chat
    socket.on(GameEvent.VOICE_USER_LEFT, async (data: { roomId: string }) => {
      try {
        const { roomId } = data;
        
        logger.info("User left voice chat", {
          socketId: socket.id,
          roomId
        });

        // Remove user from room's voice users
        if (roomVoiceUsers.has(roomId)) {
          roomVoiceUsers.get(roomId)!.delete(socket.id);
          
          // Clean up empty maps
          if (roomVoiceUsers.get(roomId)!.size === 0) {
            roomVoiceUsers.delete(roomId);
          }
        }

        // Notify all other users in the room
        socket.to(roomId).emit(GameEvent.VOICE_USER_LEFT, {
          playerId: socket.id
        });
      } catch (error) {
        logger.error("Error in VOICE_USER_LEFT", { socketId: socket.id, error });
      }
    });

    // VOICE USER MUTED - Notify room that user muted their mic
    socket.on(GameEvent.VOICE_USER_MUTED, async (data: { roomId: string }) => {
      try {
        const { roomId } = data;
        
        logger.info("User muted microphone", {
          socketId: socket.id,
          roomId
        });

        // Update mic status - they're still in voice chat
        const roomUsers = roomVoiceUsers.get(roomId);
        if (roomUsers && roomUsers.has(socket.id)) {
          const user = roomUsers.get(socket.id)!;
          user.micEnabled = false;
          roomUsers.set(socket.id, user);
        }

        // Notify others that this user muted
        socket.to(roomId).emit(GameEvent.VOICE_USER_MUTED, {
          playerId: socket.id
        });
      } catch (error) {
        logger.error("Error in VOICE_USER_MUTED", { socketId: socket.id, error });
      }
    });

    // VOICE USER UNMUTED - Notify room that user unmuted their mic
    socket.on(GameEvent.VOICE_USER_UNMUTED, async (data: { roomId: string }) => {
      try {
        const { roomId } = data;
        
        logger.info("User unmuted microphone", {
          socketId: socket.id,
          roomId
        });

        // Update mic status
        const roomUsers = roomVoiceUsers.get(roomId);
        if (roomUsers && roomUsers.has(socket.id)) {
          const user = roomUsers.get(socket.id)!;
          user.micEnabled = true;
          roomUsers.set(socket.id, user);
        }

        // Notify others that this user unmuted
        socket.to(roomId).emit(GameEvent.VOICE_USER_UNMUTED, {
          playerId: socket.id
        });
      } catch (error) {
        logger.error("Error in VOICE_USER_UNMUTED", { socketId: socket.id, error });
      }
    });
  });
}
