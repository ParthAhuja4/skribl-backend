import { Languages, Settings } from "./types";

export const WORDCHOOSE_TIME = 30;
export const END_ROUND_TIME = 5;
export const WINNER_SHOW_TIME = 10;

// New progressive scoring system
export const DRAWER_POINTS = 200;
export const BONUS_PER_GUESS = 15;

// Guesser scoring constants
export const GUESSER_BASE_POINTS = 500;
export const GUESSER_MIN_POINTS = 25;

// Progressive time penalty tiers (points reduced per second)
export const SCORE_TIER_1_END = 30;  // 0-30 seconds
export const SCORE_TIER_1_PENALTY = 5;

export const SCORE_TIER_2_END = 60;  // 30-60 seconds
export const SCORE_TIER_2_PENALTY = 10;

export const SCORE_TIER_3_END = 90;  // 60-90 seconds
export const SCORE_TIER_3_PENALTY = 15;

export const SCORE_TIER_4_PENALTY = 20; // After 90 seconds

export const INITIAL_HINTS_TIME = 30;
export const HINTS_TIME = 10;

export const DEFAULT_GAME_SETTINGS: Settings = {
  players: 8,
  rounds: 5,        // Changed from 1 to 5
  drawTime: 60,
  customWords: [],
  onlyCustomWords: false,
  language: Languages.en,
  wordCount: 3,     // Minimum 3 words for guessing
  hints: 2,         // Show hints up to 2 letters
};
