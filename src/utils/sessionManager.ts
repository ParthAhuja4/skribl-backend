// Multi-device/tab detection and handling

interface ActiveSession {
  socketId: string;
  roomId: string;
  connectedAt: number;
  playerToken: string;
}

const activeSessions = new Map<string, ActiveSession>();

/**
 * Check if player is already connected from another device/tab
 * Returns the existing socket ID if found
 */
export function checkExistingSession(playerToken: string): string | null {
  const session = activeSessions.get(playerToken);
  if (session) {
    return session.socketId;
  }
  return null;
}

/**
 * Register a new active session
 */
export function registerSession(
  playerToken: string,
  socketId: string,
  roomId: string
): void {
  activeSessions.set(playerToken, {
    socketId,
    roomId,
    connectedAt: Date.now(),
    playerToken,
  });
}

/**
 * Remove a session
 */
export function removeSession(playerToken: string): void {
  activeSessions.delete(playerToken);
}

/**
 * Get active session for a player token
 */
export function getActiveSession(playerToken: string): ActiveSession | null {
  return activeSessions.get(playerToken) || null;
}

/**
 * Clear all sessions for cleanup
 */
export function clearAllSessions(): void {
  activeSessions.clear();
}

/**
 * Get session by socket ID
 */
export function getSessionBySocketId(socketId: string): ActiveSession | null {
  for (const session of activeSessions.values()) {
    if (session.socketId === socketId) {
      return session;
    }
  }
  return null;
}



