// Test setup file
import { configDotenv } from 'dotenv';

// Load test environment variables
configDotenv({ path: '.env.test' });

// Set test environment
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
process.env.LOG_LEVEL = 'error'; // Reduce log noise during tests

// Global test timeout
jest.setTimeout(10000);

// Clean up after all tests
afterAll(async () => {
  // Close all Redis connections
  const { redisClient } = await import('../utils/redis');
  if (redisClient.status === 'ready' || redisClient.status === 'connecting') {
    await redisClient.quit();
  }
  
  // Small delay to ensure everything closes
  await new Promise(resolve => setTimeout(resolve, 500));
});

