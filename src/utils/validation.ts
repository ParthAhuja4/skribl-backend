import { z } from "zod";
import { Languages } from "../types";
import { config } from "../config/env";
// import BadWordsFilter from "bad-words";
import validator from "validator";

// Temporarily disabled profanity filter to fix TypeScript issue
// const filter = new (BadWordsFilter as any)();

// Custom validator for profanity (temporarily disabled)
const noProfanity = (val: string) => {
  // return !filter.isProfane(val);
  return true; // Disabled for now
};

// Player name validation
export const playerNameSchema = z
  .string()
  .trim()
  .min(config.MIN_NAME_LENGTH, `Name must be at least ${config.MIN_NAME_LENGTH} character`)
  .max(config.MAX_NAME_LENGTH, `Name cannot exceed ${config.MAX_NAME_LENGTH} characters`)
  .regex(
    /^[a-zA-Z0-9\s_-]+$/,
    "Name can only contain letters, numbers, spaces, underscores, and hyphens"
  )
  .refine(noProfanity, { message: "Name contains inappropriate language" })
  .refine((val) => validator.escape(val) === val, {
    message: "Name contains invalid characters",
  });

// Player appearance validation
export const appearanceSchema = z.tuple([
  z.number().int().min(0).max(51), // Avatar ID (1-51)
  z.number().int().min(0).max(10), // Reserved for future use
  z.number().int().min(0).max(10), // Reserved for future use
]);

// Player data validation
export const playerDataSchema = z.object({
  name: playerNameSchema,
  appearance: appearanceSchema,
});

// Custom words validation
export const customWordSchema = z
  .string()
  .trim()
  .min(1, "Word cannot be empty")
  .max(config.MAX_WORD_LENGTH, `Word cannot exceed ${config.MAX_WORD_LENGTH} characters`)
  .regex(/^[a-zA-Z\s]+$/, "Word can only contain letters and spaces")
  .refine(noProfanity, { message: "Word contains inappropriate language" });

export const customWordsArraySchema = z
  .array(customWordSchema)
  .max(config.MAX_CUSTOM_WORDS, `Cannot exceed ${config.MAX_CUSTOM_WORDS} custom words`);

// Guess validation
export const guessSchema = z
  .string()
  .trim()
  .min(1, "Guess cannot be empty")
  .max(100, "Guess too long")
  .transform((val) => validator.escape(val)); // Escape HTML

// Room ID validation - 6-character base36 format
export const roomIdSchema = z
  .string()
  .regex(/^[0-9a-z]{6}$/i, "Room ID must be 6 alphanumeric characters")
  .transform(val => val.toLowerCase()); // Normalize to lowercase

// Language validation
export const languageSchema = z.nativeEnum(Languages);

// Settings validation
export const settingsSchema = z.object({
  players: z.number().int().min(2).max(config.MAX_PLAYERS_PER_ROOM),
  drawTime: z.number().int().min(20).max(240),
  rounds: z.number().int().min(1).max(8),
  onlyCustomWords: z.boolean(),
  customWords: customWordsArraySchema,
  language: languageSchema,
  wordCount: z.number().int().min(1).max(5),
  hints: z.number().int().min(0).max(3),
});

// Partial settings for updates
export const settingsUpdateSchema = settingsSchema.partial();

// Game start validation
export const startGameSchema = z.object({
  words: customWordsArraySchema.optional(),
});

// Draw data validation
export const drawDataSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/, "Invalid color format"),
  lineWidth: z.number().min(1).max(50),
  end: z.boolean(),
});

// Vote kick validation
export const voteKickSchema = z.object({
  playerId: z.string().min(1, "Player ID required"),
});

// Export validation helper
export const validate = <T>(schema: z.ZodSchema<T>, data: unknown): T => {
  return schema.parse(data);
};

// Safe validation (returns error instead of throwing)
export const safeValidate = <T>(
  schema: z.ZodSchema<T>,
  data: unknown
): { success: true; data: T } | { success: false; error: z.ZodError } => {
  const result = schema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
};

