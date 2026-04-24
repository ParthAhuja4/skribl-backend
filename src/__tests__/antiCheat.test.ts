import { AntiCheat } from '../utils/antiCheat';

describe('AntiCheat', () => {
  beforeEach(() => {
    // Clear behavior data before each test
    AntiCheat.clearBehavior('test-socket-id');
  });

  describe('validateDrawData', () => {
    it('should validate correct draw data', () => {
      const validData = {
        x: 100,
        y: 200,
        color: '#FF0000',
        lineWidth: 5,
        end: false,
      };

      expect(AntiCheat.validateDrawData(validData)).toBe(true);
    });

    it('should reject invalid coordinates', () => {
      const invalidData = {
        x: 99999,
        y: 200,
        color: '#FF0000',
        lineWidth: 5,
        end: false,
      };

      expect(AntiCheat.validateDrawData(invalidData)).toBe(false);
    });

    it('should reject invalid color format', () => {
      const invalidData = {
        x: 100,
        y: 200,
        color: 'red',
        lineWidth: 5,
        end: false,
      };

      expect(AntiCheat.validateDrawData(invalidData)).toBe(false);
    });

    it('should reject invalid line width', () => {
      const invalidData = {
        x: 100,
        y: 200,
        color: '#FF0000',
        lineWidth: 100,
        end: false,
      };

      expect(AntiCheat.validateDrawData(invalidData)).toBe(false);
    });
  });

  describe('trackDrawAction', () => {
    it('should track draw actions', () => {
      const socketId = 'test-socket-1';
      
      for (let i = 0; i < 10; i++) {
        expect(AntiCheat.trackDrawAction(socketId)).toBe(true);
      }
    });

    it('should flag excessive draw actions', () => {
      const socketId = 'test-socket-2';
      
      // Simulate spam
      for (let i = 0; i < 150; i++) {
        AntiCheat.trackDrawAction(socketId);
      }
      
      expect(AntiCheat.isSuspicious(socketId)).toBe(true);
    });
  });

  describe('trackGuess', () => {
    it('should track guesses', () => {
      const socketId = 'test-socket-3';
      
      expect(AntiCheat.trackGuess(socketId, false)).toBe(true);
      expect(AntiCheat.trackGuess(socketId, true)).toBe(true);
    });

    it('should flag suspiciously high correct guess ratio', () => {
      const socketId = 'test-socket-4';
      
      // Simulate bot with 100% accuracy
      for (let i = 0; i < 15; i++) {
        AntiCheat.trackGuess(socketId, true);
      }
      
      expect(AntiCheat.isSuspicious(socketId)).toBe(true);
    });
  });

  describe('IP banning', () => {
    const testIP = '192.168.1.100';

    it('should ban IP address', () => {
      AntiCheat.banIP(testIP, 'Test ban');
      expect(AntiCheat.isIPBanned(testIP)).toBe(true);
    });

    it('should unban IP address', () => {
      AntiCheat.banIP(testIP, 'Test ban');
      AntiCheat.unbanIP(testIP);
      expect(AntiCheat.isIPBanned(testIP)).toBe(false);
    });

    it('should list banned IPs', () => {
      const ip1 = '192.168.1.1';
      const ip2 = '192.168.1.2';
      
      AntiCheat.banIP(ip1, 'Test');
      AntiCheat.banIP(ip2, 'Test');
      
      const bannedIPs = AntiCheat.getBannedIPs();
      expect(bannedIPs).toContain(ip1);
      expect(bannedIPs).toContain(ip2);
      
      // Cleanup
      AntiCheat.unbanIP(ip1);
      AntiCheat.unbanIP(ip2);
    });
  });
});

