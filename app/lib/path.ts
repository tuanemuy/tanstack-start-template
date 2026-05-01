import * as path from "node:path";

/**
 * Convert a `file:` URL with a relative path into one with an absolute path.
 * URLs that are already absolute or do not start with `file:` pass through
 * unchanged.
 */
export function normalizeFileUrl(url: string): string {
  if (!url.startsWith("file:")) {
    return url;
  }

  const filePath = url.slice(5);

  if (path.isAbsolute(filePath)) {
    return url;
  }

  return `file:${path.resolve(process.cwd(), filePath)}`;
}
