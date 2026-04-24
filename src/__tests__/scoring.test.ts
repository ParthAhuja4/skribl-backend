import {
  GUESSER_BASE_POINTS,
  GUESSER_MIN_POINTS,
  DRAWER_POINTS,
  BONUS_PER_GUESS,
  SCORE_TIER_1_END,
  SCORE_TIER_1_PENALTY,
  SCORE_TIER_2_END,
  SCORE_TIER_2_PENALTY,
  SCORE_TIER_3_END,
  SCORE_TIER_3_PENALTY,
  SCORE_TIER_4_PENALTY,
} from "../constants";

/**
 * Calculate guesser points using progressive time-based penalty system
 * (Extracted from roomController for testing)
 */
function calculateGuesserPoints(guessTimeInSeconds: number): number {
  let deduction = 0;
  let remainingTime = guessTimeInSeconds;
  
  // Tier 1: 0-30 seconds (-5 pts/sec)
  if (remainingTime > 0) {
    const tier1Time = Math.min(remainingTime, SCORE_TIER_1_END);
    deduction += tier1Time * SCORE_TIER_1_PENALTY;
    remainingTime -= tier1Time;
  }
  
  // Tier 2: 30-60 seconds (-10 pts/sec)
  if (remainingTime > 0) {
    const tier2Duration = SCORE_TIER_2_END - SCORE_TIER_1_END;
    const tier2Time = Math.min(remainingTime, tier2Duration);
    deduction += tier2Time * SCORE_TIER_2_PENALTY;
    remainingTime -= tier2Time;
  }
  
  // Tier 3: 60-90 seconds (-15 pts/sec)
  if (remainingTime > 0) {
    const tier3Duration = SCORE_TIER_3_END - SCORE_TIER_2_END;
    const tier3Time = Math.min(remainingTime, tier3Duration);
    deduction += tier3Time * SCORE_TIER_3_PENALTY;
    remainingTime -= tier3Time;
  }
  
  // Tier 4: After 90 seconds (-20 pts/sec)
  if (remainingTime > 0) {
    deduction += remainingTime * SCORE_TIER_4_PENALTY;
  }
  
  // Calculate final points with floor minimum
  const finalPoints = GUESSER_BASE_POINTS - Math.round(deduction);
  return Math.max(finalPoints, GUESSER_MIN_POINTS);
}

describe("Progressive Scoring System", () => {
  describe("Guesser Points Calculation", () => {
    
    test("Instant guess (0 seconds) should award maximum points", () => {
      expect(calculateGuesserPoints(0)).toBe(500);
    });

    test("Very fast guess (1 second) should award near-maximum points", () => {
      // 500 - (1 * 5) = 495
      expect(calculateGuesserPoints(1)).toBe(495);
    });

    test("Tier 1: Guess at 15 seconds", () => {
      // 500 - (15 * 5) = 425
      expect(calculateGuesserPoints(15)).toBe(425);
    });

    test("Tier 1 boundary: Guess at exactly 30 seconds", () => {
      // 500 - (30 * 5) = 350
      expect(calculateGuesserPoints(30)).toBe(350);
    });

    test("Tier 2: Guess at 35 seconds", () => {
      // 500 - (30 * 5) - (5 * 10) = 500 - 150 - 50 = 300
      expect(calculateGuesserPoints(35)).toBe(300);
    });

    test("Tier 2: Guess at 45 seconds", () => {
      // 500 - (30 * 5) - (15 * 10) = 500 - 150 - 150 = 200
      expect(calculateGuesserPoints(45)).toBe(200);
    });

    test("Tier 2 boundary: Guess at exactly 60 seconds", () => {
      // 500 - (30 * 5) - (30 * 10) = 500 - 150 - 300 = 50
      expect(calculateGuesserPoints(60)).toBe(50);
    });

    test("Tier 3: Guess at 65 seconds", () => {
      // 500 - (30 * 5) - (30 * 10) - (5 * 15) = 500 - 150 - 300 - 75 = -25
      // Should be floored to minimum 25
      expect(calculateGuesserPoints(65)).toBe(25);
    });

    test("Tier 3: Guess at 75 seconds", () => {
      // 500 - (30 * 5) - (30 * 10) - (15 * 15) = 500 - 150 - 300 - 225 = -175
      // Should be floored to minimum 25
      expect(calculateGuesserPoints(75)).toBe(25);
    });

    test("Tier 3 boundary: Guess at exactly 90 seconds", () => {
      // 500 - (30 * 5) - (30 * 10) - (30 * 15) = 500 - 150 - 300 - 450 = -400
      // Should be floored to minimum 25
      expect(calculateGuesserPoints(90)).toBe(25);
    });

    test("Tier 4: Guess at 100 seconds", () => {
      // 500 - (30*5) - (30*10) - (30*15) - (10*20) = 500 - 150 - 300 - 450 - 200 = -600
      // Should be floored to minimum 25
      expect(calculateGuesserPoints(100)).toBe(25);
    });

    test("Very late guess (120 seconds) should still award minimum points", () => {
      // Should be floored to minimum 25
      expect(calculateGuesserPoints(120)).toBe(25);
    });

    test("Fractional seconds should be handled correctly", () => {
      // 500 - (29.5 * 5) = 500 - 147.5 → Math.round(147.5) = 148 → 500 - 148 = 352
      expect(calculateGuesserPoints(29.5)).toBe(352);
    });

    test("Negative time should not break (edge case)", () => {
      // Should return max points
      expect(calculateGuesserPoints(-1)).toBe(500);
    });
  });

  describe("Drawer Points Calculation", () => {
    test("Drawer with 0 correct guesses", () => {
      const drawerPoints = DRAWER_POINTS + 0 * BONUS_PER_GUESS;
      expect(drawerPoints).toBe(200);
    });

    test("Drawer with 1 correct guess", () => {
      const drawerPoints = DRAWER_POINTS + 1 * BONUS_PER_GUESS;
      expect(drawerPoints).toBe(215);
    });

    test("Drawer with 3 correct guesses", () => {
      const drawerPoints = DRAWER_POINTS + 3 * BONUS_PER_GUESS;
      expect(drawerPoints).toBe(245);
    });

    test("Drawer with 5 correct guesses", () => {
      const drawerPoints = DRAWER_POINTS + 5 * BONUS_PER_GUESS;
      expect(drawerPoints).toBe(275);
    });

    test("Drawer with 7 correct guesses (max players)", () => {
      const drawerPoints = DRAWER_POINTS + 7 * BONUS_PER_GUESS;
      expect(drawerPoints).toBe(305);
    });
  });

  describe("Real Game Scenarios", () => {
    test("Scenario 1: Fast-paced game with all quick guesses", () => {
      const alice = calculateGuesserPoints(5);  // 475
      const bob = calculateGuesserPoints(8);    // 460
      const charlie = calculateGuesserPoints(12); // 440
      
      expect(alice).toBe(475);
      expect(bob).toBe(460);
      expect(charlie).toBe(440);
      
      const drawerPoints = DRAWER_POINTS + 3 * BONUS_PER_GUESS; // 245
      expect(drawerPoints).toBe(245);
    });

    test("Scenario 2: Mixed speed guesses", () => {
      const fast = calculateGuesserPoints(10);    // 450
      const medium = calculateGuesserPoints(40);   // 250
      const slow = calculateGuesserPoints(70);     // 25 (floored)
      
      expect(fast).toBe(450);
      expect(medium).toBe(250);
      expect(slow).toBe(25);
    });

    test("Scenario 3: Very difficult word - all late guesses", () => {
      const p1 = calculateGuesserPoints(80);  // 25
      const p2 = calculateGuesserPoints(85);  // 25
      const p3 = calculateGuesserPoints(89);  // 25
      
      expect(p1).toBe(25);
      expect(p2).toBe(25);
      expect(p3).toBe(25);
      
      const drawerPoints = DRAWER_POINTS + 3 * BONUS_PER_GUESS; // 245
      expect(drawerPoints).toBe(245);
    });

    test("Scenario 4: Solo guesser in small game", () => {
      const soloGuesser = calculateGuesserPoints(20); // 400
      const drawerPoints = DRAWER_POINTS + 1 * BONUS_PER_GUESS; // 215
      
      expect(soloGuesser).toBe(400);
      expect(drawerPoints).toBe(215);
    });
  });

  describe("Edge Cases and Boundary Conditions", () => {
    test("Exact boundary transitions should be consistent", () => {
      // Just before boundary (tier 1 only)
      const before30 = calculateGuesserPoints(29);
      // Just after boundary (tier 1 + tier 2)
      const after30 = calculateGuesserPoints(31);
      
      // Should have noticeable difference due to tier change
      // 29s: 500 - (29*5) = 355
      // 31s: 500 - (30*5) - (1*10) = 340
      expect(before30).toBeGreaterThan(after30);
      expect(before30).toBe(355);
      expect(after30).toBe(340);
    });

    test("Zero time should equal instant guess", () => {
      expect(calculateGuesserPoints(0)).toBe(GUESSER_BASE_POINTS);
    });

    test("Minimum floor should never be breached", () => {
      const extremelyLate = calculateGuesserPoints(999999);
      expect(extremelyLate).toBe(GUESSER_MIN_POINTS);
      expect(extremelyLate).toBeGreaterThanOrEqual(GUESSER_MIN_POINTS);
    });

    test("All tier boundaries should work correctly", () => {
      const tier1End = calculateGuesserPoints(30);
      const tier2End = calculateGuesserPoints(60);
      const tier3End = calculateGuesserPoints(90);
      
      // Should progressively decrease
      expect(tier1End).toBeGreaterThan(tier2End);
      expect(tier2End).toBeGreaterThanOrEqual(tier3End); // tier2End might hit floor
    });
  });

  describe("Constants Validation", () => {
    test("Constants should have expected values", () => {
      expect(GUESSER_BASE_POINTS).toBe(500);
      expect(GUESSER_MIN_POINTS).toBe(25);
      expect(DRAWER_POINTS).toBe(200);
      expect(BONUS_PER_GUESS).toBe(15);
      
      expect(SCORE_TIER_1_END).toBe(30);
      expect(SCORE_TIER_1_PENALTY).toBe(5);
      
      expect(SCORE_TIER_2_END).toBe(60);
      expect(SCORE_TIER_2_PENALTY).toBe(10);
      
      expect(SCORE_TIER_3_END).toBe(90);
      expect(SCORE_TIER_3_PENALTY).toBe(15);
      
      expect(SCORE_TIER_4_PENALTY).toBe(20);
    });

    test("Tier progression should be logical", () => {
      expect(SCORE_TIER_2_END).toBeGreaterThan(SCORE_TIER_1_END);
      expect(SCORE_TIER_3_END).toBeGreaterThan(SCORE_TIER_2_END);
      
      expect(SCORE_TIER_2_PENALTY).toBeGreaterThan(SCORE_TIER_1_PENALTY);
      expect(SCORE_TIER_3_PENALTY).toBeGreaterThan(SCORE_TIER_2_PENALTY);
      expect(SCORE_TIER_4_PENALTY).toBeGreaterThan(SCORE_TIER_3_PENALTY);
    });
  });
});
