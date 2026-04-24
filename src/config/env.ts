import { configDotenv } from "dotenv";
import { z } from "zod";

configDotenv();

// Environment variable schema
const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  PORT: z.string().default("8000").transform(Number),

  // Redis
  REDIS_URL: z.string().url("Invalid Redis URL"),
  REDIS_PASSWORD: z.string().optional(),
  REDIS_DB: z.string().default("0").transform(Number),

  // CORS
  // CLIENT_URL: Primary client URL for development
  CLIENT_URL: z.string().url().default("http://localhost:5173"),

  // ALLOWED_ORIGINS: Comma-separated list of allowed origins for CORS
  // Set this in production via environment variable
  // Example: ALLOWED_ORIGINS="https://skribl.vercel.app,https://skrible.vercel.app"
  // Use "*" to allow all origins (not recommended for production)
  ALLOWED_ORIGINS: z
    .string()
    .default("http://localhost:5173")
    .transform((val) => {
      // If running in production and still has default, add production URLs
      if (
        process.env.NODE_ENV === "production" &&
        val === "http://localhost:5173"
      ) {
        return "http://localhost:5173,https://parth-skribl.vercel.app,https://parth-skribl.vercel.app";
      }
      return val;
    }),

  // Security
  RATE_LIMIT_WINDOW_MS: z.string().default("60000").transform(Number),
  RATE_LIMIT_MAX_REQUESTS: z.string().default("100").transform(Number),
  MAX_PLAYERS_PER_ROOM: z.string().default("8").transform(Number),
  MAX_CUSTOM_WORDS: z.string().default("100").transform(Number),
  MAX_WORD_LENGTH: z.string().default("50").transform(Number),

  // Game
  ROOM_TTL_SECONDS: z.string().default("3600").transform(Number), // Room expiration in seconds (1 hour)
  MAX_NAME_LENGTH: z.string().default("20").transform(Number),
  MIN_NAME_LENGTH: z.string().default("1").transform(Number),

  // AFK/Idle Detection
  AFK_TIMEOUT_SECONDS: z.string().default("300").transform(Number), // Kick idle players after 5 minutes (lobby only)
  AFK_CHECK_INTERVAL_SECONDS: z.string().default("60").transform(Number), // Check for AFK players every minute

  // Reconnection
  // ✅ CRITICAL FIX: Reduced from 25s/15s to 10s/5s for faster game recovery
  // Old values caused games to be stuck for too long waiting for disconnected players
  RECONNECTION_TTL_SECONDS: z.string().default("10").transform(Number), // Redis TTL for reconnection data (must be > RECONNECTION_TIMEOUT + cleanup interval)
  RECONNECTION_TIMEOUT_SECONDS: z.string().default("5").transform(Number), // How long to wait before kicking disconnected player (reduced from 15s)

  // Monitoring
  SENTRY_DSN: z.string().optional(),
  LOG_LEVEL: z.enum(["error", "warn", "info", "debug"]).default("info"),
});

// Validate and export config
function validateEnv() {
  try {
    const parsed = envSchema.parse(process.env);
    return parsed;
  } catch (error) {
    console.error("❌ Invalid environment variables:");
    if (error instanceof z.ZodError) {
      error.issues.forEach((err) => {
        console.error(`  - ${err.path.join(".")}: ${err.message}`);
      });
    }
    process.exit(1);
  }
}

export const config = validateEnv();

// Helper to get allowed origins as array
export const getAllowedOrigins = (): string[] => {
  const origins = config.ALLOWED_ORIGINS.split(",").map((origin) =>
    origin.trim(),
  );

  // Log allowed origins in development for debugging
  if (config.NODE_ENV === "development") {
    console.log("📋 Allowed CORS origins:", origins);
  }

  return origins;
};

// Helper to check if origin is allowed
export const isOriginAllowed = (origin: string | undefined): boolean => {
  if (!origin) return true; // Allow requests with no origin (mobile apps, curl, etc.)

  const allowedOrigins = getAllowedOrigins();

  // Check for wildcard
  if (allowedOrigins.includes("*")) return true;

  // Check for exact match
  return allowedOrigins.includes(origin);
};

// Export for easy access
export default config;
