import { Server, Socket } from "socket.io";
import {
  Languages,
  Player,
  PlayerData,
  Room,
  RoomState,
  Settings,
} from "../types";
import {
  deleteRedisRoom,
  getPublicRoom,
  getRedisRoom,
  setRedisRoom,
} from "../utils/redis";
import { GameEvent, RounEndReason } from "../types";
import { convertToUnderscores, getRandomWords } from "../utils/word";
import { generateEmptyRoom } from "./gameController";
import { getRoomFromSocket } from "./gameController";
import {
  BONUS_PER_GUESS,
  DRAWER_POINTS,
  END_ROUND_TIME,
  HINTS_TIME,
  WINNER_SHOW_TIME,
  WORDCHOOSE_TIME,
  GUESSER_BASE_POINTS,
  GUESSER_MIN_POINTS,
  SCORE_TIER_1_END,
  SCORE_TIER_1_PENALTY,
  SCORE_TIER_2_END,
  SCORE_TIER_2_PENALTY,
  SCORE_TIER_3_END,
  SCORE_TIER_3_PENALTY,
  SCORE_TIER_4_PENALTY,
} from "../constants";
import { GameMetrics } from "../utils/metrics";
import { logger } from "../config/logger";
import { RedisLock } from "../utils/redisLock"; // ✅ CRITICAL FIX: Import Redis lock for race condition prevention

// Track drawing data saves to avoid excessive Redis writes
const roomDrawSaveTimers = new Map<string, NodeJS.Timeout>();
const DRAW_SAVE_INTERVAL = 2000; // Save every 2 seconds

/**
 * Clean up drawing save timer for a room (prevents memory leak)
 */
export function clearDrawSaveTimer(roomId: string): void {
  const timer = roomDrawSaveTimers.get(roomId);
  if (timer) {
    clearTimeout(timer);
    roomDrawSaveTimers.delete(roomId);
    logger.debug("Cleared draw save timer", { roomId });
  }
}

const timers = new Map();
const hintTimers = new Map();

// This is for new game on public rooms
const startGameTimers = new Map();

// Track vote kick timers
const voteKickTimers = new Map<string, NodeJS.Timeout>();

export function clearTimers(roomId: string) {
  const timer = timers.get(roomId);
  const hintTimer = hintTimers.get(roomId);
  if (timer) {
    clearTimeout(timer);
    timers.delete(roomId);
  }
  if (hintTimer) {
    clearTimeout(hintTimer);
    hintTimers.delete(roomId);
  }
}

// Helper function to clear vote kick timer
export function clearVoteKickTimer(roomId: string) {
  const timer = voteKickTimers.get(roomId);
  if (timer) {
    clearTimeout(timer);
    voteKickTimers.delete(roomId);
    logger.debug("Cleared vote kick timer", { roomId });
  }
}

// Helper function to clear all timers including startGameTimers and voteKickTimers
export function clearAllRoomTimers(roomId: string) {
  clearTimers(roomId);
  if (startGameTimers.has(roomId)) {
    clearTimeout(startGameTimers.get(roomId));
    startGameTimers.delete(roomId);
  }
  clearVoteKickTimer(roomId);
}

export async function startGame(room: Room, io: Server) {
  // Allow starting game even with 1 player - no minimum requirement!
  // This lets the game continue if someone is left alone

  clearTimers(room.roomId);
  room.gameState.currentRound = 1;
  room.gameState.currentPlayer = 0;
  room.gameState.guessedWords = [];
  room.gameState.drawingData = [];
  room.gameState.hintLetters = [];
  
  // Reset all player scores for new game
  room.players = room.players.map((player) => ({
    ...player,
    score: 0,
    guessed: false,
    guessedAt: null
  }));
  
  (room.gameState.roomState = RoomState.CHOOSING_WORD),
    await setRedisRoom(room.roomId, room);
  io.to(room.roomId).emit(GameEvent.GAME_STARTED, room);
  await nextRound(room.roomId, io);
  
  // Track metrics
  GameMetrics.trackGameStarted();
  logger.info("Game started", { roomId: room.roomId, players: room.players.length });
  
  return room;
}

export async function endRound(
  roomId: string,
  io: Server,
  reason: RounEndReason = RounEndReason.TIMEUP
) {
  let room = await getRedisRoom(roomId);
  if (!room) return;

  // Idempotency check: Prevent multiple simultaneous round endings
  if (room.gameState.isRoundEnding) {
    logger.info("Round is already ending, skipping duplicate call", {
      roomId,
      reason,
    });
    return;
  }

  // CRITICAL FIX: Atomic lock to prevent race condition
  // Try to acquire a lock using Redis SETNX
  const lockKey = `lock:endRound:${roomId}`;
  const { redisClient } = await import("../utils/redis");
  let lockAcquired = false;
  
  try {
    // Try to set the lock with a 10-second expiry (in case of crash)
    lockAcquired = (await redisClient.set(lockKey, "1", "EX", 10, "NX")) === "OK";
    
    if (!lockAcquired) {
      logger.info("Could not acquire endRound lock, another process is handling it", {
        roomId,
        reason,
      });
      return;
    }

    // Lock acquired, proceed with round ending
    logger.debug("Acquired endRound lock", { roomId });

    // Set flag to indicate round is ending (for in-process checks)
    room.gameState.isRoundEnding = true;
    await setRedisRoom(roomId, room);

  clearTimers(room.roomId);
  if (reason === RounEndReason.LEFT && room.players.length === 2) {
    // Reset flag before returning
    room.gameState.isRoundEnding = false;
    await setRedisRoom(roomId, room);
    return;
  }

  // CRITICAL FIX: Validate currentPlayer index before using it
  if (room.gameState.currentPlayer >= room.players.length && room.players.length > 0) {
    logger.warn("currentPlayer index out of bounds in endRound, resetting to 0", {
      roomId,
      currentPlayer: room.gameState.currentPlayer,
      playersLength: room.players.length
    });
    room.gameState.currentPlayer = 0;
  }

  // Store the current drawer index BEFORE incrementing
  const previousDrawerIndex = room.gameState.currentPlayer;

  room.gameState.currentPlayer += 1;

  // Check if playerCounter needs to be incremented
  if (room.gameState.currentPlayer >= room.players.length) {
    // Round end - wrap to next round
    room.gameState.currentRound += 1;
    room.gameState.currentPlayer = 0;
    
    logger.info("Round completed, advancing to next round", {
      roomId,
      newRound: room.gameState.currentRound,
      totalRounds: room.settings.rounds,
      playersCount: room.players.length
    });
  } else {
    logger.info("Turn completed, advancing to next player", {
      roomId,
      newCurrentPlayer: room.gameState.currentPlayer,
      newCurrentPlayerName: room.players[room.gameState.currentPlayer]?.name,
      currentRound: room.gameState.currentRound
    });
  }
  await setRedisRoom(roomId, room);

  // Award points using the previous drawer index
  await givePoints(roomId, previousDrawerIndex);
  room = await getRedisRoom(roomId);
  if (!room) return;
  room.gameState.drawingData = [];
  room.players = room.players.map((e) => {
    return { ...e, guessed: false, guessedAt: null };
  });
  
    // Reset flag after round ending is complete
    room.gameState.isRoundEnding = false;
    await setRedisRoom(roomId, room);

    io.to(room.roomId).emit(GameEvent.TURN_END, room, {
      word: room.gameState.word,
      reason,
      time: END_ROUND_TIME,
    });

    // Persist an explicit intermission phase so reconnecting / late-joining players
    // see the same "word reveal" screen and timer, rather than jumping into CHOOSING_WORD.
    room.gameState.roomState = RoomState.GUESSED;
    room.gameState.timerStartedAt = new Date();
    room.gameState.phaseDurationSec = END_ROUND_TIME;
    room.gameState.phaseEndsAtMs = Date.now() + END_ROUND_TIME * 1000;
    await setRedisRoom(roomId, room);

    // Continue the game even with 1 player - no player count check!
    // Let the game continue regardless of how many players remain

    const roundEndTimer = setTimeout(async () => {
      const currentRoom = await getRedisRoom(roomId);
      if (!currentRoom) {
        logger.info("Room not found during round end timer", { roomId });
        return;
      }
      
      // Check if all rounds completed
      if (currentRoom.gameState.currentRound > currentRoom.settings.rounds) {
        return await endGame(roomId, io);
      }
      
      // Continue to next round regardless of player count
      await nextRound(roomId, io);
    }, END_ROUND_TIME * 1000);
    timers.set(roomId, roundEndTimer); // Track the timer
  } catch (error) {
    logger.error("Error in endRound", { roomId, reason, error });
    throw error;
  } finally {
    // Always release the lock, even if there was an error
    if (lockAcquired) {
      try {
        await redisClient.del(lockKey);
        logger.debug("Released endRound lock", { roomId });
      } catch (unlockError) {
        logger.error("Failed to release endRound lock", { roomId, error: unlockError });
      }
    }
  }
}

export async function guessWord(
  roomId: string,
  guess: string,
  socket: Socket,
  io: Server
) {
  const room = await getRedisRoom(roomId);
  if (!room) return;

  const player = room.players.find((e) => e.playerId === socket.id);
  if (!player) return;

  // CRITICAL FIX: Validate currentPlayer index
  if (room.gameState.currentPlayer >= room.players.length) {
    logger.error("currentPlayer index out of bounds in guessWord", {
      roomId,
      currentPlayer: room.gameState.currentPlayer,
      playersLength: room.players.length
    });
    return;
  }

  const currentPlayer = room.players[room.gameState.currentPlayer];
  if (!currentPlayer) {
    logger.error("Current player not found in guessWord", {
      roomId,
      currentPlayer: room.gameState.currentPlayer
    });
    return;
  }
  
  // Normalize guess for comparison
  const normalizedGuess = guess.toLowerCase().trim();

  if (
    player.playerId !== currentPlayer.playerId &&
    room.gameState.word === normalizedGuess &&
    !player.guessed
  ) {
    // Mark player as guessed
    player.guessed = true;
    player.guessedAt = new Date();

    await setRedisRoom(room.roomId, room);
    io.to(room.roomId).emit(GameEvent.GUESSED, player);

    // Track metrics
    GameMetrics.trackGuess(true);

    // Check if all players (except the current one) have guessed
    if (
      room.players.every(
        (p) => p.guessed || p.playerId === currentPlayer.playerId
      )
    ) {
      await endRound(room.roomId, io, RounEndReason.ALL_GUESSED);
    }
  } else {
    // Track incorrect guess
    if (player.playerId !== currentPlayer.playerId) {
      GameMetrics.trackGuess(false);
    }
    io.to(room.roomId).emit(GameEvent.GUESS, guess, player);
  }
}

export async function nextRound(roomId: string, io: Server) {
  const room = await getRedisRoom(roomId);
  if (!room) return;

  // Continue the game even with 1 player - no player count validation!
  // The game will continue regardless of how many players remain

  // CRITICAL FIX: Validate and fix currentPlayer index if it's out of bounds
  // This can happen if players leave during the game
  if (room.gameState.currentPlayer >= room.players.length) {
    logger.warn("currentPlayer index out of bounds, resetting to 0", {
      roomId,
      currentPlayer: room.gameState.currentPlayer,
      playersLength: room.players.length
    });
    room.gameState.currentPlayer = 0;
  }
  
  // If no players remain, end the game
  if (room.players.length === 0) {
    logger.warn("No players remaining in nextRound", { roomId });
    return;
  }

  // Transition into CHOOSING_WORD phase (CRITICAL for mid-join/reconnect correctness).
  // Without persisting this, a rejoining client can get stuck seeing the intermission (GUESSED)
  // overlay even though the server is already sending CHOOSE_WORD/CHOOSING_WORD events.
  room.gameState.roomState = RoomState.CHOOSING_WORD;

  // Clear previous word revealed during intermission before starting CHOOSE_WORD
  room.gameState.word = "";

  // Set the current player
  const currentPlayer = room.players[room.gameState.currentPlayer];
  if (!currentPlayer) {
    logger.error("Current player not found after validation", {
      roomId,
      currentPlayer: room.gameState.currentPlayer,
      playersLength: room.players.length
    });
    return;
  }

  logger.info("Starting next round", {
    roomId,
    currentPlayerIndex: room.gameState.currentPlayer,
    currentPlayerId: currentPlayer.playerId,
    currentPlayerName: currentPlayer.name
  });

  // Get random words
  const words = await getRandomWords(
    room.settings.wordCount,
    room.settings.language,
    room.settings.onlyCustomWords,
    room.settings.customWords
  );

  logger.info("Emitting CHOOSE_WORD to current player", {
    roomId,
    playerId: currentPlayer.playerId,
    playerName: currentPlayer.name,
    wordsCount: words.length,
    time: WORDCHOOSE_TIME
  });

  // Start server-authoritative CHOOSE_WORD phase.
  // We persist both the offered words and a single "phase ends at" timestamp so
  // reconnecting players (especially the chooser) can resync perfectly.
  room.gameState.timerStartedAt = new Date(); // kept for backwards compatibility / metrics
  room.gameState.wordChoices = words;
  room.gameState.phaseDurationSec = WORDCHOOSE_TIME;
  room.gameState.phaseEndsAtMs = Date.now() + WORDCHOOSE_TIME * 1000;
  await setRedisRoom(room.roomId, room);

  // Send words to current player
  io.to(currentPlayer.playerId).emit(GameEvent.CHOOSE_WORD, {
    words,
    // New authoritative timer fields
    phaseDurationSec: WORDCHOOSE_TIME,
    phaseEndsAtMs: room.gameState.phaseEndsAtMs,
    // Backwards-compat fields (will be removed after client migration)
    time: WORDCHOOSE_TIME,
    timerStartedAtMs: room.gameState.timerStartedAt.getTime(),
  });

  logger.info("Emitting CHOOSING_WORD to other players", {
    roomId,
    exceptPlayerId: currentPlayer.playerId,
    time: WORDCHOOSE_TIME
  });

  // Send choosing word event to other players in the room
  io.to(room.roomId)
    .except(currentPlayer.playerId)
    .emit(GameEvent.CHOOSING_WORD, { 
      currentPlayer, 
      // New authoritative timer fields
      phaseDurationSec: WORDCHOOSE_TIME,
      phaseEndsAtMs: room.gameState.phaseEndsAtMs,
      // Backwards-compat fields (will be removed after client migration)
      time: WORDCHOOSE_TIME,
      timerStartedAtMs: room.gameState.timerStartedAt.getTime(),
    });

  const timeOut = setTimeout(async () => {
    const room = await getRedisRoom(roomId);
    if (!room) return;
    if (room.gameState.word != "") return;
    
    // Auto-select a random word from the provided options
    if (words && words.length > 0) {
      const randomWord = words[Math.floor(Math.random() * words.length)];
      logger.info("Auto-selecting word on timeout", { 
        roomId, 
        word: randomWord 
      });
      await wordSelected(roomId, randomWord, io);
    } else {
      logger.error("No words available for auto-selection", { roomId });
    }
  }, WORDCHOOSE_TIME * 1000);
  timers.set(roomId, timeOut);
}

export async function wordSelected(roomId: string, word: string, io: Server) {
  const room = await getRedisRoom(roomId);
  if (!room) return;
  clearTimers(room.roomId);

  // CRITICAL FIX: Validate currentPlayer index
  if (room.gameState.currentPlayer >= room.players.length) {
    logger.error("currentPlayer index out of bounds in wordSelected", {
      roomId,
      currentPlayer: room.gameState.currentPlayer,
      playersLength: room.players.length
    });
    return;
  }

  // CRITICAL FIX: Normalize word to lowercase for consistent comparison
  room.gameState.word = word.toLowerCase().trim();
  room.gameState.roomState = RoomState.DRAWING;
  room.gameState.timerStartedAt = new Date();
  // Start server-authoritative DRAWING phase timer
  room.gameState.wordChoices = [];
  room.gameState.phaseDurationSec = room.settings.drawTime;
  room.gameState.phaseEndsAtMs = Date.now() + room.settings.drawTime * 1000;
  await setRedisRoom(room.roomId, room);

  const player = room.players[room.gameState.currentPlayer];
  if (!player) {
    logger.error("Current player not found in wordSelected", {
      roomId,
      currentPlayer: room.gameState.currentPlayer
    });
    return;
  }

  // Track metrics
  GameMetrics.trackWordSelected(word.length);

  logger.info("Word selected and drawing phase starting", {
    roomId: room.roomId,
    word: room.gameState.word, // Log the normalized word
    drawerId: player.playerId,
    drawerName: player.name
  });

  // Send the selected word to the drawer (send original casing for display)
  io.to(player.playerId).emit(GameEvent.WORD_CHOSEN, {
    word: word, // Send original word with proper casing to drawer
    // New authoritative timer fields
    phaseDurationSec: room.settings.drawTime,
    phaseEndsAtMs: room.gameState.phaseEndsAtMs,
    // Backwards-compat fields (will be removed after client migration)
    time: room.settings.drawTime,
    timerStartedAtMs: room.gameState.timerStartedAt.getTime(),
  });

  // convert the word into array of letter lengths (use normalized word)
  const words_lens = convertToUnderscores(room.gameState.word);
  io.to(room.roomId).except(player.playerId).emit(GameEvent.GUESS_WORD_CHOSEN, {
    word: words_lens,
    // New authoritative timer fields
    phaseDurationSec: room.settings.drawTime,
    phaseEndsAtMs: room.gameState.phaseEndsAtMs,
    // Backwards-compat fields (will be removed after client migration)
    time: room.settings.drawTime,
    timerStartedAtMs: room.gameState.timerStartedAt.getTime(),
  });

  const timeOut = setTimeout(async () => {
    await endRound(roomId, io, RounEndReason.TIMEUP);
  }, room.settings.drawTime * 1000);
  timers.set(roomId, timeOut);

  if (room.settings.hints > 0) {
    const hintsTimeout = setTimeout(async () => {
      await sendHint(io, roomId);
    }, room.settings.drawTime * 0.5 * 1000);
    hintTimers.set(roomId, hintsTimeout);
  }
}

/**
 * Calculate guesser points using progressive time-based penalty system
 * - 0-30 sec: -5 pts/sec
 * - 30-60 sec: -10 pts/sec
 * - 60-90 sec: -15 pts/sec
 * - 90+ sec: -20 pts/sec
 * Minimum: 25 points (floor)
 */
function calculateGuesserPoints(guessTimeInSeconds: number): number {
  let deduction = 0;
  let remainingTime = guessTimeInSeconds;
  
  // Tier 1: 0-30 seconds (-5 pts/sec)
  if (remainingTime > 0) {
    const tier1Time = Math.min(remainingTime, SCORE_TIER_1_END);
    deduction += tier1Time * SCORE_TIER_1_PENALTY;
    remainingTime -= tier1Time;
  }
  
  // Tier 2: 30-60 seconds (-10 pts/sec)
  if (remainingTime > 0) {
    const tier2Duration = SCORE_TIER_2_END - SCORE_TIER_1_END; // 30 seconds
    const tier2Time = Math.min(remainingTime, tier2Duration);
    deduction += tier2Time * SCORE_TIER_2_PENALTY;
    remainingTime -= tier2Time;
  }
  
  // Tier 3: 60-90 seconds (-15 pts/sec)
  if (remainingTime > 0) {
    const tier3Duration = SCORE_TIER_3_END - SCORE_TIER_2_END; // 30 seconds
    const tier3Time = Math.min(remainingTime, tier3Duration);
    deduction += tier3Time * SCORE_TIER_3_PENALTY;
    remainingTime -= tier3Time;
  }
  
  // Tier 4: After 90 seconds (-20 pts/sec)
  if (remainingTime > 0) {
    deduction += remainingTime * SCORE_TIER_4_PENALTY;
  }
  
  // Calculate final points with floor minimum
  const finalPoints = GUESSER_BASE_POINTS - Math.round(deduction);
  return Math.max(finalPoints, GUESSER_MIN_POINTS);
}

export async function givePoints(roomId: string, drawerIndex: number) {
  const room = await getRedisRoom(roomId);
  if (!room) return;
  
  // CRITICAL FIX: Validate drawerIndex
  if (drawerIndex < 0 || drawerIndex >= room.players.length) {
    logger.warn("Invalid drawerIndex in givePoints, skipping point allocation", {
      roomId,
      drawerIndex,
      playersLength: room.players.length
    });
    await setRedisRoom(room.roomId, room);
    return;
  }
  
  const roundStartTime = new Date(room.gameState.timerStartedAt);
  const playersWhoGuessed = room.players.filter((player) => player.guessed);
  
  if (playersWhoGuessed.length === 0) {
    // No one guessed - no points awarded to drawer either
    await setRedisRoom(room.roomId, room);
    return;
  }

  // Award points to guessers using progressive time-based scoring
  playersWhoGuessed.forEach((player) => {
    const guessedAtTime = new Date(player.guessedAt ?? roundStartTime);
    const guessTime = Math.abs((guessedAtTime.getTime() - roundStartTime.getTime()) / 1000);
    
    const pointsAwarded = calculateGuesserPoints(guessTime);
    player.score += pointsAwarded;
    
    logger.debug("Points awarded to guesser", {
      playerName: player.name,
      guessTime: `${guessTime.toFixed(2)}s`,
      pointsAwarded,
      basePoints: GUESSER_BASE_POINTS,
      minPoints: GUESSER_MIN_POINTS,
    });
  });

  // Award points to drawer: base + bonus per correct guess
  const drawer = room.players[drawerIndex];
  if (drawer) {
    const drawerPoints = DRAWER_POINTS + playersWhoGuessed.length * BONUS_PER_GUESS;
    drawer.score += drawerPoints;
    
    logger.debug("Points awarded to drawer", {
      playerName: drawer.name,
      drawerIndex,
      basePoints: DRAWER_POINTS,
      bonusPerGuess: BONUS_PER_GUESS,
      correctGuesses: playersWhoGuessed.length,
      bonusPoints: playersWhoGuessed.length * BONUS_PER_GUESS,
      totalPoints: drawerPoints,
    });
  }
  
  await setRedisRoom(room.roomId, room);
}

export async function endGame(roomId: string, io: Server) {
  const room = await getRedisRoom(roomId);
  if (!room) return;

  // CRITICAL FIX: Use clearAllRoomTimers to ensure ALL timers are cleared
  clearAllRoomTimers(room.roomId);

  room.gameState.currentRound = 0;
  room.gameState.word = "";
  room.gameState.guessedWords = [];
  room.gameState.roomState = RoomState.NOT_STARTED;
  room.vote_kickers = [];
  
  // Reset all player scores when game ends
  room.players = room.players.map((player) => ({
    ...player,
    score: 0,
    guessed: false,
    guessedAt: null
  }));
  
  await setRedisRoom(roomId, room);
  io.to(roomId).emit(GameEvent.GAME_ENDED, { room, time: WINNER_SHOW_TIME });

  // Track metrics
  GameMetrics.trackGameEnded(0); // We could track actual duration if needed

  // Public + private rooms now rely on the host to start the next game.
  // Ensure we don't have any leftover auto-start timers.
  if (startGameTimers.has(roomId)) {
    clearTimeout(startGameTimers.get(roomId));
    startGameTimers.delete(roomId);
  }
}

export const handleNewRoom = async (
  io: Server,
  socket: Socket,
  playerData: PlayerData,
  language: Languages,
  isPrivate?: boolean
) => {
  let roomId;
  if (isPrivate) {
    roomId = await generateEmptyRoom(socket, isPrivate, language);
  } else {
    const room = await getPublicRoom(language);
    if (!room) {
      roomId = await generateEmptyRoom(socket, false, language);
    } else {
      roomId = room.roomId;
    }
  }

  // Track metrics
  GameMetrics.trackRoomCreated(isPrivate || false);

  handleNewPlayerJoin(roomId, socket, io, playerData, language);
};

// Schedule periodic save of drawing data
export function scheduleDrawDataSave(roomId: string, room: Room) {
  // Clear existing timer if any
  if (roomDrawSaveTimers.has(roomId)) {
    clearTimeout(roomDrawSaveTimers.get(roomId)!);
  }

  // Schedule new save
  const timer = setTimeout(async () => {
    await setRedisRoom(roomId, room);
    roomDrawSaveTimers.delete(roomId);
  }, DRAW_SAVE_INTERVAL);

  roomDrawSaveTimers.set(roomId, timer);
}

export async function handleDrawAction(
  socket: Socket,
  action: "DRAW" | "CLEAR" | "UNDO" | "REDO",
  drawData?: any
) {
  const room = await getRoomFromSocket(socket);
  if (!room || room.gameState.currentRound === 0) return;

  // CRITICAL FIX: Validate currentPlayer index
  if (room.gameState.currentPlayer >= room.players.length) {
    logger.error("currentPlayer index out of bounds in handleDrawAction", {
      roomId: room.roomId,
      currentPlayer: room.gameState.currentPlayer,
      playersLength: room.players.length
    });
    return;
  }

  const currentPlayer = room.players[room.gameState.currentPlayer];
  if (!currentPlayer || currentPlayer.playerId !== socket.id) return;

  switch (action) {
    case "DRAW":
      if (!drawData) return;
      room.gameState.drawingData.push(drawData);
      
      // Extract the actual draw data from the wrapper if it exists
      const dataToSend = drawData.data || drawData;
      
      // Broadcast immediately to all other players for real-time drawing
      socket.to(room.roomId).emit(GameEvent.DRAW_DATA, dataToSend);
      GameMetrics.trackDrawAction();
      // Schedule periodic save instead of saving on every draw
      scheduleDrawDataSave(room.roomId, room);
      break;

    case "CLEAR":
      room.gameState.drawingData = [];
      socket.to(room.roomId).emit(GameEvent.DRAW_DATA, { type: 'clear' });
      await setRedisRoom(room.roomId, room);
      break;

    case "UNDO":
      room.gameState.drawingData.pop();
      socket.to(room.roomId).emit(GameEvent.DRAW_DATA, { type: 'undo' });
      await setRedisRoom(room.roomId, room);
      break;

    case "REDO":
      // Broadcast redo to all other players
      socket.to(room.roomId).emit(GameEvent.DRAW_DATA, { type: 'redo' });
      await setRedisRoom(room.roomId, room);
      break;
  }
}

export const handlePlayerLeft = async (socket: Socket, io: Server) => {
  let room = await getRoomFromSocket(socket);
  if (!room) return;

  const currentPlayer = room.players[room.gameState.currentPlayer];
  if (currentPlayer && currentPlayer.playerId === socket.id) {
    await endRound(room.roomId, io, RounEndReason.LEFT);
    // Refresh room state after ending round
    room = await getRedisRoom(room.roomId);
    if (!room) return;
  }

  const player = room.players.find((e) => e.playerId === socket.id);
  if (!player) return;
  
  const wasHost = room.creator === player.playerId;
  
  // CRITICAL FIX: Find the leaving player's index BEFORE removing them
  const leavingPlayerIndex = room.players.findIndex((e) => e.playerId === socket.id);
  
  room.players = room.players.filter((e) => e.playerId != socket.id);
  
  // CRITICAL FIX: Adjust currentPlayer index if a player before them left
  // This prevents the round rotation from skipping players or pointing to the wrong player
  if (leavingPlayerIndex !== -1 && leavingPlayerIndex < room.gameState.currentPlayer) {
    room.gameState.currentPlayer -= 1;
    logger.info("Adjusted currentPlayer index after player left", {
      roomId: room.roomId,
      leavingPlayerIndex,
      newCurrentPlayer: room.gameState.currentPlayer,
      remainingPlayers: room.players.length
    });
  }
  
  // CRITICAL FIX: If currentPlayer index is now out of bounds, wrap it to 0
  // This can happen if the last player in the array left and they were after the current player
  if (room.gameState.currentPlayer >= room.players.length && room.players.length > 0) {
    room.gameState.currentPlayer = 0;
    logger.info("Wrapped currentPlayer to 0 after player left", {
      roomId: room.roomId,
      remainingPlayers: room.players.length
    });
  }
  
  // Track metrics
  GameMetrics.trackPlayerLeft();
  
  // CRITICAL: Immediately delete public rooms when last player leaves
  // For public rooms, don't wait for reconnection grace period
  if (room.players.length === 0) {
    clearAllRoomTimers(room.roomId); // Clear all timers before deletion
    await deleteRedisRoom(room.roomId);
    GameMetrics.trackRoomDeleted();
    logger.info("Room deleted - all players left", { 
      roomId: room.roomId, 
      isPrivate: room.isPrivate 
    });
    return;
  }

  // Transfer host if the leaving player was host (BEFORE saving to Redis)
  if (wasHost && room.players.length > 0) {
    const { transferHost } = await import("../utils/hostTransfer");
    await transferHost(room, io, player.playerId);
  }

  // If game is already running and only 1 player remains, end the game and show winners/leaderboard.
  // This applies to BOTH private and public rooms.
  if (room.players.length === 1 && room.gameState.currentRound >= 1) {
    await setRedisRoom(room.roomId, room);

    // Optional: still notify others that the player left (the remaining player will receive it).
    io.to(room.roomId).emit(GameEvent.PLAYER_LEFT, player);
    io.to(room.roomId).emit(GameEvent.JOINED_ROOM, room);

    await endGame(room.roomId, io);
    return;
  }

  // If only 1 player remains in LOBBY (not started), clear auto-start timers
  // But DON'T end the game if it's already in progress - let it continue!
  if (room.players.length === 1 && room.gameState.currentRound === 0) {
    // Only clear auto-start if game hasn't started yet
    if (startGameTimers.has(room.roomId)) {
      clearTimeout(startGameTimers.get(room.roomId));
      startGameTimers.delete(room.roomId);
      logger.info("Cleared auto-start timer: only 1 player in lobby", {
        roomId: room.roomId,
        remainingPlayer: room.players[0]?.name || 'unknown'
      });
    }
  }
  // If game is in progress (currentRound >= 1), let it continue even with 1 player!

  await setRedisRoom(room.roomId, room);
  
  // Emit PLAYER_LEFT event for UI updates
  socket.to(room.roomId).emit(GameEvent.PLAYER_LEFT, player);
  
  // Also emit JOINED_ROOM to sync all clients with authoritative room state
  // This ensures host transfer and game state reset are reflected immediately in all clients
  io.to(room.roomId).emit(GameEvent.JOINED_ROOM, room);
};

export const handleSettingsChange = async (
  socket: Socket,
  io: Server,
  setting: keyof Settings,
  value: any
) => {
  if (typeof setting !== "string") return;

  const room = await getRoomFromSocket(socket);
  if (!room) return;

  if (!(setting in room.settings))
    return socket.emit("error", "Invalid setting value");

  const settingType = typeof room.settings[setting];
  if (typeof value !== settingType)
    return socket.emit("error", `Invalid value type for ${setting}`);

  // @ts-ignore
  room.settings[setting] = value as SettingValue;

  await setRedisRoom(room.roomId, room);
  io.to(room.roomId).emit(GameEvent.SETTINGS_CHANGED, setting, value);
};

export async function sendHint(io: Server, roomId: string) {
  const room = await getRedisRoom(roomId);
  if (!room) return;
  const word = room.gameState.word;
  if (!word) return;
  if (room.gameState.hintLetters.length >= room.settings.hints) return;

  if (hintTimers.get(roomId)) clearTimeout(hintTimers.get(roomId));

  // Cannot make the whole word appear randomly
  if (room.gameState.hintLetters.length - 1 >= word.length) return;

  // CRITICAL FIX: Validate currentPlayer index
  if (room.gameState.currentPlayer >= room.players.length) {
    logger.error("currentPlayer index out of bounds in sendHint", {
      roomId,
      currentPlayer: room.gameState.currentPlayer,
      playersLength: room.players.length
    });
    return;
  }

  const currentPlayer = room.players[room.gameState.currentPlayer];
  if (!currentPlayer) {
    logger.error("Current player not found in sendHint", {
      roomId,
      currentPlayer: room.gameState.currentPlayer
    });
    return;
  }

  const revealedIndices = new Set<number>();

  // Reveal some characters based on word length
  while (revealedIndices.size < Math.ceil(word.length / 3)) {
    const index = Math.floor(Math.random() * word.length);
    revealedIndices.add(index);
  }

  // Create an array of revealed letters with indices
  const hintArray = Array.from(revealedIndices).map((index) => ({
    index,
    letter: word[index],
  }));
  // Get a random element from the hint array
  const randomIndex = Math.floor(Math.random() * hintArray.length);
  const hint = hintArray[randomIndex];
  room.gameState.hintLetters.push(hint);

  // Emit hint to the room
  io.to(roomId)
    .except(currentPlayer.playerId)
    .emit(GameEvent.GUESS_HINT, hint);

  if (room.gameState.hintLetters.length !== room.settings.hints) {
    hintTimers.set(roomId, setTimeout(sendHint, HINTS_TIME * 1000, io, roomId));
  }
}

export async function handleNewPlayerJoin(
  roomId: string,
  socket: Socket,
  io: Server,
  playerData: PlayerData,
  language: Languages
) {
  // ✅ CRITICAL FIX: Acquire lock before reading/modifying room
  // This prevents race conditions when multiple players join simultaneously
  const lockKey = RedisLock.getRoomLockKey(roomId);
  const lockAcquired = await RedisLock.acquire(lockKey);
  
  if (!lockAcquired) {
    socket.emit("error", "Server is busy. Please try again in a moment.");
    logger.warn("Failed to acquire room lock for join", { 
      roomId, 
      socketId: socket.id,
      playerName: playerData.name 
    });
    return;
  }

  try {
    const room = await getRedisRoom(roomId);
    if (!room) {
      await RedisLock.release(lockKey);
      return handleNewRoom(io, socket, playerData, language, false);
    }

  // Ensure public rooms also have a host/creator.
  // (Legacy compatibility: older public rooms were created with creator = null.)
  if (room.creator == null) {
    room.creator = room.players[0]?.playerId ?? socket.id;
    await setRedisRoom(room.roomId, room);
  }

  // CRITICAL FIX: Join socket to room IMMEDIATELY after validation
  // This ensures the socket is in the room before ANY operations or broadcasts
  // Leave all other rooms first to prevent cross-room event contamination
  const socketRooms = Array.from(socket.rooms);
  socketRooms.forEach(roomToLeave => {
    if (roomToLeave !== socket.id && roomToLeave !== roomId) {
      socket.leave(roomToLeave);
      logger.info("Socket left old room before join", {
        socketId: socket.id,
        oldRoom: roomToLeave,
        newRoom: roomId
      });
    }
  });

  // Join the socket to the room NOW - before any player operations
  socket.join(roomId);
  (socket as any).currentRoomId = roomId;
  
  logger.info("Socket joined room", {
    socketId: socket.id,
    roomId: roomId,
    socketRooms: Array.from(socket.rooms),
    playerCount: room.players.length
  });

  if (room.players.length >= room.settings.players) {
    socket.emit("error", "The room you're trying to join is full");
    return socket.disconnect();
  }

  // Get player token from auth
  const auth = socket.handshake.auth as { playerToken?: string };
  const playerToken = auth?.playerToken;

  // Check if player with same token already exists (reliable reconnection detection)
  // Fallback to name matching if no token (legacy support)
  let existingPlayerIndex = -1;
  let matchedByToken = false;
  
  if (playerToken) {
    // Primary: Match by playerToken (most reliable)
    existingPlayerIndex = room.players.findIndex(
      (p) => p.playerToken === playerToken
    );
    matchedByToken = existingPlayerIndex !== -1;
    logger.info("Checking for existing player by token", {
      roomId: room.roomId,
      playerToken,
      foundPlayer: existingPlayerIndex !== -1
    });
  }
  
  if (existingPlayerIndex === -1) {
    // Fallback: Match by name (less reliable, for legacy support)
    existingPlayerIndex = room.players.findIndex(
      (p) => p.name === playerData.name
    );
    if (existingPlayerIndex !== -1) {
      logger.info("Found player by name (no token match)", {
        roomId: room.roomId,
        playerName: playerData.name
      });
    }
  }
  
  let wasHost = false;
  let isReconnection = false;
  let newPlayer: Player; // may be set to existing player on reconnection
  let oldSocketId: string | undefined; // Store old socket ID for logging
  
  if (existingPlayerIndex !== -1) {
    const existingPlayer = room.players[existingPlayerIndex];
    wasHost = room.creator === existingPlayer.playerId;
    oldSocketId = existingPlayer.playerId; // Save for later logging
    
    // Check if this is a reconnection (same player, different socket)
    // vs. a name collision (different player, same name).
    // If we matched by token, it's ALWAYS a reconnection.
    if (matchedByToken && playerToken && existingPlayer.playerToken === playerToken) {
      isReconnection = true;
      logger.info("Reconnection detected via playerToken match", {
        roomId: room.roomId,
        playerName: playerData.name,
        playerToken,
        oldSocketId: existingPlayer.playerId,
        newSocketId: socket.id
      });
    } else {
      // Name match without token - check if it's a recent disconnect (within 60 seconds)
      const timeSinceLastSeen = existingPlayer.lastSeenAt 
        ? Date.now() - existingPlayer.lastSeenAt.getTime()
        : Infinity;
      isReconnection = timeSinceLastSeen < 60000; // 60 seconds grace period
      
      logger.info("Player with same name found (no token match)", {
        roomId: room.roomId,
        playerName: playerData.name,
        oldSocketId: existingPlayer.playerId,
        newSocketId: socket.id,
        wasHost,
        isReconnection,
        timeSinceLastSeen,
        hasToken: !!playerToken
      });
    }

    // If this is NOT a reconnection, treat it as a name collision and reject.
    // The old behavior removed the existing player, which could break an active game.
    if (!isReconnection) {
      socket.emit("error", "Name already taken in this room. Please choose a different name.");
      return;
    }
    
    // Reconnection: update the existing player IN PLACE to preserve turn order.
    // Reordering the players array mid-game can corrupt `gameState.currentPlayer` indexing and freeze the game.
    room.players[existingPlayerIndex] = {
      ...existingPlayer,
      ...playerData,
      playerId: socket.id,
      playerToken: playerToken || existingPlayer.playerToken,
      lastSeenAt: new Date(),
    };
    newPlayer = room.players[existingPlayerIndex];

    // If they were host, update creator to the new socket id (private OR public).
    if (room.creator === oldSocketId) {
      room.creator = socket.id;
      logger.info("Host updated for reconnection", {
        roomId: room.roomId,
        oldSocketId,
        newSocketId: socket.id,
      });
    }
  } else {
    // New player joining
    newPlayer = {
      ...playerData,
      score: 0,
      playerId: socket.id,
      playerToken: playerToken, // Store token for future reconnection detection
      guessed: false,
      guessedAt: null,
      lastSeenAt: new Date(), // Track activity for reconnection timeout
    };

    room.players.push(newPlayer);
  }

  await setRedisRoom(roomId, room);

  // Send the room state to the joining player
  socket.emit(GameEvent.JOINED_ROOM, room);
  
  if (isReconnection) {
    // For reconnections, broadcast the updated room state to ALL players
    // This prevents duplicate players by giving everyone the authoritative state
    logger.info("Broadcasting room state update for reconnection", {
      roomId: room.roomId,
      playerName: newPlayer.name,
      oldSocketId: oldSocketId || 'unknown',
      newSocketId: newPlayer.playerId,
      totalPlayers: room.players.length
    });
    
    // Send full room state to all other players (not the reconnecting one)
    socket.to(room.roomId).emit(GameEvent.JOINED_ROOM, room);
    
    // Emit notification event for UI feedback
    io.to(room.roomId).emit("player_reconnected", {
      playerName: newPlayer.name,
      playerId: newPlayer.playerId,
    });
  } else {
    // For new joins, broadcast PLAYER_JOINED event
    logger.info("Broadcasting PLAYER_JOINED event", {
      roomId: room.roomId,
      newPlayerName: newPlayer.name,
      newPlayerId: newPlayer.playerId,
      totalPlayers: room.players.length,
      socketsInRoom: Array.from(io.sockets.adapter.rooms.get(roomId) || []).length
    });
    
    io.to(room.roomId).emit(GameEvent.PLAYER_JOINED, newPlayer);
  }

  // Track metrics
  GameMetrics.trackPlayerJoined();

  // Public rooms now behave like private rooms: host manually starts the game.
  // (Previously public rooms auto-started when >=2 players joined.)

  if (room.gameState.roomState != RoomState.NOT_STARTED) {
    handleInBetweenJoin(roomId, socket, io);
  }
  } finally {
    // ✅ Always release the lock, even if there's an error
    await RedisLock.release(lockKey);
  }
}

export async function handleInBetweenJoin(
  roomId: string,
  socket: Socket,
  io: Server
) {
  const room = await getRedisRoom(roomId);
  if (!room) return;
  socket.join(roomId);
  (socket as any).currentRoomId = roomId; // Optional: for debugging

  const nowMs = Date.now();

  // Prefer server-authoritative phaseEndsAtMs. Fall back to timerStartedAt if missing.
  const fallbackDurationSec =
    room.gameState.roomState === RoomState.CHOOSING_WORD
      ? WORDCHOOSE_TIME
      : room.gameState.roomState === RoomState.GUESSED
        ? END_ROUND_TIME
        : room.settings.drawTime;
  const fallbackStartMs = new Date(room.gameState.timerStartedAt).getTime();
  const phaseEndsAtMs =
    typeof room.gameState.phaseEndsAtMs === "number"
      ? room.gameState.phaseEndsAtMs
      : fallbackStartMs + fallbackDurationSec * 1000;
  const phaseDurationSec =
    typeof room.gameState.phaseDurationSec === "number"
      ? room.gameState.phaseDurationSec
      : fallbackDurationSec;

  const msLeft = phaseEndsAtMs - nowMs;

  // If chooser phase already ended but the word wasn't selected (e.g. chooser disconnected),
  // force a server-side auto-pick now so everyone stays in sync.
  if (
    msLeft <= 0 &&
    room.gameState.roomState === RoomState.CHOOSING_WORD &&
    room.gameState.word === ""
  ) {
    const choices = Array.isArray(room.gameState.wordChoices)
      ? room.gameState.wordChoices
      : [];
    if (choices.length > 0) {
      const randomWord = choices[Math.floor(Math.random() * choices.length)];
      await wordSelected(roomId, randomWord, io);
    }
  }

  // Re-load room in case we auto-picked and transitioned to DRAWING above
  const refreshedRoom = await getRedisRoom(roomId);
  if (!refreshedRoom) return;

  const effectiveEndsAtMs =
    typeof refreshedRoom.gameState.phaseEndsAtMs === "number"
      ? refreshedRoom.gameState.phaseEndsAtMs
      : phaseEndsAtMs;
  const effectiveDurationSec =
    typeof refreshedRoom.gameState.phaseDurationSec === "number"
      ? refreshedRoom.gameState.phaseDurationSec
      : phaseDurationSec;
  const effectiveMsLeft = effectiveEndsAtMs - Date.now();
  const time = Math.max(0, Math.ceil(effectiveMsLeft / 1000));

  const gameStateWithoutWord = {
    ...refreshedRoom.gameState,
    word: convertToUnderscores(refreshedRoom.gameState.word),
    time,
    timerStartedAtMs: new Date(refreshedRoom.gameState.timerStartedAt).getTime(),
    // New authoritative timer fields
    phaseEndsAtMs: effectiveEndsAtMs,
    phaseDurationSec: effectiveDurationSec,
    serverNowMs: Date.now(),
  };
  
  // Send complete room data with updated game state so client can properly sync UI
  const roomWithGameState = {
    ...refreshedRoom,
    gameState: gameStateWithoutWord,
  };
  
  socket.emit(GameEvent.GAME_STATE, { 
    gameState: gameStateWithoutWord,
    room: roomWithGameState // Include full room data for proper UI sync
  });

  // If we're currently choosing a word and THIS socket is the current chooser, send the
  // CHOOSE_WORD payload (with persisted word choices) so reconnecting chooser still sees options.
  if (
    refreshedRoom.gameState.roomState === RoomState.CHOOSING_WORD &&
    refreshedRoom.gameState.word === ""
  ) {
    // CRITICAL FIX: Validate currentPlayer index before accessing
    if (refreshedRoom.gameState.currentPlayer >= refreshedRoom.players.length) {
      logger.error("currentPlayer index out of bounds in handleInBetweenJoin", {
        roomId: refreshedRoom.roomId,
        currentPlayer: refreshedRoom.gameState.currentPlayer,
        playersLength: refreshedRoom.players.length
      });
    } else {
      const current = refreshedRoom.players[refreshedRoom.gameState.currentPlayer];
      const isChooser = current?.playerId === socket.id;
      const choices = Array.isArray(refreshedRoom.gameState.wordChoices)
        ? refreshedRoom.gameState.wordChoices
        : [];

      if (isChooser && choices.length > 0) {
        socket.emit(GameEvent.CHOOSE_WORD, {
          words: choices,
          phaseDurationSec: effectiveDurationSec,
          phaseEndsAtMs: effectiveEndsAtMs,
          // Backwards-compat fields (will be removed after client migration)
          time: effectiveDurationSec,
          timerStartedAtMs: new Date(refreshedRoom.gameState.timerStartedAt).getTime(),
        });
      } else if (current) {
        socket.emit(GameEvent.CHOOSING_WORD, {
          currentPlayer: current,
          phaseDurationSec: effectiveDurationSec,
          phaseEndsAtMs: effectiveEndsAtMs,
          // Backwards-compat fields (will be removed after client migration)
          time: effectiveDurationSec,
          timerStartedAtMs: new Date(refreshedRoom.gameState.timerStartedAt).getTime(),
        });
      }
    }
  }
  
  logger.info("Player joined game in progress", {
    roomId: refreshedRoom.roomId,
    playerId: socket.id,
    currentRound: refreshedRoom.gameState.currentRound,
    roomState: refreshedRoom.gameState.roomState,
  });
}

export async function handleVoteKick(
  socket: Socket,
  io: Server,
  playerId: string
) {
  const room = await getRoomFromSocket(socket);
  if (!room) return;

  const targetPlayer = room.players.find((e) => e.playerId === playerId);
  if (!targetPlayer) return;

  const initiator = room.players.find((e) => e.playerId === socket.id);
  if (!initiator) return;

  // Check if there's already an active vote kick
  if (room.activeVoteKick) {
    logger.warn("Vote kick already in progress", { roomId: room.roomId });
    return;
  }

  const VOTE_DURATION_MS = 5000; // 5 seconds
  const voteEndsAt = Date.now() + VOTE_DURATION_MS;

  // Initialize new vote kick with initiator's vote as "upvote" (they want to kick)
  room.activeVoteKick = {
    targetPlayerId: playerId,
    initiatorPlayerId: socket.id,
    votes: { [socket.id]: 'upvote' }, // Use Record instead of Map for Redis serialization
    startedAt: Date.now(),
  };

  await setRedisRoom(room.roomId, room);

  // Notify all players about the vote kick with timer info
  io.to(room.roomId).emit(GameEvent.VOTE_KICK_INITIATED, {
    initiatorId: socket.id,
    initiatorName: initiator.name,
    targetId: playerId,
    targetName: targetPlayer.name,
    voteEndsAt, // Send timestamp when voting ends
    voteDurationMs: VOTE_DURATION_MS,
  });

  // Set up 5-second timer to auto-finalize the vote
  const timer = setTimeout(async () => {
    // Fetch the latest room state
    const updatedRoom = await getRedisRoom(room.roomId);
    if (!updatedRoom || !updatedRoom.activeVoteKick) {
      logger.debug("Vote kick already finalized or room deleted", { roomId: room.roomId });
      return;
    }

    // Only finalize if this is still the same vote kick
    if (updatedRoom.activeVoteKick.targetPlayerId === playerId) {
      logger.info("Auto-finalizing vote kick after 5 seconds", {
        roomId: room.roomId,
        target: targetPlayer.name,
        totalVotes: Object.keys(updatedRoom.activeVoteKick.votes).length,
        totalPlayers: updatedRoom.players.length,
      });
      await finalizeVoteKick(updatedRoom, io);
    }

    // Clean up timer
    voteKickTimers.delete(room.roomId);
  }, VOTE_DURATION_MS);

  // Store timer reference
  voteKickTimers.set(room.roomId, timer);

  // Track metrics
  GameMetrics.trackVoteKick();

  logger.info("Vote kick initiated with 5-second timer", {
    roomId: room.roomId,
    initiator: initiator.name,
    target: targetPlayer.name,
    voteEndsAt,
  });
}

export async function handleVoteKickCast(
  socket: Socket,
  io: Server,
  targetPlayerId: string,
  vote: 'upvote' | 'downvote'
) {
  const room = await getRoomFromSocket(socket);
  if (!room) return;

  // Check if there's an active vote
  if (!room.activeVoteKick || room.activeVoteKick.targetPlayerId !== targetPlayerId) {
    logger.warn("No active vote kick for this player", { roomId: room.roomId, targetPlayerId });
    return;
  }

  const voter = room.players.find((e) => e.playerId === socket.id);
  if (!voter) return;

  // Record the vote
  room.activeVoteKick.votes[socket.id] = vote;

  await setRedisRoom(room.roomId, room);

  const totalVotes = Object.keys(room.activeVoteKick.votes).length;

  logger.info("Vote cast", {
    roomId: room.roomId,
    voter: voter.name,
    vote,
    totalVotes,
    totalPlayers: room.players.length,
  });

  // Note: We no longer finalize immediately when all players vote
  // The 5-second timer will handle finalization
}

async function finalizeVoteKick(room: Room, io: Server) {
  if (!room.activeVoteKick) return;

  const { targetPlayerId, votes } = room.activeVoteKick;
  
  // Count votes
  let upvotes = 0;
  let downvotes = 0;
  
  Object.values(votes).forEach((vote) => {
    if (vote === 'upvote') upvotes++;
    else downvotes++;
  });

  const targetPlayer = room.players.find((p) => p.playerId === targetPlayerId);
  const shouldKick = upvotes > downvotes;

  logger.info("Vote kick finalized", {
    roomId: room.roomId,
    target: targetPlayer?.name,
    upvotes,
    downvotes,
    shouldKick,
  });

  // Emit result to chat
  io.to(room.roomId).emit(GameEvent.VOTE_KICK_RESULT, {
    targetName: targetPlayer?.name || "Unknown",
    upvotes,
    downvotes,
    kicked: shouldKick,
  });

  if (shouldKick && targetPlayer) {
    const wasHost = room.creator === targetPlayerId;
    
    // Remove player from room
    room.players = room.players.filter((e) => e.playerId !== targetPlayerId);
    
    // If kicked player was host, transfer host to next player (for both private and public rooms)
    if (wasHost && room.players.length > 0) {
      const { transferHost } = await import("../utils/hostTransfer");
      await transferHost(room, io, targetPlayerId);
      logger.info("Host transferred after kick", {
        roomId: room.roomId,
        oldHost: targetPlayerId,
        newHost: room.creator,
        isPrivate: room.isPrivate
      });
    }
    
    // Clear vote kick data
    room.activeVoteKick = undefined;
    
    await setRedisRoom(room.roomId, room);

    // Notify all players
    io.to(room.roomId).emit(GameEvent.PLAYER_LEFT, targetPlayer);
    io.to(targetPlayerId).emit(GameEvent.KICKED);
    
    // Force disconnect the kicked player from the room
    const kickedSocket = io.sockets.sockets.get(targetPlayerId);
    if (kickedSocket) {
      kickedSocket.leave(room.roomId);
    }
    
    // Track player kicked
    GameMetrics.trackPlayerKicked();
  } else {
    // Clear vote kick data - player stays
    room.activeVoteKick = undefined;
    await setRedisRoom(room.roomId, room);
  }
}
