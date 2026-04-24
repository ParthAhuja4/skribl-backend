import fs from "fs";
import path from "path";
import { Languages } from "../types";
import { logger } from "../config/logger";

// In production (Docker), words are at /app/words
// In development, words are at ../../words relative to dist/src/utils
const WORDS_DIR = process.env.NODE_ENV === 'production' 
  ? path.join(process.cwd(), "words")
  : path.join(__dirname, "../../words");

logger.info("Words directory configured", { wordsDir: WORDS_DIR, nodeEnv: process.env.NODE_ENV });
const CUSTOM_WORDS_WEIGHT = 3;

// Cache words in memory
const wordsCache: Record<Languages, string[]> = {} as Record<
  Languages,
  string[]
>;

// Load words for a language
function loadWords(language: Languages): Promise<string[]> {
  return new Promise((resolve, reject) => {
    if (wordsCache[language]) {
      return resolve(wordsCache[language]);
    }

    // Get the language code (enum key) from the enum value if needed
    let languageCode = language;
    // Handle case where the full language name is passed instead of code
    const languageEntry = Object.entries(Languages).find(([key, value]) => 
      value === language || key === language
    );
    if (languageEntry) {
      languageCode = languageEntry[0] as Languages;
    }

    const filePath = path.join(WORDS_DIR, `${languageCode}.txt`);
    fs.readFile(filePath, "utf8", (err, data) => {
      if (err) {
        return reject(
          new Error(`Failed to load words for ${languageCode}: ${err.message}`)
        );
      }

      const words = data
        .split("\n")
        .map((word) => word.trim())
        .filter(Boolean);
      if (words.length === 0) {
        return reject(new Error(`No words found in ${filePath}`));
      }

      wordsCache[language] = words;
      resolve(words);
    });
  });
}

// Function to get random words
export async function getRandomWords(
  n: number = 1,
  language: Languages,
  onlyCustomWords: boolean = false,
  customWords: string[] = []
): Promise<string[]> {
  try {
    let words: string[] = [];

    if (onlyCustomWords) {
      if (customWords.length < n) {
        throw new Error(`Not enough custom words provided`);
      }
      words = customWords;
    } else {
      const loadedWords = await loadWords(language);

      words = [
        ...loadedWords,
        ...Array(CUSTOM_WORDS_WEIGHT).fill(customWords).flat(),
      ];
      if (words.length < n) {
        throw new Error(`Not enough words available in ${language}`);
      }
    }

    // Shuffle the words array
    for (let i = words.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [words[i], words[j]] = [words[j], words[i]];
    }

    // Return the first n words
    return words.slice(0, n);
  } catch (error) {
    throw error;
  }
}

// Convert phrase to underscores
export function convertToUnderscores(phrase: string): number[] {
  return phrase.split(" ").map((word) => word.length);
}
