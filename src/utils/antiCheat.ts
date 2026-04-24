import { Socket } from "socket.io";
import { logger } from "../config/logger";
import { GameMetrics } from "./metrics";

/**
 * Anti-cheat and abuse detection utilities
 */

interface PlayerBehavior {
  drawActions: number[];
  guesses: number[];
  correctGuesses: number;
  totalGuesses: number;
  roomJoins: number[];
  disconnects: number;
  lastWarning?: number;
}

const playerBehaviors = new Map<string, PlayerBehavior>();
const suspiciousPlayers = new Set<string>();
const bannedIPs = new Set<string>();

// Thresholds
const MAX_DRAW_ACTIONS_PER_SECOND = 50;
const MAX_GUESSES_PER_MINUTE = 30;
// ✅ CRITICAL FIX: Increased from 10 to 30 to allow multiple players joining same room
// Old value of 10 was blocking legitimate joins when 5-6 players joined simultaneously
const MAX_ROOM_JOINS_PER_MINUTE = 30; // Increased to handle burst joins
const SUSPICIOUS_CORRECT_GUESS_RATIO = 0.9; // 90% correct is suspicious
const MIN_GUESSES_FOR_RATIO_CHECK = 10;

/**
 * Track player behavior
 */
export class AntiCheat {
  /**
   * Track draw action
   */
  static trackDrawAction(socketId: string): boolean {
    const behavior = this.getBehavior(socketId);
    const now = Date.now();

    // Add to recent actions
    behavior.drawActions.push(now);

    // Keep only last 2 seconds of actions
    behavior.drawActions = behavior.drawActions.filter(
      (time) => now - time < 2000
    );

    // Check for spam
    if (behavior.drawActions.length > MAX_DRAW_ACTIONS_PER_SECOND * 2) {
      this.flagSuspicious(socketId, "Excessive draw actions");
      return false;
    }

    return true;
  }

  /**
   * Track guess
   */
  static trackGuess(socketId: string, correct: boolean): boolean {
    const behavior = this.getBehavior(socketId);
    const now = Date.now();

    behavior.guesses.push(now);
    behavior.totalGuesses++;
    if (correct) {
      behavior.correctGuesses++;
    }

    // Keep only last minute of guesses
    behavior.guesses = behavior.guesses.filter((time) => now - time < 60000);

    // Check for guess spam
    if (behavior.guesses.length > MAX_GUESSES_PER_MINUTE) {
      this.flagSuspicious(socketId, "Excessive guesses");
      return false;
    }

    // Check for suspiciously high correct guess ratio (possible bot/cheat)
    if (behavior.totalGuesses >= MIN_GUESSES_FOR_RATIO_CHECK) {
      const ratio = behavior.correctGuesses / behavior.totalGuesses;
      if (ratio > SUSPICIOUS_CORRECT_GUESS_RATIO) {
        this.flagSuspicious(
          socketId,
          `Suspicious correct guess ratio: ${(ratio * 100).toFixed(1)}%`
        );
      }
    }

    return true;
  }

  /**
   * Track room join
   */
  static trackRoomJoin(socketId: string): boolean {
    const behavior = this.getBehavior(socketId);
    const now = Date.now();

    behavior.roomJoins.push(now);

    // Keep only last minute
    behavior.roomJoins = behavior.roomJoins.filter(
      (time) => now - time < 60000
    );

    // Check for room join spam
    if (behavior.roomJoins.length > MAX_ROOM_JOINS_PER_MINUTE) {
      this.flagSuspicious(socketId, "Excessive room joins");
      return false;
    }

    return true;
  }

  /**
   * Track disconnect
   */
  static trackDisconnect(socketId: string): void {
    const behavior = this.getBehavior(socketId);
    behavior.disconnects++;

    // If player disconnects too frequently, flag as suspicious
    if (behavior.disconnects > 10) {
      this.flagSuspicious(socketId, "Frequent disconnects");
    }
  }

  /**
   * Check if player is suspicious
   */
  static isSuspicious(socketId: string): boolean {
    return suspiciousPlayers.has(socketId);
  }

  /**
   * Check if IP is banned
   */
  static isIPBanned(ip: string): boolean {
    return bannedIPs.has(ip);
  }

  /**
   * Ban IP address
   */
  static banIP(ip: string, reason: string): void {
    bannedIPs.add(ip);
    logger.warn("IP banned", { ip, reason });
    // GameMetrics.incrementCounter("players_banned"); // Temporarily disabled
  }

  /**
   * Unban IP address
   */
  static unbanIP(ip: string): void {
    bannedIPs.delete(ip);
    logger.info("IP unbanned", { ip });
  }

  /**
   * Get list of banned IPs
   */
  static getBannedIPs(): string[] {
    return Array.from(bannedIPs);
  }

  /**
   * Clear player behavior data (on disconnect)
   */
  static clearBehavior(socketId: string): void {
    playerBehaviors.delete(socketId);
    suspiciousPlayers.delete(socketId);
  }

  /**
   * Get player behavior
   */
  private static getBehavior(socketId: string): PlayerBehavior {
    if (!playerBehaviors.has(socketId)) {
      playerBehaviors.set(socketId, {
        drawActions: [],
        guesses: [],
        correctGuesses: 0,
        totalGuesses: 0,
        roomJoins: [],
        disconnects: 0,
      });
    }
    return playerBehaviors.get(socketId)!;
  }

  /**
   * Flag player as suspicious
   */
  private static flagSuspicious(socketId: string, reason: string): void {
    const behavior = this.getBehavior(socketId);
    const now = Date.now();

    // Don't spam warnings
    if (behavior.lastWarning && now - behavior.lastWarning < 60000) {
      return;
    }

    behavior.lastWarning = now;
    suspiciousPlayers.add(socketId);

    logger.warn("Suspicious player activity", { socketId, reason });
    // GameMetrics.incrementCounter("suspicious_activities"); // Temporarily disabled
  }

  /**
   * Validate drawing data for suspicious patterns
   */
  static validateDrawData(data: any): boolean {
    // Check for impossible coordinates
    if (
      !Number.isFinite(data.x) ||
      !Number.isFinite(data.y) ||
      Math.abs(data.x) > 10000 ||
      Math.abs(data.y) > 10000
    ) {
      return false;
    }

    // Check for invalid line width
    if (data.lineWidth < 1 || data.lineWidth > 50) {
      return false;
    }

    // Check for valid color format
    if (!/^#[0-9A-Fa-f]{6}$/.test(data.color)) {
      return false;
    }

    return true;
  }

  /**
   * Detect rapid-fire drawing (possible bot)
   */
  static detectRapidDrawing(socketId: string): boolean {
    const behavior = this.getBehavior(socketId);
    if (behavior.drawActions.length < 10) return false;

    // Check if all recent actions are within a very short time (< 10ms apart)
    const recentActions = behavior.drawActions.slice(-10);
    const intervals: number[] = [];

    for (let i = 1; i < recentActions.length; i++) {
      intervals.push(recentActions[i] - recentActions[i - 1]);
    }

    const avgInterval =
      intervals.reduce((a, b) => a + b, 0) / intervals.length;

    // If average interval is less than 10ms, it's likely a bot
    if (avgInterval < 10) {
      this.flagSuspicious(socketId, "Rapid-fire drawing detected");
      return true;
    }

    return false;
  }

  /**
   * Get statistics
   */
  static getStats(): {
    totalPlayers: number;
    suspiciousPlayers: number;
    bannedIPs: number;
  } {
    return {
      totalPlayers: playerBehaviors.size,
      suspiciousPlayers: suspiciousPlayers.size,
      bannedIPs: bannedIPs.size,
    };
  }
}

// Cleanup old behavior data periodically
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;

  for (const [socketId, behavior] of playerBehaviors.entries()) {
    // If no recent activity in last 30 minutes, clean up
    const lastActivity = Math.max(
      behavior.drawActions[behavior.drawActions.length - 1] || 0,
      behavior.guesses[behavior.guesses.length - 1] || 0,
      behavior.roomJoins[behavior.roomJoins.length - 1] || 0
    );

    if (now - lastActivity > 30 * 60 * 1000) {
      playerBehaviors.delete(socketId);
      suspiciousPlayers.delete(socketId);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    logger.debug("Anti-cheat cleanup", { cleaned });
  }
}, 5 * 60 * 1000); // Clean every 5 minutes

export default AntiCheat;

