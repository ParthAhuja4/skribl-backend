import request from 'supertest';
import express from 'express';
import { setupAdminRoutes } from '../routes/admin';
import { Server } from 'socket.io';

// Mock Socket.IO
const mockIo = {
  fetchSockets: jest.fn().mockResolvedValue([]),
  emit: jest.fn(),
  to: jest.fn().mockReturnThis(),
} as unknown as Server;

describe('Admin API', () => {
  let app: express.Application;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/api/admin', setupAdminRoutes(app, mockIo));
  });

  describe('GET /api/admin', () => {
    it('should return API information', async () => {
      const response = await request(app)
        .get('/api/admin')
        .expect(200);

      expect(response.body).toHaveProperty('message');
      expect(response.body).toHaveProperty('endpoints');
      expect(Array.isArray(response.body.endpoints)).toBe(true);
    });
  });

  describe('Admin authentication', () => {
    it('should require API key for protected routes', async () => {
      await request(app)
        .get('/api/admin/stats')
        .expect(403);
    });

    it('should accept valid API key', async () => {
      process.env.ADMIN_API_KEY = 'test-key';

      await request(app)
        .get('/api/admin/stats')
        .set('x-api-key', 'test-key')
        .expect(200);

      delete process.env.ADMIN_API_KEY;
    });
  });
});

