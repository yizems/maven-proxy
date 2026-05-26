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

function normalizeSlashPath(rawPath) {
  const decoded = safeDecode(rawPath || "/").replace(/\\/g, "/").replace(/\/+/g, "/");
  if (!decoded) {
    return "/";
  }
  return decoded.startsWith("/") ? decoded : `/${decoded}`;
}

function trimTrailingSlash(normalizedPath) {
  if (normalizedPath.length > 1 && normalizedPath.endsWith("/")) {
    return normalizedPath.slice(0, -1);
  }
  return normalizedPath;
}

function normalizeRulePrefixPath(rawPrefix) {
  return trimTrailingSlash(normalizeSlashPath(rawPrefix || "/"));
}

function getEffectivePort(urlObj) {
  if (urlObj?.port) {
    return String(urlObj.port);
  }
  return urlObj?.protocol === "https:" ? "443" : "80";
}

function parseMavenCacheIgnorePathRule(rawRule) {
  const text = String(rawRule || "").trim();
  if (!text) {
    return null;
  }

  const firstSlash = text.indexOf("/");
  if (firstSlash <= 0) {
    return null;
  }

  const hostPortText = text.slice(0, firstSlash).trim().toLowerCase();
  const prefixText = text.slice(firstSlash);
  const hostMatch = hostPortText.match(/^([^:\/]+)(?::(\d+))?$/);
  if (!hostMatch) {
    return null;
  }

  const hostname = hostMatch[1];
  const port = hostMatch[2] || "";
  const pathPrefix = normalizeRulePrefixPath(prefixText);

  return {
    hostname,
    port,
    pathPrefix,
    raw: text,
  };
}

function ruleMatchesUrl(rule, urlObj) {
  if (!rule || !urlObj) {
    return false;
  }

  const hostname = String(urlObj.hostname || "").toLowerCase();
  if (!hostname || hostname !== rule.hostname) {
    return false;
  }

  if (!rule.port) {
    return true;
  }

  return getEffectivePort(urlObj) === rule.port;
}

export function parseMavenCacheIgnorePathPrefixes(rawRules) {
  const input = Array.isArray(rawRules) ? rawRules.join(",") : String(rawRules || "");
  const tokens = input
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  const parsed = [];
  const dedupe = new Set();

  for (const token of tokens) {
    const rule = parseMavenCacheIgnorePathRule(token);
    if (!rule) {
      continue;
    }

    const key = `${rule.hostname}:${rule.port}|${rule.pathPrefix}`;
    if (dedupe.has(key)) {
      continue;
    }

    dedupe.add(key);
    parsed.push(rule);
  }

  return parsed;
}

export function stripMavenIgnoredPathPrefix(pathname, urlObj, rules = []) {
  const normalizedPath = normalizeSlashPath(pathname || "/");
  const validRules = Array.isArray(rules) ? rules : [];
  if (validRules.length === 0 || !urlObj) {
    return normalizedPath;
  }

  const matchedRules = validRules
    .filter((rule) => ruleMatchesUrl(rule, urlObj))
    .sort((a, b) => b.pathPrefix.length - a.pathPrefix.length);

  for (const rule of matchedRules) {
    const prefix = rule.pathPrefix;
    if (prefix === "/") {
      return normalizedPath;
    }

    if (normalizedPath === prefix) {
      return "/";
    }

    if (normalizedPath.startsWith(`${prefix}/`)) {
      const stripped = normalizedPath.slice(prefix.length);
      return stripped || "/";
    }
  }

  return normalizedPath;
}

export function buildMavenHostlessPathCandidates(pathname, rules = []) {
  const normalizedPath = normalizeSlashPath(pathname || "/");
  const candidates = new Set([normalizedPath]);
  const validRules = Array.isArray(rules) ? rules : [];

  for (const rule of validRules) {
    const prefix = rule.pathPrefix;
    if (!prefix || prefix === "/") {
      continue;
    }

    if (normalizedPath === prefix) {
      candidates.add("/");
      continue;
    }

    if (normalizedPath.startsWith(`${prefix}/`)) {
      const stripped = normalizedPath.slice(prefix.length);
      candidates.add(stripped || "/");
    }
  }

  return [...candidates];
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
  const mavenIgnoreRules = options.mavenCacheIgnorePathPrefixRules || [];

  const rawPathname = safeDecode(urlObj.pathname || "/");
  let normalized = rawPathname.replace(/\\/g, "/");
  if (ecosystem === "maven") {
    normalized = stripMavenIgnoredPathPrefix(normalized, urlObj, mavenIgnoreRules);
  }

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
