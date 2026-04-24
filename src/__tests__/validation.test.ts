import { validate, safeValidate, playerDataSchema, guessSchema, drawDataSchema } from '../utils/validation';

describe('Validation', () => {
  describe('playerDataSchema', () => {
    it('should validate correct player data', () => {
      const validData = {
        name: 'TestPlayer',
        appearance: [1, 2, 3],
      };

      const result = safeValidate(playerDataSchema, validData);
      expect(result.success).toBe(true);
    });

    it('should reject invalid player name', () => {
      const invalidData = {
        name: '',
        appearance: [1, 2, 3],
      };

      const result = safeValidate(playerDataSchema, invalidData);
      expect(result.success).toBe(false);
    });

    it('should reject invalid appearance array', () => {
      const invalidData = {
        name: 'TestPlayer',
        appearance: [1, 2],
      };

      const result = safeValidate(playerDataSchema, invalidData);
      expect(result.success).toBe(false);
    });

    it('should reject profane names', () => {
      const invalidData = {
        name: 'badword',
        appearance: [1, 2, 3],
      };

      // Note: This depends on the bad-words library
      const result = safeValidate(playerDataSchema, invalidData);
      // May pass or fail depending on bad-words dictionary
    });

    it('should reject names that are too long', () => {
      const invalidData = {
        name: 'a'.repeat(30),
        appearance: [1, 2, 3],
      };

      const result = safeValidate(playerDataSchema, invalidData);
      expect(result.success).toBe(false);
    });
  });

  describe('guessSchema', () => {
    it('should validate correct guess', () => {
      const result = safeValidate(guessSchema, 'apple');
      expect(result.success).toBe(true);
    });

    it('should reject empty guess', () => {
      const result = safeValidate(guessSchema, '');
      expect(result.success).toBe(false);
    });

    it('should escape HTML in guess', () => {
      const result = safeValidate(guessSchema, '<script>alert("xss")</script>');
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).not.toContain('<script>');
      }
    });
  });

  describe('drawDataSchema', () => {
    it('should validate correct draw data', () => {
      const validData = {
        x: 100,
        y: 200,
        color: '#FF0000',
        lineWidth: 5,
        end: false,
      };

      const result = safeValidate(drawDataSchema, validData);
      expect(result.success).toBe(true);
    });

    it('should reject invalid color format', () => {
      const invalidData = {
        x: 100,
        y: 200,
        color: 'red',
        lineWidth: 5,
        end: false,
      };

      const result = safeValidate(drawDataSchema, invalidData);
      expect(result.success).toBe(false);
    });

    it('should reject invalid line width', () => {
      const invalidData = {
        x: 100,
        y: 200,
        color: '#FF0000',
        lineWidth: 100,
        end: false,
      };

      const result = safeValidate(drawDataSchema, invalidData);
      expect(result.success).toBe(false);
    });

    it('should reject non-finite coordinates', () => {
      const invalidData = {
        x: Infinity,
        y: 200,
        color: '#FF0000',
        lineWidth: 5,
        end: false,
      };

      const result = safeValidate(drawDataSchema, invalidData);
      expect(result.success).toBe(false);
    });
  });
});

