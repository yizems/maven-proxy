const MAVEN_ARTIFACT_EXTENSIONS = new Set([
  ".pom",
  ".jar",
  ".aar",
  ".war",
  ".module",
  ".xml",
  ".sha1",
  ".md5",
]);

function safeDecode(pathname) {
  try {
    return decodeURIComponent(pathname || "/");
  } catch {
    return pathname || "/";
  }
}

function hasExtension(pathname, extensions) {
  const lower = String(pathname || "").toLowerCase();
  for (const ext of extensions) {
    if (lower.endsWith(ext)) {
      return true;
    }
  }
  return false;
}

export function detectPackageEcosystem(urlObj, config, matchesDomain) {
  const hostname = String(urlObj.hostname || "").toLowerCase();
  const pathname = safeDecode(urlObj.pathname || "/");
  const lowerPath = pathname.toLowerCase();

  if (matchesDomain(hostname, config.npmRegistryDomains || [])) {
    return "npm";
  }

  if (matchesDomain(hostname, config.mavenRepoDomains || [])) {
    return "maven";
  }

  if (lowerPath.startsWith("/maven2/") || hasExtension(lowerPath, MAVEN_ARTIFACT_EXTENSIONS)) {
    return "maven";
  }

  if (
    lowerPath.startsWith("/-/v1/") ||
    /\/\/-\/.+\.tgz$/i.test(lowerPath) ||
    lowerPath.startsWith("/@")
  ) {
    return "npm";
  }

  if (hostname.includes("npm")) {
    return "npm";
  }

  if (hostname.includes("maven") || hostname.includes("jitpack") || hostname.includes("gradle")) {
    return "maven";
  }

  return "generic";
}