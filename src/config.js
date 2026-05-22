import path from "node:path";

function toBool(value, defaultValue) {
  if (value == null || value === "") {
    return defaultValue;
  }
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function toInt(value, defaultValue) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function toList(value, defaultValue = []) {
  if (!value) {
    return defaultValue;
  }
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeProxyUrl(value) {
  if (!value) {
    return "";
  }

  const trimmed = String(value).trim();
  if (!trimmed) {
    return "";
  }

  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    return trimmed;
  }

  return `http://${trimmed}`;
}

const cwd = process.cwd();

export const config = {
  proxyPort: toInt(process.env.PROXY_PORT, 8080),
  repoPort: toInt(process.env.REPO_PORT, 8081),
  cacheDir: path.resolve(cwd, process.env.CACHE_DIR || "data/cache"),
  enableHttpsProxy: toBool(process.env.ENABLE_HTTPS_PROXY, true),
  httpsMitmDomains: toList(process.env.HTTPS_MITM_DOMAINS, ["repo1.maven.org", "repo.maven.apache.org"]),
  multiThreadDomains: toList(process.env.MULTI_THREAD_DOMAINS, ["repo1.maven.org"]),
  multiThreadCount: Math.max(1, toInt(process.env.MULTI_THREAD_COUNT, 4)),
  multiThreadMinSizeBytes: Math.max(0, toInt(process.env.MULTI_THREAD_MIN_SIZE_BYTES, 1024 * 1024)),
  downloadTimeoutMs: Math.max(1000, toInt(process.env.DOWNLOAD_TIMEOUT_MS, 60000)),
  certDir: path.resolve(cwd, process.env.CERT_DIR || "data/certs"),
  rootCertPath: path.resolve(cwd, process.env.ROOT_CERT_PATH || "data/certs/root-ca.crt"),
  rootKeyPath: path.resolve(cwd, process.env.ROOT_KEY_PATH || "data/certs/root-ca.key.pem"),
  leafCertDir: path.resolve(cwd, process.env.LEAF_CERT_DIR || "data/certs/leaf"),
  trustStorePath: path.resolve(cwd, process.env.TRUST_STORE_PATH || "data/certs/proxy-truststore.jks"),
  trustStoreAlias: process.env.TRUST_STORE_ALIAS || "maven-proxy-root-ca",
  trustStorePassword: process.env.TRUST_STORE_PASSWORD || "changeit",
  javaHome: process.env.JAVA_HOME || "",
  httpsPassthroughForUnmatched: toBool(process.env.HTTPS_PASSTHROUGH_FOR_UNMATCHED, true),
  upstreamProxyUrl: normalizeProxyUrl(process.env.UPSTREAM_PROXY_URL || process.env.ALL_PROXY || process.env.all_proxy || ""),
  upstreamHttpProxyUrl: normalizeProxyUrl(process.env.UPSTREAM_HTTP_PROXY_URL || process.env.HTTP_PROXY || process.env.http_proxy || ""),
  upstreamHttpsProxyUrl: normalizeProxyUrl(process.env.UPSTREAM_HTTPS_PROXY_URL || process.env.HTTPS_PROXY || process.env.https_proxy || ""),
  upstreamNoProxyDomains: toList(process.env.UPSTREAM_NO_PROXY || process.env.NO_PROXY || process.env.no_proxy || ""),
  upstreamIgnoreDomains: toList(process.env.UPSTREAM_IGNORE_DOMAINS || ""),
};
