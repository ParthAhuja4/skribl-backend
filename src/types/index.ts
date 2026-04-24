export enum PlayerAppearance {
  BODY = 0,
  EYES,
  MOUTH,
}

export enum RoomState {
  NOT_STARTED = "NOT_STARTED",
  PLAYER_CHOOSE_WORD = "PLAYER_CHOOSE_WORD",
  CHOOSING_WORD = "CHOOSING_WORD",
  DRAWING = "DRAWING",
  GUESSED = "GUESSED",
  TIMEUP = "TIMEUP",
  WINNER = "WINNER",
}

export interface PlayerData {
  name: string;
  appearance: [number, number, number];
}

export type EndTurnData = {
  word: string;
  reason: RounEndReason;
  time: number;
};

export enum RounEndReason {
  ALL_GUESSED = 1,
  TIMEUP,
  LEFT,
}

export interface Player extends PlayerData {
  playerId: string;
  playerToken?: string; // UUID for reliable reconnection detection
  score: number;
  guessed: boolean;
  guessedAt: Date | null;
  lastSeenAt?: Date; // Track last activity for reconnection timeout
}

export interface GameState {
  currentRound: number;
  // Persisted draw events / operations for rehydrating canvas on mid-game join/reconnect.
  // NOTE: Actual payloads vary (draw_batch, dot, fill snapshot, undo/redo snapshot, etc).
  drawingData: any[];
  guessedWords: string[];
  word: string;
  currentPlayer: number;
  hintLetters: GuessedLetters[];
  roomState: RoomState;
  timerStartedAt: Date;
  /**
   * Server-authoritative end timestamp for the current phase (epoch ms).
   * Clients should render countdown from this value using server-time sync.
   */
  phaseEndsAtMs?: number;
  /**
   * Total duration (seconds) for the current phase (useful for progress bars).
   */
  phaseDurationSec?: number;
  /**
   * Word options offered to the current chooser during CHOOSING_WORD.
   * Persisted so reconnecting chooser can still see the options.
   */
  wordChoices?: string[];
  isRoundEnding?: boolean; // Flag to prevent multiple simultaneous round endings
}

export interface GuessedLetters {
  index: number;
  letter: string;
}

export interface Settings {
  players: number;
  drawTime: number;
  rounds: number;
  onlyCustomWords: boolean;
  customWords: string[];
  language: Languages;
  wordCount: number;
  hints: number;
}

export enum SettingValue {
  players = "players",
  drawTime = "drawTime",
  rounds = "rounds",
  onlyCustomWords = "onlyCustomWords",
  customWords = "customWords",
  language = "language",
  wordCount = "wordCount",
  hints = "hints",
}

export interface Room {
  roomId: string; // Unique identifier for the room
  creator: string | null; // Player ID of the creator of the room
  players: Player[]; // List of players in the room
  gameState: GameState; // Current state of the game
  settings: Settings;
  isPrivate: boolean;
  vote_kickers: [string, string[]][]; // Legacy vote kick tracking
  activeVoteKick?: {
    targetPlayerId: string;
    initiatorPlayerId: string;
    votes: Record<string, 'upvote' | 'downvote'>; // Use Record instead of Map for Redis serialization
    startedAt: number;
  };
}

export enum Languages {
  en = "English",
  es = "Spanish",
  fr = "French",
  de = "German",
  it = "Italian",
  nl = "Dutch",
  pt = "Portuguese",
  ru = "Russian",
  tr = "Turkish",
  zh = "Chinese",
}

export enum GameEvent {
  // Client Events
  CONNECT = "connect",
  DISCONNECT = "disconnecting",
  JOIN_ROOM = "joinRoom",
  LEAVE_ROOM = "leaveRoom",
  START_GAME = "startGame",
  DRAW = "draw",
  DRAW_CLEAR = "clear",
  DRAW_UNDO = "undo",
  DRAW_REDO = "redo",
  GUESS = "guess",
  CHANGE_SETTIING = "changeSettings", // Keep typo for backwards compatibility
  CHANGE_SETTING = "changeSettings", // Fixed version
  WORD_SELECT = "wordSelect",
  VOTE_KICK = "voteKick",

  // Server Events
  JOINED_ROOM = "joinedRoom",
  PLAYER_JOINED = "playerJoined",
  PLAYER_LEFT = "playerLeft",
  GAME_STARTED = "gameStarted",
  GAME_ENDED = "gameEnded",
  DRAW_DATA = "drawData",
  CLEAR_DRAW = "clearDraw",
  UNDO_DRAW = "undoDraw",
  REDO_DRAW = "redoDraw",
  GUESSED = "guessed",
  TURN_END = "turnEnded",
  CHOOSE_WORD = "chooseWord",
  CHOOSING_WORD = "choosingWord",
  WORD_CHOSEN = "wordChosen",
  GUESS_WORD_CHOSEN = "guessWordChosen",
  SETTINGS_CHANGED = "settingsChanged",
  GUESS_FAIL = "guessFail",
  GUESS_HINT = "guessHint",
  GAME_STATE = "gameState",
  KICKING_VOTE = "kickVote",
  VOTE_KICK_INITIATED = "voteKickInitiated",
  VOTE_KICK_CAST = "voteKickCast",
  VOTE_KICK_RESULT = "voteKickResult",
  KICKED = "kicked",
  HOST_TRANSFERRED = "hostTransferred",

  // Voice Events
  VOICE_SIGNAL = "voiceSignal",
  VOICE_ADD_PEER = "voiceAddPeer", // Server-determined peer creation
  VOICE_USER_JOINED = "voiceUserJoined",
  VOICE_USER_LEFT = "voiceUserLeft",
  VOICE_USER_MUTED = "voiceUserMuted",
  VOICE_USER_UNMUTED = "voiceUserUnmuted",
}
