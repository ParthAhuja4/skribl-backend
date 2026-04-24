import express from "express";
import http from "http";
import cors from "cors";
import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { createClient } from "redis";
import forge from "node-forge";
import { setupSocket } from "./socket/socketHandlers";
import { setupCommandLine } from "./utils/commandline";
import { config, getAllowedOrigins } from "./config/env";
import { setupAdminRoutes } from "./routes/admin";
import { setupWordsRoutes } from "./routes/words";
import { logger } from "./config/logger";
import {
  startReconnectionCleanup,
  stopReconnectionCleanup,
} from "./utils/reconnectionCleanup";
import { startAfkCleanup, stopAfkCleanup } from "./utils/afkCleanup";
import {
  startRedisHealthMonitoring,
  stopRedisHealthMonitoring,
  getHealthHistory,
  getHealthStats,
} from "./utils/redisMonitoring";

const app = express();
const server = http.createServer(app);

// CORS configuration with environment whitelist
const allowedOrigins = getAllowedOrigins();
logger.info("CORS allowed origins", { origins: allowedOrigins });

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile apps, curl, Postman)
      if (!origin) return callback(null, true);

      // Allow ngrok, cloudflare and other tunneling services in development
      if (config.NODE_ENV === "development") {
        if (
          origin.includes(".ngrok") ||
          origin.includes(".loca.lt") ||
          origin.includes(".localhost.run") ||
          origin.includes(".trycloudflare.com")
        ) {
          return callback(null, true);
        }
      }

      if (allowedOrigins.includes(origin) || allowedOrigins.includes("*")) {
        callback(null, true);
      } else {
        logger.warn("CORS blocked request", { origin, allowedOrigins });
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);

app.use(express.json({ limit: "10kb" })); // Limit JSON body size to 10KB
app.use(express.urlencoded({ extended: true, limit: "10kb" })); // Limit URL-encoded data

// Comprehensive health check endpoint for Cloud Run and monitoring
app.get("/health", async (req, res) => {
  try {
    const { getRedisHealth } = await import("./utils/redis");
    const redisHealth = await getRedisHealth();

    // Determine overall health status
    const isHealthy = redisHealth.ready || redisHealth.mode === "in-memory";
    const statusCode = isHealthy ? 200 : 503;

    // Calculate memory usage
    const memUsage = process.memoryUsage();

    const healthStatus = {
      status: isHealthy ? "healthy" : "degraded",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),

      // Redis health
      redis: redisHealth,

      // Process health
      process: {
        pid: process.pid,
        memory: {
          rss: `${Math.round(memUsage.rss / 1024 / 1024)}MB`,
          heapUsed: `${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`,
          heapTotal: `${Math.round(memUsage.heapTotal / 1024 / 1024)}MB`,
          external: `${Math.round(memUsage.external / 1024 / 1024)}MB`,
        },
        cpu: process.cpuUsage(),
      },

      // Configuration
      config: {
        nodeEnv: config.NODE_ENV,
        reconnection: {
          timeoutSeconds: config.RECONNECTION_TIMEOUT_SECONDS,
          ttlSeconds: config.RECONNECTION_TTL_SECONDS,
        },
        afk: {
          timeoutSeconds: config.AFK_TIMEOUT_SECONDS,
          checkIntervalSeconds: config.AFK_CHECK_INTERVAL_SECONDS,
        },
        room: {
          ttlSeconds: config.ROOM_TTL_SECONDS,
          maxPlayersPerRoom: config.MAX_PLAYERS_PER_ROOM,
        },
      },

      // Version info
      version: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
      },
    };

    res.status(statusCode).json(healthStatus);
  } catch (error) {
    logger.error("Health check failed", { error });
    res.status(503).json({
      status: "error",
      timestamp: new Date().toISOString(),
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

// Root endpoint
app.get("/", (req, res) => {
  res.json({
    message: "skribl Server",
    version: "1.0.0",
    status: "running",
  });
});

// Liveness probe - simple check that server is running
// Used by Cloud Run / Kubernetes to restart unhealthy instances
app.get("/health/live", (req, res) => {
  res.status(200).json({
    status: "alive",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// Readiness probe - check if server can handle requests
// Used by Cloud Run / Kubernetes to route traffic
app.get("/health/ready", async (req, res) => {
  try {
    const { getRedisHealth } = await import("./utils/redis");
    const redisHealth = await getRedisHealth();

    // Server is ready if Redis is connected OR in-memory fallback is working
    const isReady = redisHealth.ready || redisHealth.mode === "in-memory";

    if (isReady) {
      res.status(200).json({
        status: "ready",
        timestamp: new Date().toISOString(),
        redis: {
          mode: redisHealth.mode,
          ready: redisHealth.ready,
        },
      });
    } else {
      res.status(503).json({
        status: "not-ready",
        timestamp: new Date().toISOString(),
        reason: "Redis unavailable and in-memory fallback not ready",
        redis: {
          mode: redisHealth.mode,
          ready: redisHealth.ready,
          lastError: redisHealth.lastError,
        },
      });
    }
  } catch (error) {
    logger.error("Readiness check failed", { error });
    res.status(503).json({
      status: "not-ready",
      timestamp: new Date().toISOString(),
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

// Redis-specific health check endpoint
app.get("/health/redis", async (req, res) => {
  try {
    const { getRedisHealth } = await import("./utils/redis");
    const redisHealth = await getRedisHealth();

    const statusCode = redisHealth.ready ? 200 : 503;

    res.status(statusCode).json({
      status: redisHealth.ready ? "healthy" : "unhealthy",
      timestamp: new Date().toISOString(),
      details: redisHealth,
    });
  } catch (error) {
    logger.error("Redis health check failed", { error });
    res.status(503).json({
      status: "error",
      timestamp: new Date().toISOString(),
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

// Redis health history endpoint
app.get("/health/redis/history", (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 20;
    const history = getHealthHistory(Math.min(limit, 100)); // Cap at 100

    res.status(200).json({
      status: "ok",
      timestamp: new Date().toISOString(),
      history,
      count: history.length,
    });
  } catch (error) {
    logger.error("Failed to get Redis health history", { error });
    res.status(500).json({
      status: "error",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

// Redis health statistics endpoint
app.get("/health/redis/stats", (req, res) => {
  try {
    const stats = getHealthStats();

    res.status(200).json({
      status: "ok",
      timestamp: new Date().toISOString(),
      stats,
    });
  } catch (error) {
    logger.error("Failed to get Redis health stats", { error });
    res.status(500).json({
      status: "error",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

// Audio API proxy endpoint to avoid CORS issues (autocomplete - quick search)
app.get("/api/audio/search", async (req, res) => {
  try {
    const { query } = req.query;

    if (!query || typeof query !== "string") {
      return res.status(400).json({ error: "Query parameter is required" });
    }

    const jiosaavnUrl = `https://www.jiosaavn.com/api.php?__call=autocomplete.get&_format=json&_marker=0&cc=in&includeMetaTags=1&query=${encodeURIComponent(query)}`;

    logger.info("Proxying music search request", { query, url: jiosaavnUrl });

    const response = await fetch(jiosaavnUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Accept: "application/json",
        Referer: "https://www.jiosaavn.com/",
      },
    });

    if (!response.ok) {
      throw new Error(`JioSaavn API returned ${response.status}`);
    }

    const data = await response.json();
    res.json(data);
  } catch (error) {
    logger.error("Error proxying music search", { error });
    res.status(500).json({
      error: "Failed to fetch music search results",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

// Full search endpoint using search.getResults (returns encrypted_media_url for full songs)
app.get("/api/audio/search/full", async (req, res) => {
  try {
    const { query, page = "0", limit = "10" } = req.query;

    if (!query || typeof query !== "string") {
      return res.status(400).json({ error: "Query parameter is required" });
    }

    // Use search.getResults endpoint for full search results (returns encrypted_media_url)
    const jiosaavnUrl = `https://www.jiosaavn.com/api.php?__call=search.getResults&_format=json&_marker=0&api_version=4&ctx=web6dot0&n=${limit}&p=${page}&q=${encodeURIComponent(query)}`;

    logger.info("Proxying full music search request", {
      query,
      url: jiosaavnUrl,
    });

    const response = await fetch(jiosaavnUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Accept: "application/json",
        Referer: "https://www.jiosaavn.com/",
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`JioSaavn API returned ${response.status}`);
    }

    const data = await response.json();
    res.json(data);
  } catch (error) {
    logger.error("Error proxying full music search", { error });
    res.status(500).json({
      error: "Failed to fetch full music search results",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

// Audio song details proxy endpoint
app.get("/api/audio/song/:songId", async (req, res) => {
  try {
    const { songId } = req.params;

    if (!songId) {
      return res.status(400).json({ error: "Song ID is required" });
    }

    const jiosaavnUrl = `https://www.jiosaavn.com/api.php?__call=song.getDetails&cc=in&_marker=0%3F_marker%3D0&_format=json&pids=${songId}`;

    logger.info("Proxying song details request", { songId, url: jiosaavnUrl });

    const response = await fetch(jiosaavnUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Accept: "application/json",
        Referer: "https://www.jiosaavn.com/",
      },
    });

    if (!response.ok) {
      throw new Error(`JioSaavn API returned ${response.status}`);
    }

    const data = await response.json();
    res.json(data);
  } catch (error) {
    logger.error("Error proxying song details", { error });
    res.status(500).json({
      error: "Failed to fetch song details",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

// Audio decryption endpoint to get full song URLs from encrypted_media_url
app.post("/api/audio/decrypt", async (req, res) => {
  try {
    const { encryptedMediaUrl } = req.body;

    if (!encryptedMediaUrl || typeof encryptedMediaUrl !== "string") {
      return res.status(400).json({ error: "encryptedMediaUrl is required" });
    }

    logger.info("Decrypting media URL");

    // Decrypt using JioSaavn's DES-ECB algorithm
    const qualities = [
      { id: "_12", bitrate: "12kbps" },
      { id: "_48", bitrate: "48kbps" },
      { id: "_96", bitrate: "96kbps" },
      { id: "_160", bitrate: "160kbps" },
      { id: "_320", bitrate: "320kbps" },
    ];

    const key = "38346591";
    const iv = "00000000";

    try {
      const encrypted = forge.util.decode64(encryptedMediaUrl);
      const decipher = forge.cipher.createDecipher(
        "DES-ECB",
        forge.util.createBuffer(key),
      );
      decipher.start({ iv: forge.util.createBuffer(iv) });
      decipher.update(forge.util.createBuffer(encrypted));
      decipher.finish();
      const decryptedLink = decipher.output.getBytes();

      const downloadUrls = qualities.map((quality) => ({
        quality: quality.bitrate,
        url: decryptedLink.replace("_96", quality.id),
      }));

      res.json({ success: true, data: downloadUrls });
    } catch (decryptError) {
      logger.error("Error decrypting media URL", { error: decryptError });
      res.status(500).json({
        error: "Failed to decrypt media URL",
        message:
          decryptError instanceof Error
            ? decryptError.message
            : "Unknown error",
      });
    }
  } catch (error) {
    logger.error("Error in decrypt endpoint", { error });
    res.status(500).json({
      error: "Failed to process decrypt request",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

// Audio stream proxy endpoint to avoid CORS issues
app.get("/api/audio/stream", async (req, res) => {
  try {
    const { url } = req.query;

    if (!url || typeof url !== "string") {
      return res.status(400).json({ error: "URL parameter is required" });
    }

    logger.info("Proxying audio/video stream request", { url });

    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Referer: "https://www.jiosaavn.com/",
        Accept: "audio/mpeg, audio/*, video/*, */*",
      },
    });

    if (!response.ok) {
      logger.error("Failed to fetch media", {
        status: response.status,
        statusText: response.statusText,
        url,
      });
      throw new Error(
        `Failed to fetch media: ${response.status} ${response.statusText}`,
      );
    }

    // Set appropriate headers for audio/video streaming
    const contentType =
      response.headers.get("content-type") ||
      (url.includes(".mp4") ? "video/mp4" : "audio/mpeg");
    const contentLength = response.headers.get("content-length");

    res.setHeader("Content-Type", contentType);
    if (contentLength) {
      res.setHeader("Content-Length", contentLength);
    }
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.setHeader("Access-Control-Allow-Origin", "*");

    // Stream the media data
    const buffer = await response.arrayBuffer();
    res.send(Buffer.from(buffer));
  } catch (error) {
    logger.error("Error proxying audio stream", { error, url: req.query.url });
    res.status(500).json({
      error: "Failed to stream audio",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

const io = new Server(server, {
  cors: {
    origin: (
      origin: string | undefined,
      callback: (err: Error | null, allow?: boolean) => void,
    ) => {
      if (!origin) return callback(null, true);

      // Allow ngrok, cloudflare and other tunneling services in development
      if (config.NODE_ENV === "development") {
        if (
          origin.includes(".ngrok") ||
          origin.includes(".loca.lt") ||
          origin.includes(".localhost.run") ||
          origin.includes(".trycloudflare.com")
        ) {
          return callback(null, true);
        }
      }

      if (allowedOrigins.includes(origin) || allowedOrigins.includes("*")) {
        callback(null, true);
      } else {
        logger.warn("Socket.IO CORS blocked", { origin });
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
    methods: ["GET", "POST"],
  },
  maxHttpBufferSize: 1e6, // 1MB max message size
  // ✅ CRITICAL FIX: Reduced ping timeouts for faster disconnect detection
  // Old: 60s timeout, 25s interval - way too long for production
  // New: 20s timeout, 10s interval - matches MiroTalk and Socket.IO defaults
  pingTimeout: 20000, // 20 seconds (was 60s)
  pingInterval: 10000, // 10 seconds (was 25s)
  // ✅ Transport configuration for better reliability
  transports: ["polling", "websocket"], // Try polling first, then upgrade
  upgradeTimeout: 10000, // 10 second upgrade timeout
  connectTimeout: 45000, // Total connection timeout
});

// Setup Redis Adapter for multi-server support
async function setupRedisAdapter() {
  try {
    const pubClient = createClient({ url: config.REDIS_URL });
    const subClient = pubClient.duplicate();

    await Promise.all([pubClient.connect(), subClient.connect()]);

    io.adapter(createAdapter(pubClient, subClient));

    // Store clients for graceful shutdown
    (io as any).redisPubClient = pubClient;
    (io as any).redisSubClient = subClient;
  } catch (error) {
    logger.error("Failed to initialize Redis adapter", { error });
    logger.warn("Continuing without Redis adapter (single-server mode)");
  }
}

// Initialize Redis adapter
setupRedisAdapter();

// Setup admin routes
setupAdminRoutes(app, io);

// Setup words routes
setupWordsRoutes(app);

setupSocket(io);
setupCommandLine(io);

const PORT = config.PORT;
const HOST = "0.0.0.0";

// Store monitoring interval for cleanup
let redisMonitoringInterval: NodeJS.Timeout;

server.listen(PORT, HOST, function () {
  logger.info(`Server listening on ${HOST}:${PORT}`);
  logger.info("Reconnection configuration", {
    RECONNECTION_TIMEOUT_SECONDS: config.RECONNECTION_TIMEOUT_SECONDS,
    RECONNECTION_TTL_SECONDS: config.RECONNECTION_TTL_SECONDS,
    timeoutMs: config.RECONNECTION_TIMEOUT_SECONDS * 1000,
    ttlMs: config.RECONNECTION_TTL_SECONDS * 1000,
  });
  console.log(`listening on ${HOST}:${PORT}`);
  console.log(
    `📋 Reconnection settings: Timeout=${config.RECONNECTION_TIMEOUT_SECONDS}s, TTL=${config.RECONNECTION_TTL_SECONDS}s`,
  );
  console.log(
    `📋 AFK settings: Timeout=${config.AFK_TIMEOUT_SECONDS}s, Check interval=${config.AFK_CHECK_INTERVAL_SECONDS}s`,
  );

  // Start reconnection cleanup worker (Cloud Run compatible)
  startReconnectionCleanup(io);
  logger.info("🔄 Reconnection cleanup worker started (Cloud Run compatible)");

  // Start AFK cleanup worker
  startAfkCleanup(io);
  logger.info("💤 AFK cleanup worker started");

  // Start Redis health monitoring (check every 30 seconds)
  redisMonitoringInterval = startRedisHealthMonitoring(30000);
  logger.info("🏥 Redis health monitoring started");
});

// Graceful shutdown
async function gracefulShutdown(signal: string) {
  logger.info(`${signal} received, closing server gracefully`);

  try {
    // Stop cleanup workers
    stopReconnectionCleanup();
    logger.info("Reconnection cleanup worker stopped");

    stopAfkCleanup();
    logger.info("AFK cleanup worker stopped");

    // Stop Redis health monitoring
    if (redisMonitoringInterval) {
      stopRedisHealthMonitoring(redisMonitoringInterval);
      logger.info("Redis health monitoring stopped");
    }

    // Close Socket.IO
    io.close(() => {
      logger.info("Socket.IO closed");
    });

    // Close Redis adapter clients
    const redisPubClient = (io as any).redisPubClient;
    const redisSubClient = (io as any).redisSubClient;
    if (redisPubClient && redisSubClient) {
      await Promise.all([redisPubClient.quit(), redisSubClient.quit()]);
      logger.info("Redis adapter clients closed");
    }

    // Close HTTP server
    await new Promise<void>((resolve) => {
      server.close(() => {
        logger.info("HTTP server closed");
        resolve();
      });
    });

    // Close main Redis connection
    const { redisClient } = await import("./utils/redis");
    if (redisClient.status === "ready") {
      await redisClient.quit();
      logger.info("Redis connection closed");
    }

    logger.info("Graceful shutdown complete");
    process.exit(0);
  } catch (error) {
    logger.error("Error during graceful shutdown", { error });
    process.exit(1);
  }
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
