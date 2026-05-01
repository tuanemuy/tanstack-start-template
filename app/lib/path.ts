import * as path from "node:path";

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
