import path from "node:path";

function sanitizeSegment(segment) {
  return segment.replace(/[<>:\\"|?*]/g, "_");
}

function safeDecode(pathname) {
  try {
    return decodeURIComponent(pathname || "/");
  } catch {
    return pathname || "/";
  }
}

function looksLikeMavenVersionSegment(segment) {
  return /^\d[0-9A-Za-z._-]*$/.test(String(segment || ""));
}

function isLikelyMavenFilePath(parts, normalizedPath) {
  if (normalizedPath.endsWith("/") || parts.length === 0) {
    return false;
  }

  const last = String(parts[parts.length - 1] || "").toLowerCase();
  if (!last) {
    return false;
  }

  if (last.startsWith("maven-metadata.")) {
    return true;
  }

  const knownSuffixes = [
    ".pom",
    ".jar",
    ".aar",
    ".war",
    ".zip",
    ".module",
    ".xml",
    ".sha1",
    ".md5",
    ".sha256",
    ".sha512",
    ".asc",
    ".json",
    ".toml",
    ".klib",
  ];

  if (knownSuffixes.some((suffix) => last.endsWith(suffix))) {
    return true;
  }

  const secondLast = String(parts[parts.length - 2] || "").toLowerCase();
  if (looksLikeMavenVersionSegment(secondLast)) {
    return true;
  }

  return false;
}

export function getCacheFilePath(cacheDir, urlObj, options = {}) {
  const ecosystem = sanitizeSegment(String(options.ecosystem || "generic").toLowerCase());
  const includeHost = options.includeHost ?? ecosystem !== "maven";

  const rawPathname = safeDecode(urlObj.pathname || "/");
  const normalized = rawPathname.replace(/\\/g, "/");
  const lowerNormalized = normalized.toLowerCase();
  const parts = normalized.split("/").filter(Boolean);

  if (parts.some((part) => part === "..")) {
    throw new Error(`Invalid path traversal attempt: ${rawPathname}`);
  }

  if (parts.length === 0) {
    parts.push("index");
  }

  const safeParts = parts.map((part) => sanitizeSegment(part));

  if (includeHost) {
    safeParts.unshift(sanitizeSegment(String(urlObj.hostname || "unknown").toLowerCase()));
  }

  if (ecosystem === "maven" && !isLikelyMavenFilePath(parts, normalized)) {
    safeParts.push("__dir__.json");
  }

  const npmTarballPath = /\/-\/.+\.tgz$/i.test(lowerNormalized);
  if (ecosystem === "npm" && !npmTarballPath) {
    safeParts.push("__meta__.json");
  }

  if (urlObj.search && urlObj.search.length > 1) {
    const lastIndex = safeParts.length - 1;
    const encodedQuery = encodeURIComponent(urlObj.search.slice(1));
    safeParts[lastIndex] = `${safeParts[lastIndex]}__q__${encodedQuery}`;
  }

  return path.join(cacheDir, ecosystem, ...safeParts);
}
