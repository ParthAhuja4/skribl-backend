import cluster from "cluster";
import os from "os";
import { logger } from "./config/logger";

const numCPUs = os.cpus().length;

if (cluster.isPrimary) {
  logger.info(`Primary process ${process.pid} is running`);
  logger.info(`Starting ${numCPUs} worker processes...`);

  // Fork workers
  for (let i = 0; i < numCPUs; i++) {
    cluster.fork();
  }

  cluster.on("exit", (worker, code, signal) => {
    logger.warn(`Worker ${worker.process.pid} died (${signal || code}). Restarting...`);
    cluster.fork();
  });

  cluster.on("online", (worker) => {
    logger.info(`Worker ${worker.process.pid} is online`);
  });
} else {
  // Worker processes: Import and run the server
  require("./server");
  logger.info(`Worker ${process.pid} started`);
}

