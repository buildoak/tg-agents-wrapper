import { readdirSync, statSync, unlinkSync } from "fs";
import { join } from "path";

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Remove files older than TTL from a directory.
 * Non-recursive, best-effort. Logs deletions.
 */
export function cleanupOldFiles(dir: string, ttlMs: number = DEFAULT_TTL_MS): number {
  let cleaned = 0;
  const now = Date.now();

  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      // Skip special files
      if (entry === "." || entry === ".." || entry === ".gitkeep" || entry === "sessions.json") {
        continue;
      }

      const fullPath = join(dir, entry);
      try {
        const stat = statSync(fullPath);
        if (stat.isFile() && now - stat.mtimeMs > ttlMs) {
          unlinkSync(fullPath);
          cleaned++;
          console.log(`[cleanup] Removed old file: ${entry} (age: ${Math.round((now - stat.mtimeMs) / 3600000)}h)`);
        }
      } catch {
        // Skip files we cannot stat or delete
      }
    }
  } catch (error) {
    console.error(`[cleanup] Failed to scan directory ${dir}:`, error);
  }

  return cleaned;
}
