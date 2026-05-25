function safeDecode(pathname) {
  try {
    return decodeURIComponent(pathname || "/");
  } catch {
    return pathname || "/";
  }
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizePathname(pathname) {
  return String(pathname || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/")
    .trim();
}

function stripKnownPrefixes(relativePath) {
  const raw = normalizePathname(relativePath);
  if (!raw) {
    return [];
  }

  const candidates = new Set([raw]);

  if (raw.toLowerCase().startsWith("maven2/")) {
    candidates.add(raw.slice("maven2/".length));
  }

  if (raw.toLowerCase().startsWith("m2/")) {
    candidates.add(raw.slice("m2/".length));
  }

  const maven2Marker = raw.toLowerCase().indexOf("/maven2/");
  if (maven2Marker >= 0) {
    candidates.add(raw.slice(maven2Marker + "/maven2/".length));
  }

  const m2Marker = raw.toLowerCase().indexOf("/m2/");
  if (m2Marker >= 0) {
    candidates.add(raw.slice(m2Marker + "/m2/".length));
  }

  const patterns = [
    /^repository\/[^/]+\/(.+)$/i,
    /^artifactory\/[^/]+\/(.+)$/i,
    /^nexus\/content\/repositories\/[^/]+\/(.+)$/i,
    /^repositories\/[^/]+\/(.+)$/i,
  ];

  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (match?.[1]) {
      candidates.add(match[1]);
    }
  }

  const normalizedCandidates = [...candidates].map((item) => normalizePathname(item)).filter(Boolean);
  normalizedCandidates.sort((left, right) => left.split("/").length - right.split("/").length);
  return normalizedCandidates;
}

function isSafePathSegment(segment) {
  return /^[A-Za-z0-9_.+-]+$/.test(String(segment || ""));
}

function isReleaseVersion(version) {
  return !String(version || "").toUpperCase().endsWith("-SNAPSHOT");
}

function matchReleaseFileName(artifact, version, fileName) {
  if (/-SNAPSHOT(?=\.|-)/i.test(fileName)) {
    return false;
  }

  const escapedArtifact = escapeRegex(artifact);
  const escapedVersion = escapeRegex(version);
  const pattern = new RegExp(
    `^${escapedArtifact}-${escapedVersion}(?:-[A-Za-z0-9_.+:-]+)?\\.(pom|jar|module|aar|war)(?:\\.(sha1|sha256|sha512|md5|asc))?$`,
    "i",
  );

  return pattern.test(fileName);
}

function tryParseCandidate(relativePath) {
  const normalized = normalizePathname(relativePath);
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length < 4) {
    return null;
  }

  const fileName = parts[parts.length - 1];
  const version = parts[parts.length - 2];
  const artifact = parts[parts.length - 3];
  const groupParts = parts.slice(0, -3);

  if (!artifact || !version || !fileName || groupParts.length === 0) {
    return null;
  }

  if (!isSafePathSegment(artifact) || !isSafePathSegment(version) || !isSafePathSegment(fileName)) {
    return null;
  }

  if (!groupParts.every((segment) => isSafePathSegment(segment))) {
    return null;
  }

  if (!isReleaseVersion(version)) {
    return null;
  }

  if (!matchReleaseFileName(artifact, version, fileName)) {
    return null;
  }

  const groupPath = groupParts.join("/");
  const canonicalPath = `${groupPath}/${artifact}/${version}/${fileName}`;

  return {
    canonicalPath,
    canonicalKey: canonicalPath,
    groupPath,
    artifact,
    version,
    fileName,
    isRelease: true,
  };
}

export function parseMavenReleaseCanonical(urlObj) {
  if (!urlObj || typeof urlObj !== "object") {
    return null;
  }

  const decodedPath = safeDecode(urlObj.pathname || "/");
  const candidates = stripKnownPrefixes(decodedPath);

  for (const candidate of candidates) {
    const parsed = tryParseCandidate(candidate);
    if (parsed) {
      return parsed;
    }
  }

  return null;
}
