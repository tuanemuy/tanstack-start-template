import * as path from "node:path";

/**
 * Convert a file: URL with a relative path to an absolute path
 *
 * @param url - The URL to normalize (e.g., "file:./data/db.sqlite")
 * @returns The normalized URL with absolute path (e.g., "file:/absolute/path/data/db.sqlite")
 */
export function normalizeFileUrl(url: string): string {
  if (!url.startsWith("file:")) {
    return url;
  }

  const filePath = url.slice(5); // Remove "file:" prefix

  // Check if it's already an absolute path
  if (path.isAbsolute(filePath)) {
    return url;
  }

  // Convert relative path to absolute path
  const absolutePath = path.resolve(process.cwd(), filePath);
  return `file:${absolutePath}`;
}

/**
 * Extract the file path from a file: URL and normalize it to an absolute path
 *
 * @param url - The file: URL (e.g., "file:./data/db.sqlite")
 * @returns The absolute file path (e.g., "/absolute/path/data/db.sqlite")
 */
export function extractFilePathFromUrl(url: string): string {
  if (!url.startsWith("file:")) {
    return url;
  }

  const filePath = url.slice(5); // Remove "file:" prefix

  // Check if it's already an absolute path
  if (path.isAbsolute(filePath)) {
    return filePath;
  }

  // Convert relative path to absolute path
  return path.resolve(process.cwd(), filePath);
}
