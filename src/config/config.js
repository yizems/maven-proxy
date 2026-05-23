import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

const cwd = process.cwd();

function loadEnvFromFile() {
  const candidates = [
    path.resolve(cwd, ".env"),
    path.resolve(cwd, ".evn"),
  ];

  for (const filePath of candidates) {
    if (fs.existsSync(filePath)) {
      dotenv.config({ path: filePath, override: false });
      return filePath;
    }
  }

  return "";
}

loadEnvFromFile();

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

function normalizeRepoList(value, defaultValue = []) {
  const raw = toList(value, defaultValue);
  return raw
    .map((item) => String(item).trim())
    .filter((item) => /^https?:\/\//i.test(item))
    .map((item) => item.replace(/\/+$/, ""));
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

function extractHostsFromUrls(urls) {
  const hosts = [];

  for (const rawUrl of urls) {
    try {
      hosts.push(new URL(rawUrl).hostname.toLowerCase());
    } catch {
      // ignore invalid URL
    }
  }

  return [...new Set(hosts)];
}

const defaultRepoFallbackRepos = [
  "https://repo1.maven.org/maven2",
  "https://jitpack.io",
  "https://plugins.gradle.org/m2",
  "https://maven.google.com",
];

const repoFallbackRepos = normalizeRepoList(
  process.env.REPO_FALLBACK_REPOS,
  defaultRepoFallbackRepos,
);

const defaultMavenRepoDomains = [
  "repo1.maven.org",
  "repo.maven.apache.org",
  "jitpack.io",
  "plugins.gradle.org",
  "maven.google.com",
  ...extractHostsFromUrls(repoFallbackRepos),
];

const cacheDir = path.resolve(cwd, process.env.CACHE_DIR || "data/cache");

export const config = {
  proxyPort: toInt(process.env.PROXY_PORT, 8080),
  repoPort: toInt(process.env.REPO_PORT, 8081),
  cacheDir,
  mavenCacheDir: path.resolve(cacheDir, "maven"),
  npmCacheDir: path.resolve(cacheDir, "npm"),
  genericCacheDir: path.resolve(cacheDir, "generic"),
  enableHttpsProxy: toBool(process.env.ENABLE_HTTPS_PROXY, true),
  httpsMitmDomains: toList(process.env.HTTPS_MITM_DOMAINS, ["repo1.maven.org", "repo.maven.apache.org", "registry.npmjs.org"]),
  npmRegistryDomains: toList(process.env.NPM_REGISTRY_DOMAINS, ["registry.npmjs.org", "registry.npmmirror.com", "npm.pkg.github.com"]),
  mavenRepoDomains: toList(process.env.MAVEN_REPO_DOMAINS, [...new Set(defaultMavenRepoDomains)]),
  multiThreadDomains: toList(process.env.MULTI_THREAD_DOMAINS, ["repo1.maven.org"]),
  multiThreadCount: Math.max(1, toInt(process.env.MULTI_THREAD_COUNT, 4)),
  multiThreadMinSizeBytes: Math.max(0, toInt(process.env.MULTI_THREAD_MIN_SIZE_BYTES, 1024 * 1024)),
  downloadTimeoutMs: Math.max(1000, toInt(process.env.DOWNLOAD_TIMEOUT_MS, 60000)),
  downloadLogDir: path.resolve(cwd, process.env.DOWNLOAD_LOG_DIR || "data/logs/downloads"),
  logRetentionDays: Math.max(1, toInt(process.env.LOG_RETENTION_DAYS, 7)),
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
  repoFallbackRepos,
};
