import { Request, Response, NextFunction } from "express";
import { logger } from "../config/logger";

/**
 * Metrics tracking for monitoring
 */
class MetricsCollector {
  private metrics: Map<string, number>;
  private counters: Map<string, number>;
  private histograms: Map<string, number[]>;
  private gauges: Map<string, number>;
  private startTime: number;

  constructor() {
    this.metrics = new Map();
    this.counters = new Map();
    this.histograms = new Map();
    this.gauges = new Map();
    this.startTime = Date.now();
  }

  // Counter: Monotonically increasing value
  incrementCounter(name: string, value: number = 1): void {
    const current = this.counters.get(name) || 0;
    this.counters.set(name, current + value);
  }

  // Gauge: Can go up or down
  setGauge(name: string, value: number): void {
    this.gauges.set(name, value);
  }

  // Histogram: Track distribution of values
  recordHistogram(name: string, value: number): void {
    const values = this.histograms.get(name) || [];
    values.push(value);
    this.histograms.set(name, values);
  }

  // Get counter value
  getCounter(name: string): number {
    return this.counters.get(name) || 0;
  }

  // Get gauge value
  getGauge(name: string): number {
    return this.gauges.get(name) || 0;
  }

  // Get histogram statistics
  getHistogramStats(name: string): {
    count: number;
    sum: number;
    avg: number;
    min: number;
    max: number;
    p50: number;
    p95: number;
    p99: number;
  } | null {
    const values = this.histograms.get(name);
    if (!values || values.length === 0) return null;

    const sorted = [...values].sort((a, b) => a - b);
    const sum = sorted.reduce((acc, val) => acc + val, 0);
    const count = sorted.length;

    return {
      count,
      sum,
      avg: sum / count,
      min: sorted[0],
      max: sorted[count - 1],
      p50: sorted[Math.floor(count * 0.5)],
      p95: sorted[Math.floor(count * 0.95)],
      p99: sorted[Math.floor(count * 0.99)],
    };
  }

  // Get all metrics in Prometheus format
  getPrometheusMetrics(): string {
    let output = "";

    // Counters
    for (const [name, value] of this.counters.entries()) {
      output += `# TYPE ${name} counter\n`;
      output += `${name} ${value}\n\n`;
    }

    // Gauges
    for (const [name, value] of this.gauges.entries()) {
      output += `# TYPE ${name} gauge\n`;
      output += `${name} ${value}\n\n`;
    }

    // Histograms
    for (const [name, values] of this.histograms.entries()) {
      const stats = this.getHistogramStats(name);
      if (stats) {
        output += `# TYPE ${name} histogram\n`;
        output += `${name}_count ${stats.count}\n`;
        output += `${name}_sum ${stats.sum}\n`;
        output += `${name}_bucket{le="0.5"} ${stats.p50}\n`;
        output += `${name}_bucket{le="0.95"} ${stats.p95}\n`;
        output += `${name}_bucket{le="0.99"} ${stats.p99}\n`;
        output += `${name}_bucket{le="+Inf"} ${stats.max}\n\n`;
      }
    }

    // Add uptime
    const uptime = (Date.now() - this.startTime) / 1000;
    output += `# TYPE process_uptime_seconds gauge\n`;
    output += `process_uptime_seconds ${uptime}\n\n`;

    return output;
  }

  // Get all metrics in JSON format
  getMetrics(): {
    counters: Record<string, number>;
    gauges: Record<string, number>;
    histograms: Record<string, any>;
    uptime: number;
  } {
    const counters: Record<string, number> = {};
    const gauges: Record<string, number> = {};
    const histograms: Record<string, any> = {};

    for (const [name, value] of this.counters.entries()) {
      counters[name] = value;
    }

    for (const [name, value] of this.gauges.entries()) {
      gauges[name] = value;
    }

    for (const [name] of this.histograms.entries()) {
      histograms[name] = this.getHistogramStats(name);
    }

    return {
      counters,
      gauges,
      histograms,
      uptime: (Date.now() - this.startTime) / 1000,
    };
  }

  // Reset all metrics
  reset(): void {
    this.counters.clear();
    this.histograms.clear();
    // Don't reset gauges as they represent current state
  }
}

// Singleton instance
export const metrics = new MetricsCollector();

// Middleware to track HTTP requests
export function metricsMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const start = Date.now();

  // Track request
  metrics.incrementCounter("http_requests_total");
  metrics.incrementCounter(`http_requests_${req.method.toLowerCase()}`);

  // Override res.end to capture response time
  const originalEnd = res.end.bind(res);
  res.end = (...args: any[]) => {
    const duration = Date.now() - start;
    metrics.recordHistogram("http_request_duration_ms", duration);
    metrics.incrementCounter(`http_status_${res.statusCode}`);

    if (res.statusCode >= 400) {
      metrics.incrementCounter("http_errors_total");
    }

    return originalEnd(...args);
  };

  next();
}

// Game-specific metrics
export class GameMetrics {
  static trackRoomCreated(isPrivate: boolean): void {
    metrics.incrementCounter("rooms_created_total");
    metrics.incrementCounter(
      isPrivate ? "rooms_private_created" : "rooms_public_created"
    );
  }

  static trackRoomDeleted(): void {
    metrics.incrementCounter("rooms_deleted_total");
  }

  static trackPlayerJoined(): void {
    metrics.incrementCounter("players_joined_total");
  }

  static trackPlayerLeft(): void {
    metrics.incrementCounter("players_left_total");
  }

  static trackGameStarted(): void {
    metrics.incrementCounter("games_started_total");
  }

  static trackGameEnded(duration: number): void {
    metrics.incrementCounter("games_ended_total");
    metrics.recordHistogram("game_duration_seconds", duration);
  }

  static trackRoundCompleted(duration: number): void {
    metrics.incrementCounter("rounds_completed_total");
    metrics.recordHistogram("round_duration_seconds", duration);
  }

  static trackGuess(correct: boolean): void {
    metrics.incrementCounter("guesses_total");
    if (correct) {
      metrics.incrementCounter("guesses_correct");
    } else {
      metrics.incrementCounter("guesses_incorrect");
    }
  }

  static trackDrawAction(): void {
    metrics.incrementCounter("draw_actions_total");
  }

  static trackWordSelected(wordLength: number): void {
    metrics.incrementCounter("words_selected_total");
    metrics.recordHistogram("word_length", wordLength);
  }

  static trackVoteKick(): void {
    metrics.incrementCounter("vote_kicks_total");
  }

  static trackPlayerKicked(): void {
    metrics.incrementCounter("players_kicked_total");
  }

  static setActiveRooms(count: number): void {
    metrics.setGauge("active_rooms", count);
  }

  static setActivePlayers(count: number): void {
    metrics.setGauge("active_players", count);
  }

  static setActiveGames(count: number): void {
    metrics.setGauge("active_games", count);
  }

  static trackError(type: string): void {
    metrics.incrementCounter(`errors_${type}`);
    metrics.incrementCounter("errors_total");
  }

  static trackRateLimitHit(): void {
    metrics.incrementCounter("rate_limit_hits_total");
  }

  static trackValidationError(field: string): void {
    metrics.incrementCounter("validation_errors_total");
    metrics.incrementCounter(`validation_errors_${field}`);
  }
}

export default metrics;

