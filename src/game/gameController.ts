import { Socket } from "socket.io";
import { setRedisRoom } from "../utils/redis";
import {
  Languages,
  Player,
  PlayerData,
  Room,
  RoomState,
  Settings,
} from "../types";
import { getRedisRoom as gR } from "../utils/redis";
import { DEFAULT_GAME_SETTINGS } from "../constants";

// Generate 6-character room ID using base36 (0-9, a-z lowercase)
export function generateRoomId() {
  const chars = '0123456789abcdefghijklmnopqrstuvwxyz';
  let roomId = '';
  
  // Generate 6 random characters
  for (let i = 0; i < 6; i++) {
    const randomIndex = Math.floor(Math.random() * chars.length);
    roomId += chars[randomIndex];
  }
  
  return roomId;
}

// Check if room ID already exists to prevent collisions
export async function generateUniqueRoomId(): Promise<string> {
  const { getRedisRoom } = await import("../utils/redis");
  let roomId = generateRoomId();
  let attempts = 0;
  const maxAttempts = 10;
  
  // Retry if collision detected (extremely rare)
  while (attempts < maxAttempts) {
    const existingRoom = await getRedisRoom(roomId);
    if (!existingRoom) {
      return roomId;
    }
    roomId = generateRoomId();
    attempts++;
  }
  
  // Fallback to timestamp-based if all attempts fail
  return Date.now().toString(36).slice(-6);
}

export async function generateEmptyRoom(
  socket: Socket,
  isPrivate: boolean = false,
  language: Languages = Languages.en
) {
  const roomId = await generateUniqueRoomId();

  const room: Room = {
    roomId,
    // Public rooms should also have a host/creator (matches private room behavior).
    // This enables manual start + host transfer for public rooms as well.
    creator: socket.id,
    players: [],
    gameState: {
      currentRound: 0,
      drawingData: [],
      guessedWords: [],
      word: "",
      currentPlayer: 0,
      hintLetters: [],
      roomState: RoomState.NOT_STARTED,
      timerStartedAt: new Date(),
    },
    settings: { ...DEFAULT_GAME_SETTINGS, language },
    isPrivate,
    vote_kickers: [],
  };

  await setRedisRoom(roomId, room);
  return roomId;
}

export async function getRoomFromSocket(socket: Socket) {
  if (!socket) return null;
  const roomId = Array.from(socket.rooms)[1] as string;
  if (!roomId) return null;
  const room = await gR(roomId);
  return room;
}
