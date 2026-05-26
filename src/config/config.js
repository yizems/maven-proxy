import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import dotenv from "dotenv";
import { detectJavaHome } from "../common/java-home.js";

const cwd = process.cwd();
const userConfigDir = path.resolve(os.homedir(), "maven-proxy");
const defaultUserConfigPath = path.join(userConfigDir, "config.properties");

function normalizeConfigMode(value) {
  const normalized = String(value || "").trim().toLowerCase();

  if (["dev", "development", "project"].includes(normalized)) {
    return "development";
  }

  if (["user", "home", "global", "production", "prod"].includes(normalized)) {
    return "user";
  }

  return "";
}

function isProjectWorkspace(dirPath) {
  const packageJsonPath = path.resolve(dirPath, "package.json");
  const entryPath = path.resolve(dirPath, "src/index.js");

  if (!fs.existsSync(packageJsonPath) || !fs.existsSync(entryPath)) {
    return false;
  }

  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    return packageJson?.name === "maven-proxy";
  } catch {
    return false;
  }
}

function resolveConfigMode() {
  const forced = normalizeConfigMode(process.env.MAVEN_PROXY_CONFIG_MODE);
  if (forced) {
    return forced;
  }

  return isProjectWorkspace(cwd) ? "development" : "user";
}

function resolveConfigFilePath(configMode) {
  const envPath = String(process.env.MAVEN_PROXY_CONFIG_FILE || "").trim();
  if (envPath) {
    return path.isAbsolute(envPath) ? envPath : path.resolve(cwd, envPath);
  }

  if (configMode === "development") {
    const devCandidates = [
      path.resolve(cwd, "config.properties"),
    ];

    for (const candidate of devCandidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    return "";
  }

  return fs.existsSync(defaultUserConfigPath) ? defaultUserConfigPath : "";
}

function loadEnvFromFile(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    dotenv.config({ path: filePath, override: false });
    return filePath;
  }

  return "";
}

const configMode = resolveConfigMode();
const resolvedConfigFilePath = resolveConfigFilePath(configMode);
const loadedConfigFile = loadEnvFromFile(resolvedConfigFilePath);
const configBaseDir = configMode === "development"
  ? cwd
  : (resolvedConfigFilePath ? path.dirname(resolvedConfigFilePath) : userConfigDir);
const javaHomeResolution = detectJavaHome(process.env.JAVA_HOME || "");

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

function parseDurationToMs(value, fallbackMs) {
  const text = String(value || "").trim();
  if (!text) {
    return fallbackMs;
  }

  const match = text.match(/^(\d+)([smhd])$/i);
  if (!match) {
    return fallbackMs;
  }

  const amount = Number.parseInt(match[1], 10);
  const unit = String(match[2] || "").toLowerCase();
  if (!Number.isFinite(amount) || amount < 0) {
    return fallbackMs;
  }

  if (unit === "s") {
    return amount * 1000;
  }

  if (unit === "m") {
    return amount * 60 * 1000;
  }

  if (unit === "h") {
    return amount * 60 * 60 * 1000;
  }

  return amount * 24 * 60 * 60 * 1000;
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

function resolveOptionalPath(baseDir, value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }

  return path.isAbsolute(raw) ? raw : path.resolve(baseDir, raw);
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
  "https://dl.google.com",
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
  "dl.google.com",
  ...extractHostsFromUrls(repoFallbackRepos),
];

const cacheDir = path.resolve(configBaseDir, process.env.CACHE_DIR || "data/cache");

const multiThreadMinSizeBytes = Math.max(0, toInt(process.env.MULTI_THREAD_MIN_SIZE_MB, 1)) * 1024 * 1024;
const downloadTimeout = process.env.DOWNLOAD_TIMEOUT || "60s";
const outboundKeepAliveInterval = process.env.OUTBOUND_KEEP_ALIVE_INTERVAL || "1s";
const mavenNegativeCacheTtl = process.env.MAVEN_NEGATIVE_CACHE_TTL || "24h";
const mavenAffinityFlushInterval = process.env.MAVEN_AFFINITY_FLUSH_INTERVAL || "5s";
const logRetention = process.env.LOG_RETENTION || "7d";

const downloadTimeoutMs = Math.max(1, parseDurationToMs(downloadTimeout, 60 * 1000));
const outboundKeepAliveMsecs = Math.max(1, parseDurationToMs(outboundKeepAliveInterval, 1000));
const mavenNegativeCacheTtlMs = Math.max(1, parseDurationToMs(mavenNegativeCacheTtl, 24 * 60 * 60 * 1000));
const mavenAffinityFlushIntervalMs = Math.max(1, parseDurationToMs(mavenAffinityFlushInterval, 5 * 1000));
const logRetentionDays = Math.max(1, Math.ceil(parseDurationToMs(logRetention, 7 * 24 * 60 * 60 * 1000) / (24 * 60 * 60 * 1000)));
const mavenAffinityEventMaxBytes = Math.max(1, toInt(process.env.MAVEN_AFFINITY_EVENT_MAX_MB, 8)) * 1024 * 1024;

export const config = {
  configMode,
  configBaseDir,
  loadedConfigFile,
  defaultUserConfigPath,
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
  multiThreadMinSizeBytes,
  downloadTimeout,
  downloadTimeoutMs,
  outboundKeepAlive: toBool(process.env.OUTBOUND_KEEP_ALIVE, true),
  outboundKeepAliveInterval,
  outboundKeepAliveMsecs,
  outboundMaxSockets: Math.max(1, toInt(process.env.OUTBOUND_MAX_SOCKETS, 64)),
  outboundMaxFreeSockets: Math.max(1, toInt(process.env.OUTBOUND_MAX_FREE_SOCKETS, 16)),
  mavenAffinityEnabled: toBool(process.env.MAVEN_AFFINITY_ENABLED, true),
  mavenAffinityIndexDir: path.resolve(configBaseDir, process.env.MAVEN_AFFINITY_INDEX_DIR || "data/index"),
  mavenNegativeCacheTtl,
  mavenNegativeCacheTtlMs,
  mavenAffinityFlushInterval,
  mavenAffinityFlushIntervalMs,
  mavenAffinityEventMaxBytes,
  cacheCleanupEnabled: toBool(process.env.CACHE_CLEANUP_ENABLED, true),
  cacheCleanupDailyAt: process.env.CACHE_CLEANUP_DAILY_AT || "03:00",
  cacheCleanupCheckMinInterval: process.env.CACHE_CLEANUP_CHECK_MIN_INTERVAL || "10m",
  cacheTouchOnHit: toBool(process.env.CACHE_TOUCH_ON_HIT, true),
  cacheTouchMinInterval: process.env.CACHE_TOUCH_MIN_INTERVAL || "1d",
  cacheRetentionStart: process.env.CACHE_RETENTION_START || "10d",
  cacheRetentionMin: process.env.CACHE_RETENTION_MIN || "1d",
  cacheDiskFreeTrigger: process.env.CACHE_DISK_FREE_TRIGGER || "20G",
  cacheDiskFreeTarget: process.env.CACHE_DISK_FREE_TARGET || "25G",
  cacheMaxSize: process.env.CACHE_MAX_SIZE || "",
  cacheTargetSize: process.env.CACHE_TARGET_SIZE || "",
  downloadLogDir: path.resolve(configBaseDir, process.env.DOWNLOAD_LOG_DIR || "data/logs/downloads"),
  logRetention,
  logRetentionDays,
  logToStdout: toBool(process.env.LOG_TO_STDOUT, true),
  logConnectEvents: toBool(process.env.LOG_CONNECT_EVENTS, false),
  certDir: path.resolve(configBaseDir, process.env.CERT_DIR || "data/certs"),
  rootCertPath: path.resolve(configBaseDir, process.env.ROOT_CERT_PATH || "data/certs/root-ca.crt"),
  rootKeyPath: path.resolve(configBaseDir, process.env.ROOT_KEY_PATH || "data/certs/root-ca.key.pem"),
  leafCertDir: path.resolve(configBaseDir, process.env.LEAF_CERT_DIR || "data/certs/leaf"),
  trustStorePath: path.resolve(configBaseDir, process.env.TRUST_STORE_PATH || "data/certs/proxy-truststore.jks"),
  trustStoreAlias: process.env.TRUST_STORE_ALIAS || "maven-proxy-root-ca",
  trustStorePassword: process.env.TRUST_STORE_PASSWORD || "changeit",
  existingTrustStorePath: resolveOptionalPath(configBaseDir, process.env.EXISTING_TRUST_STORE_PATH || ""),
  existingTrustStorePassword: process.env.EXISTING_TRUST_STORE_PASSWORD || "",
  javaHome: javaHomeResolution.javaHome,
  javaHomeSource: javaHomeResolution.source,
  javaHomeConfigured: javaHomeResolution.configuredJavaHome || "",
  httpsPassthroughForUnmatched: toBool(process.env.HTTPS_PASSTHROUGH_FOR_UNMATCHED, false),
  upstreamProxyUrl: normalizeProxyUrl(process.env.UPSTREAM_PROXY_URL || process.env.ALL_PROXY || process.env.all_proxy || ""),
  upstreamHttpProxyUrl: normalizeProxyUrl(process.env.UPSTREAM_HTTP_PROXY_URL || process.env.HTTP_PROXY || process.env.http_proxy || ""),
  upstreamHttpsProxyUrl: normalizeProxyUrl(process.env.UPSTREAM_HTTPS_PROXY_URL || process.env.HTTPS_PROXY || process.env.https_proxy || ""),
  upstreamNoProxyDomains: toList(process.env.UPSTREAM_NO_PROXY || process.env.NO_PROXY || process.env.no_proxy || ""),
  upstreamIgnoreDomains: toList(process.env.UPSTREAM_IGNORE_DOMAINS || ""),
  repoFallbackRepos,
};
