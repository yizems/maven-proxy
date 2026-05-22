import path from "node:path";

function sanitizeSegment(segment) {
  return segment.replace(/[<>:\\"|?*]/g, "_");
}

export function getCacheFilePath(cacheDir, urlObj) {
  const rawPathname = urlObj.pathname || "/";
  const normalized = rawPathname.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);

  if (parts.some((part) => part === "..")) {
    throw new Error(`Invalid path traversal attempt: ${rawPathname}`);
  }

  if (parts.length === 0) {
    parts.push("index");
  }

  const safeParts = parts.map((part) => sanitizeSegment(part));

  if (urlObj.search && urlObj.search.length > 1) {
    const lastIndex = safeParts.length - 1;
    const encodedQuery = encodeURIComponent(urlObj.search.slice(1));
    safeParts[lastIndex] = `${safeParts[lastIndex]}__q__${encodedQuery}`;
  }

  return path.join(cacheDir, ...safeParts);
}
