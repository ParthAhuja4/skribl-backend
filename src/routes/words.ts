import express, { Request, Response } from "express";
import { asyncHandler } from "../utils/errors";
import { logger } from "../config/logger";
import fs from "fs/promises";
import path from "path";

/**
 * Words API routes for managing game words
 */

export function setupWordsRoutes(app: express.Application) {
  const router = express.Router();

  const WORDS_FILE_PATH = path.join(__dirname, "../../words/en.txt");

  /**
   * Helper function to read existing words from file
   */
  async function readExistingWords(): Promise<Set<string>> {
    try {
      const content = await fs.readFile(WORDS_FILE_PATH, "utf-8");
      const words = content
        .split("\n")
        .map((word) => word.trim().toLowerCase())
        .filter((word) => word.length > 0);
      return new Set(words);
    } catch (error) {
      logger.error("Error reading words file", { error });
      throw error;
    }
  }

  /**
   * Helper function to append new words to file
   */
  async function appendWordsToFile(words: string[]): Promise<void> {
    try {
      // Append words with newline
      const content = words.join("\n") + "\n";
      await fs.appendFile(WORDS_FILE_PATH, content);
      logger.info("Words appended to file", { count: words.length });
    } catch (error) {
      logger.error("Error appending words to file", { error });
      throw error;
    }
  }

  // POST /api/words - Add new words
  router.post(
    "/",
    asyncHandler(async (req: Request, res: Response) => {
      const { words } = req.body;

      // Validate input
      if (!words || typeof words !== "string") {
        return res.status(400).json({ 
          error: "Invalid input. Please provide a 'words' string." 
        });
      }

      // Parse and normalize words
      const inputWords = words
        .split(",")
        .map((word) => word.trim().toLowerCase())
        .filter((word) => word.length > 0);

      if (inputWords.length === 0) {
        return res.status(400).json({ 
          error: "No valid words provided" 
        });
      }

      // Read existing words
      const existingWords = await readExistingWords();

      // Filter out duplicates (both from file and within input)
      const uniqueInputWords = new Set(inputWords);
      const newWords: string[] = [];
      const duplicates: string[] = [];

      for (const word of uniqueInputWords) {
        if (existingWords.has(word)) {
          duplicates.push(word);
        } else {
          newWords.push(word);
          existingWords.add(word); // Add to set to check for duplicates within this request
        }
      }

      // Add new words to file
      if (newWords.length > 0) {
        await appendWordsToFile(newWords);
      }

      // Get total word count
      const totalWords = existingWords.size;

      logger.info("Words submission processed", {
        submitted: inputWords.length,
        new: newWords.length,
        duplicates: duplicates.length,
        totalWords,
      });

      res.json({
        success: true,
        message: `Successfully added ${newWords.length} new word(s)`,
        stats: {
          submitted: inputWords.length,
          added: newWords.length,
          duplicates: duplicates.length,
          totalWords,
        },
        addedWords: newWords,
        duplicateWords: duplicates,
      });
    })
  );

  // GET /api/words/stats - Get word statistics
  router.get(
    "/stats",
    asyncHandler(async (req: Request, res: Response) => {
      const existingWords = await readExistingWords();
      
      res.json({
        totalWords: existingWords.size,
      });
    })
  );

  app.use("/api/words", router);
}
