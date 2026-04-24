import winston from "winston";
import { config } from "./env";
import fs from "fs";
import path from "path";

// Define log format
const logFormat = winston.format.combine(
  winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.json()
);

// Create console format for development
const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: "HH:mm:ss" }),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    let metaStr = "";
    if (Object.keys(meta).length > 0) {
      metaStr = `\n${JSON.stringify(meta, null, 2)}`;
    }
    return `[${timestamp}] ${level}: ${message}${metaStr}`;
  })
);

// Determine if we can write to logs directory
let canWriteLogs = false;
let logsDir = path.join(__dirname, "../../logs");

// In Cloud Run, use /tmp for file logs if needed
if (config.NODE_ENV === "production") {
  logsDir = "/tmp/logs";
}

try {
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }
  // Test if we can write to the directory
  const testFile = path.join(logsDir, ".write-test");
  fs.writeFileSync(testFile, "test");
  fs.unlinkSync(testFile);
  canWriteLogs = true;
} catch (error) {
  console.warn("Cannot write to logs directory, using console only:", error);
  canWriteLogs = false;
}

// Build transports array
const transports: winston.transport[] = [
  // Always write to console (Cloud Run captures this)
  new winston.transports.Console({
    format: config.NODE_ENV === "development" ? consoleFormat : logFormat,
  }),
];

// Only add file transports if we can write logs
if (canWriteLogs) {
  transports.push(
    new winston.transports.File({
      filename: path.join(logsDir, "error.log"),
      level: "error",
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    }),
    new winston.transports.File({
      filename: path.join(logsDir, "combined.log"),
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    })
  );
}

// Exception handlers
const exceptionHandlers: winston.transport[] = [
  new winston.transports.Console(),
];

const rejectionHandlers: winston.transport[] = [
  new winston.transports.Console(),
];

if (canWriteLogs) {
  exceptionHandlers.push(
    new winston.transports.File({ filename: path.join(logsDir, "exceptions.log") })
  );
  rejectionHandlers.push(
    new winston.transports.File({ filename: path.join(logsDir, "rejections.log") })
  );
}

// Create logger instance
export const logger = winston.createLogger({
  level: config.LOG_LEVEL,
  format: logFormat,
  defaultMeta: { service: "sync-draw-guess-server" },
  transports,
  exceptionHandlers,
  rejectionHandlers,
});

export default logger;

