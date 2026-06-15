#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const defaultConfigDir = path.resolve(os.homedir(), "maven-proxy");
const defaultConfigFile = path.join(defaultConfigDir, "config.properties");
const daemonPidFile = path.join(defaultConfigDir, "maven-proxy.pid");
const internalRunCommand = "__run-server";
const defaultForegroundCommand = "__start-foreground";
const cliFilePath = fileURLToPath(import.meta.url);

function normalizeMode(value) {
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

function resolveEffectiveMode(options) {
  const forced = normalizeMode(options.mode);
  if (forced) {
    return forced;
  }

  // CLI defaults to user mode to load ~/maven-proxy/config.properties unless explicitly overridden.
  return "user";
}

function printHelp() {
  console.log("maven-proxy CLI");
  console.log("");
  console.log("Usage:");
  console.log("  maven-proxy");
  console.log("  maven-proxy start [--mode <development|user>] [--config <file>]");
  console.log("  maven-proxy stop");
  console.log("  maven-proxy init-config [--force] [--config <file>]");
  console.log("  maven-proxy truststore <print|init|merge> [options]");
  console.log("  maven-proxy doctor [--mode <development|user>] [--config <file>]");
  console.log("");
  console.log("Examples:");
  console.log("  npx maven-proxy");
  console.log("  maven-proxy init-config");
  console.log("  maven-proxy start --mode development");
  console.log("  maven-proxy stop");
  console.log("  maven-proxy --config ~/maven-proxy/config.properties");
  console.log("  maven-proxy truststore print");
  console.log("  maven-proxy truststore merge --source ./a.jks --target ./b.jks");
  console.log("  maven-proxy doctor");
  console.log("");
  console.log("Default behavior:");
  console.log("  maven-proxy            Start in foreground; if a previous background instance exists, stop it first.");
  console.log("  maven-proxy start      Start in background and return immediately.");
}

export function parseArgs(args) {
  const options = {
    help: false,
    force: false,
    mode: "",
    configPath: "",
    command: "",
  };

  const tokens = [];

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];

    if (token === "-h" || token === "--help") {
      options.help = true;
      continue;
    }

    if (token === "--force") {
      options.force = true;
      continue;
    }

    if (token === "--mode") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("Missing value for --mode");
      }
      options.mode = value;
      index += 1;
      continue;
    }

    if (token === "--config") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("Missing value for --config");
      }
      options.configPath = value;
      index += 1;
      continue;
    }

    tokens.push(token);
  }

  options.command = tokens[0] || "";
  options.commandArgs = tokens.slice(1);

  return options;
}

function resolvePath(inputPath) {
  if (!inputPath) {
    return "";
  }

  if (inputPath.startsWith("~/")) {
    return path.join(os.homedir(), inputPath.slice(2));
  }

  return path.isAbsolute(inputPath) ? inputPath : path.resolve(process.cwd(), inputPath);
}

function getDefaultConfigTemplate() {
  const lines = [
    "# Maven Proxy default user config",
    "# Maven Proxy 用户模式默认配置",
    "# This file is loaded by default in user mode.",
    "",
  ];

  const appendEntry = (key, value, zhComment, enComment) => {
    lines.push(`# 中文: ${zhComment}`);
    lines.push(`# English: ${enComment}`);
    lines.push(`${key}=${value}`);
    lines.push("");
  };

  appendEntry("PROXY_PORT", "8080", "代理服务端口，默认 8080。", "Proxy service port. Default: 8080.");
  appendEntry("REPO_PORT", "8081", "本地仓库服务端口，默认 8081。", "Local repository service port. Default: 8081.");
  appendEntry("CACHE_DIR", "data/cache", "缓存根目录，默认 data/cache。", "Cache root directory. Default: data/cache.");
  appendEntry("CACHE_CLEANUP_ENABLED", "true", "是否启用自动缓存清理，默认 true。", "Enable automatic cache cleanup. Default: true.");
  appendEntry("CACHE_CLEANUP_DAILY_AT", "03:00", "每日固定检查时间（本地时区，HH:mm），默认 03:00。", "Fixed daily check time in local timezone (HH:mm). Default: 03:00.");
  appendEntry("CACHE_CLEANUP_CHECK_MIN_INTERVAL", "10m", "压力检测最小间隔（支持 s/m/h/d），默认 10m。", "Minimum interval for pressure checks (supports s/m/h/d). Default: 10m.");
  appendEntry("CACHE_TOUCH_ON_HIT", "true", "缓存命中返回时是否更新文件 mtime，默认 true。", "Update file mtime when serving cache hit. Default: true.");
  appendEntry("CACHE_TOUCH_MIN_INTERVAL", "1d", "同一文件两次 touch 最小间隔（支持 s/m/h/d），默认 1d。", "Minimum interval between touches for the same file (supports s/m/h/d). Default: 1d.");
  appendEntry("CACHE_RETENTION_START", "10d", "清理轮次初始保留窗口（支持 s/m/h/d），默认 10d。", "Initial retention window for cleanup cycle (supports s/m/h/d). Default: 10d.");
  appendEntry("CACHE_RETENTION_MIN", "1d", "清理轮次最小保留窗口（支持 s/m/h/d），默认 1d。", "Minimum retention window for cleanup cycle (supports s/m/h/d). Default: 1d.");
  appendEntry("CACHE_DISK_FREE_TRIGGER", "20G", "磁盘剩余空间低于该值触发清理（支持 K/M/G/T），默认 20G。", "Trigger cleanup when free disk space is below this value (supports K/M/G/T). Default: 20G.");
  appendEntry("CACHE_DISK_FREE_TARGET", "25G", "磁盘剩余空间恢复到该值可停止清理（支持 K/M/G/T），默认 25G。", "Stop cleanup when free disk space recovers to this value (supports K/M/G/T). Default: 25G.");
  appendEntry("CACHE_MAX_SIZE", "", "可选：缓存总大小触发阈值（支持 K/M/G/T），默认空（禁用）。", "Optional: cache total size trigger threshold (supports K/M/G/T). Default: empty (disabled).");
  appendEntry("CACHE_TARGET_SIZE", "", "可选：缓存总大小回落目标（支持 K/M/G/T），默认空（禁用）。", "Optional: cache size recovery target (supports K/M/G/T). Default: empty (disabled).");
  appendEntry(
    "REPO_FALLBACK_REPOS",
    "https://repo1.maven.org/maven2,https://jitpack.io,https://plugins.gradle.org/m2,https://dl.google.com",
    "缓存未命中时回源仓库列表（逗号分隔）。",
    "Fallback repository list when cache misses (comma-separated).",
  );
  appendEntry("ENABLE_HTTPS_PROXY", "true", "是否启用 HTTPS 代理处理（true/false），默认 true。", "Enable HTTPS proxy handling (true/false). Default: true.");
  appendEntry("HTTPS_MITM_DOMAINS", "repo1.maven.org,repo.maven.apache.org,registry.npmjs.org", "执行 MITM 证书签发的域名列表（逗号分隔，支持通配符）。", "Domains for MITM certificate issuance (comma-separated, wildcard supported).");
  appendEntry("HTTPS_PASSTHROUGH_FOR_UNMATCHED", "false", "未命中 MITM 域名时是否允许隧道透传，默认 false。", "Allow tunnel passthrough for unmatched MITM domains. Default: false.");
  appendEntry("NPM_REGISTRY_DOMAINS", "registry.npmjs.org,registry.npmmirror.com,npm.pkg.github.com", "识别为 npm 生态并分流缓存的域名列表（支持通配符）。", "Domains recognized as npm ecosystem for cache routing (wildcard supported).");
  appendEntry("MAVEN_REPO_DOMAINS", "repo1.maven.org,repo.maven.apache.org,jitpack.io,plugins.gradle.org,dl.google.com", "识别为 Maven 生态并分流缓存的域名列表（支持通配符）。", "Domains recognized as Maven ecosystem for cache routing (wildcard supported).");
  appendEntry("MAVEN_CACHE_USE_DOMAIN_DIR", "false", "Maven 缓存是否按域名作为一级目录，默认 false。", "Whether Maven cache uses hostname as the first-level directory. Default: false.");
  appendEntry("MAVEN_CACHE_IGNORE_PATH_PREFIXES", "repo1.maven.org/maven2,repo.maven.apache.org/maven2,jitpack.io/,plugins.gradle.org/m2,dl.google.com/dl/android/maven2,dl.google.com/dl/google/maven", "Maven 缓存应忽略的路径前缀规则（逗号分隔，支持 host/path 与 host:port/path）。", "Maven cache path-prefix ignore rules (comma-separated, supports host/path and host:port/path).");
  appendEntry("MULTI_THREAD_DOMAINS", "repo1.maven.org", "启用多线程下载的域名列表（支持通配符）。", "Domains that enable multi-thread download (wildcard supported).");
  appendEntry("MULTI_THREAD_COUNT", "8", "多线程下载线程数，默认 8。", "Thread count for multi-thread download. Default: 8.");
  appendEntry("MULTI_THREAD_MIN_SIZE_MB", "1M", "触发多线程下载的最小文件大小阈值（支持 K/M/G/T，例如 1M 或 512K），默认 1M。", "Minimum file size threshold to trigger multi-thread download (supports K/M/G/T, e.g. 1M or 512K). Default: 1M.");
  appendEntry("DOWNLOAD_TIMEOUT", "60s", "上游请求超时时间（支持 s/m/h/d），默认 60s。", "Upstream request timeout (supports s/m/h/d). Default: 60s.");
  appendEntry("DOWNLOAD_LOG_DIR", "data/logs/downloads", "统一主日志与错误日志目录。", "Unified main and error log directory.");
  appendEntry("LOG_RETENTION", "7d", "日志保留时长（支持 s/m/h/d），默认 7d。", "Log retention duration (supports s/m/h/d). Default: 7d.");
  appendEntry("LOG_TO_STDOUT", "false", "是否输出运行期日志到命令行，默认 false。", "Output runtime logs to stdout. Default: false.");
  appendEntry("LOG_CONNECT_EVENTS", "false", "是否输出详细 CONNECT/MITM 握手日志，默认 false。", "Output detailed CONNECT/MITM handshake logs. Default: false.");
  appendEntry("OUTBOUND_KEEP_ALIVE", "true", "是否启用出站 keep-alive 连接复用池，默认 true。", "Enable outbound keep-alive connection pool. Default: true.");
  appendEntry("OUTBOUND_KEEP_ALIVE_INTERVAL", "1s", "keep-alive 间隔（支持 s/m/h/d），默认 1s。", "Keep-alive interval (supports s/m/h/d). Default: 1s.");
  appendEntry("OUTBOUND_MAX_SOCKETS", "64", "每个源站最大出站连接数，默认 64。", "Maximum outbound sockets per upstream host. Default: 64.");
  appendEntry("OUTBOUND_MAX_FREE_SOCKETS", "16", "每个源站可保留空闲连接上限，默认 16。", "Maximum free outbound sockets kept per upstream host. Default: 16.");
  appendEntry("MAVEN_NEGATIVE_ENABLED", "true", "是否启用 Maven negative 索引，默认 true。", "Enable Maven negative index. Default: true.");
  appendEntry("MAVEN_NEGATIVE_INDEX_DIR", "data/index", "Maven negative 索引目录，默认 data/index。", "Maven negative index directory. Default: data/index.");
  appendEntry("MAVEN_NEGATIVE_CACHE_TTL", "24h", "负缓存 TTL（支持 s/m/h/d），默认 24h。", "Negative cache TTL (supports s/m/h/d). Default: 24h.");
  appendEntry("MAVEN_NEGATIVE_FLUSH_INTERVAL", "5s", "negative 事件日志 flush 周期（支持 s/m/h/d），默认 5s。", "Negative event log flush interval (supports s/m/h/d). Default: 5s.");
  appendEntry("MAVEN_NEGATIVE_EVENT_MAX_MB", "8M", "negative 事件日志压缩阈值（支持 K/M/G/T，例如 8M 或 8192K），默认 8M。", "Negative event log compaction threshold (supports K/M/G/T, e.g. 8M or 8192K). Default: 8M.");
  appendEntry("UPSTREAM_PROXY_URL", "", "通用上级代理地址（HTTP/HTTPS 兜底）。", "Generic upstream proxy URL fallback for HTTP/HTTPS.");
  appendEntry("UPSTREAM_HTTP_PROXY_URL", "", "HTTP 请求使用的上级代理地址。", "Upstream proxy URL for HTTP requests.");
  appendEntry("UPSTREAM_HTTPS_PROXY_URL", "", "HTTPS 请求使用的上级代理地址。", "Upstream proxy URL for HTTPS requests.");
  appendEntry("UPSTREAM_NO_PROXY", "127.0.0.1,localhost", "不走上级代理的域名列表（逗号分隔，支持通配符，* 表示全部直连）。", "Domains that bypass upstream proxy (comma-separated, wildcard supported, * means direct for all).");
  appendEntry("UPSTREAM_IGNORE_DOMAINS", "", "额外忽略上级代理的域名列表（支持通配符）。", "Additional domains ignored by upstream proxy (wildcard supported).");
  appendEntry("CERT_DIR", "data/certs", "证书根目录，默认 data/certs。", "Certificate root directory. Default: data/certs.");
  appendEntry("ROOT_CERT_PATH", "data/certs/root-ca.crt", "Root CA 证书路径。", "Root CA certificate path.");
  appendEntry("ROOT_KEY_PATH", "data/certs/root-ca.key.pem", "Root CA 私钥路径。", "Root CA private key path.");
  appendEntry("LEAF_CERT_DIR", "data/certs/leaf", "站点叶子证书目录。", "Leaf certificate directory.");
  appendEntry("TRUST_STORE_PATH", "data/certs/proxy-truststore.jks", "Java trust store 文件路径。", "Java trust store file path.");
  appendEntry("TRUST_STORE_ALIAS", "maven-proxy-root-ca", "导入 Root CA 到 trust store 时使用的别名。", "Alias used to import Root CA into trust store.");
  appendEntry("TRUST_STORE_PASSWORD", "changeit", "trust store 密码。", "Trust store password.");
  appendEntry("EXISTING_TRUST_STORE_PATH", "", "已有 truststore 路径（可选），初始化时可作为源。", "Existing truststore path (optional), used as source during init.");
  appendEntry("EXISTING_TRUST_STORE_PASSWORD", "", "已有 truststore 密码（可选），用于读取 EXISTING_TRUST_STORE_PATH。", "Existing truststore password (optional), used to read EXISTING_TRUST_STORE_PATH.");
  appendEntry("JAVA_HOME", "", "Java 安装路径；为空或无效时会自动探测。", "Java installation path; auto-detected when empty or invalid.");

  return `${lines.join("\n").trimEnd()}\n`;
}

async function initConfigFile(configFile, force = false) {
  await fs.promises.mkdir(path.dirname(configFile), { recursive: true });

  if (fs.existsSync(configFile) && !force) {
    console.log(`[maven-proxy] config already exists: ${configFile}`);
    console.log("[maven-proxy] use --force to overwrite");
    return;
  }

  await fs.promises.writeFile(configFile, getDefaultConfigTemplate(), "utf8");
  console.log(`[maven-proxy] config written: ${configFile}`);
}

async function ensureAutoConfigIfNeeded(options, command) {
  if (!["start", "doctor", "truststore"].includes(command)) {
    return;
  }

  if (options.configPath) {
    return;
  }

  const mode = resolveEffectiveMode(options);
  if (mode !== "user") {
    return;
  }

  if (fs.existsSync(defaultConfigFile)) {
    return;
  }

  console.log(`[maven-proxy] user config not found, auto creating: ${defaultConfigFile}`);
  await initConfigFile(defaultConfigFile, false);
}

async function runServerInCurrentProcess(options) {
  applyConfigOverrides(options);

  await import("../src/index.js");
}

export function resolveCliCommand(options) {
  return options.command || defaultForegroundCommand;
}

function parsePid(rawText) {
  const pid = Number.parseInt(String(rawText || "").trim(), 10);
  return Number.isFinite(pid) && pid > 0 ? pid : 0;
}

function readDaemonPidState() {
  if (!fs.existsSync(daemonPidFile)) {
    return {
      exists: false,
      pid: 0,
    };
  }

  try {
    const text = fs.readFileSync(daemonPidFile, "utf8");
    return {
      exists: true,
      pid: parsePid(text),
    };
  } catch {
    return {
      exists: true,
      pid: 0,
    };
  }
}

function readDaemonPid() {
  return readDaemonPidState().pid;
}

function isProcessRunning(pid) {
  if (!pid) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && error.code === "EPERM") {
      return true;
    }
    return false;
  }
}

async function removeDaemonPidFile() {
  await fs.promises.rm(daemonPidFile, { force: true });
}

function trySignalProcess(pid, signal) {
  try {
    process.kill(pid, signal);
    return {
      ok: true,
      missing: false,
    };
  } catch (error) {
    if (error?.code === "ESRCH") {
      return {
        ok: false,
        missing: true,
      };
    }
    throw error;
  }
}

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForProcessExit(pid, timeoutMs = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!isProcessRunning(pid)) {
      return true;
    }
    await waitMs(100);
  }

  return !isProcessRunning(pid);
}

async function startServer(options) {
  await fs.promises.mkdir(defaultConfigDir, { recursive: true });

  const existingPid = readDaemonPid();
  if (existingPid && isProcessRunning(existingPid)) {
    console.log(`[maven-proxy] already running (pid=${existingPid})`);
    console.log(`[maven-proxy] pid file: ${daemonPidFile}`);
    return;
  }

  if (existingPid && !isProcessRunning(existingPid)) {
    await removeDaemonPidFile();
  }

  const childEnv = {
    ...process.env,
    MAVEN_PROXY_CONFIG_MODE: resolveEffectiveMode(options),
  };

  if (options.configPath) {
    childEnv.MAVEN_PROXY_CONFIG_FILE = resolvePath(options.configPath);
  } else {
    delete childEnv.MAVEN_PROXY_CONFIG_FILE;
  }

  const child = spawn(
    process.execPath,
    [cliFilePath, internalRunCommand, "--mode", resolveEffectiveMode(options)],
    {
      cwd: process.cwd(),
      detached: true,
      stdio: "ignore",
      env: childEnv,
    },
  );

  child.unref();
  await fs.promises.writeFile(daemonPidFile, `${child.pid}\n`, "utf8");

  await waitMs(300);
  if (!isProcessRunning(child.pid)) {
    await removeDaemonPidFile();
    throw new Error("start failed: process exited immediately, check app/error logs");
  }

  console.log(`[maven-proxy] started in background (pid=${child.pid})`);
  console.log(`[maven-proxy] pid file: ${daemonPidFile}`);
}

async function restartIntoForeground(options) {
  await fs.promises.mkdir(defaultConfigDir, { recursive: true });

  const existingPid = readDaemonPid();
  if (existingPid && isProcessRunning(existingPid)) {
    console.log(`[maven-proxy] replacing existing background process (pid=${existingPid})`);
    await stopServer(options);
  } else if (existingPid) {
    await removeDaemonPidFile();
  }

  await runServerInCurrentProcess(options);
}

async function stopServer(options) {
  const pidState = readDaemonPidState();
  if (!pidState.exists) {
    console.log("[maven-proxy] not running (pid file not found)");
    return;
  }

  const pid = pidState.pid;
  if (!pid) {
    await removeDaemonPidFile();
    console.log(`[maven-proxy] stale pid file removed: ${daemonPidFile}`);
    return;
  }

  if (!isProcessRunning(pid)) {
    await removeDaemonPidFile();
    console.log(`[maven-proxy] stale pid removed: ${pid}`);
    return;
  }

  const sigtermResult = trySignalProcess(pid, "SIGTERM");
  if (sigtermResult.missing) {
    await removeDaemonPidFile();
    console.log(`[maven-proxy] stale pid removed: ${pid}`);
    return;
  }

  const stopped = await waitForProcessExit(pid, 5000);
  if (!stopped) {
    const sigkillResult = trySignalProcess(pid, "SIGKILL");
    if (sigkillResult.missing) {
      await removeDaemonPidFile();
      console.log(`[maven-proxy] stale pid removed: ${pid}`);
      return;
    }

    const forceStopped = await waitForProcessExit(pid, 2000);
    if (!forceStopped) {
      throw new Error(`stop failed: unable to terminate pid ${pid}`);
    }
  }

  await removeDaemonPidFile();
  console.log(`[maven-proxy] stopped (pid=${pid})`);
  if (options.configPath) {
    console.log(`[maven-proxy] stop requested with config: ${resolvePath(options.configPath)}`);
  }
}

function applyConfigOverrides(options) {
  process.env.MAVEN_PROXY_CONFIG_MODE = resolveEffectiveMode(options);

  if (options.configPath) {
    process.env.MAVEN_PROXY_CONFIG_FILE = resolvePath(options.configPath);
  }
}

function checkKeytool() {
  const result = spawnSync("keytool", ["-help"], {
    shell: false,
    encoding: "utf8",
  });

  if (result.error) {
    return {
      ok: false,
      message: result.error.message,
    };
  }

  if (result.status !== 0) {
    return {
      ok: false,
      message: (result.stderr || "").trim() || "keytool returned non-zero status",
    };
  }

  return {
    ok: true,
    message: "keytool available",
  };
}

function checkPathExists(filePath) {
  try {
    const stats = fs.statSync(filePath);
    return {
      ok: true,
      isFile: stats.isFile(),
      isDirectory: stats.isDirectory(),
    };
  } catch {
    return {
      ok: false,
      isFile: false,
      isDirectory: false,
    };
  }
}

async function canBindPort(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", (error) => {
      if (error && error.code === "EADDRINUSE") {
        resolve({ ok: false, message: "in use" });
      } else {
        resolve({ ok: false, message: error?.message || "bind failed" });
      }
    });

    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve({ ok: true, message: "available" }));
    });
  });
}

function printDoctorLine(level, title, detail) {
  console.log(`[${level}] ${title}: ${detail}`);
}

async function runDoctor(options) {
  applyConfigOverrides(options);

  const { config } = await import("../src/config/config.js");

  const failures = [];
  const warnings = [];

  console.log("[doctor] start");
  printDoctorLine("INFO", "config mode", config.configMode);
  printDoctorLine("INFO", "config base", config.configBaseDir);

  if (config.loadedConfigFile) {
    printDoctorLine("PASS", "config file", config.loadedConfigFile);
  } else if (config.configMode === "user") {
    warnings.push("user config file missing");
    printDoctorLine("WARN", "config file", `not found, expected ${config.defaultUserConfigPath}`);
  } else {
    warnings.push("development config file missing");
    printDoctorLine("WARN", "config file", "no config.properties loaded, using defaults");
  }

  const keytool = checkKeytool();
  if (keytool.ok) {
    printDoctorLine("PASS", "keytool", keytool.message);
  } else {
    failures.push("keytool unavailable");
    printDoctorLine("FAIL", "keytool", keytool.message);
  }

  printDoctorLine("INFO", "JAVA_HOME source", config.javaHomeSource || "unknown");
  if (config.javaHomeSource === "auto-fallback" && config.javaHomeConfigured) {
    warnings.push("configured JAVA_HOME invalid, auto fallback used");
    printDoctorLine("WARN", "JAVA_HOME configured", `invalid: ${config.javaHomeConfigured}`);
  }

  if (config.javaHome) {
    const javaHomeExists = checkPathExists(config.javaHome).ok;
    if (javaHomeExists) {
      printDoctorLine("PASS", "JAVA_HOME", config.javaHome);
      const cacertsPath = path.join(config.javaHome, "lib", "security", "cacerts");
      const cacerts = checkPathExists(cacertsPath);
      if (cacerts.ok && cacerts.isFile) {
        printDoctorLine("PASS", "cacerts", cacertsPath);
      } else {
        warnings.push("cacerts missing");
        printDoctorLine("WARN", "cacerts", `not found: ${cacertsPath}`);
      }
    } else {
      warnings.push("JAVA_HOME path missing");
      printDoctorLine("WARN", "JAVA_HOME", `path not found: ${config.javaHome}`);
    }
  } else {
    warnings.push("JAVA_HOME not configured");
    printDoctorLine("WARN", "JAVA_HOME", "not configured");
  }

  const rootCert = checkPathExists(config.rootCertPath);
  if (rootCert.ok && rootCert.isFile) {
    printDoctorLine("PASS", "root cert", config.rootCertPath);
  } else {
    warnings.push("root cert missing");
    printDoctorLine("WARN", "root cert", `not found: ${config.rootCertPath}`);
  }

  const rootKey = checkPathExists(config.rootKeyPath);
  if (rootKey.ok && rootKey.isFile) {
    printDoctorLine("PASS", "root key", config.rootKeyPath);
  } else {
    warnings.push("root key missing");
    printDoctorLine("WARN", "root key", `not found: ${config.rootKeyPath}`);
  }

  const trustStore = checkPathExists(config.trustStorePath);
  if (trustStore.ok && trustStore.isFile) {
    printDoctorLine("PASS", "trust store", config.trustStorePath);
  } else {
    warnings.push("trust store missing");
    printDoctorLine("WARN", "trust store", `not found: ${config.trustStorePath}`);
  }

  if (config.existingTrustStorePath) {
    const existingTrustStore = checkPathExists(config.existingTrustStorePath);
    if (existingTrustStore.ok && existingTrustStore.isFile) {
      printDoctorLine("PASS", "existing trust store source", config.existingTrustStorePath);
    } else {
      warnings.push("existing trust store source missing");
      printDoctorLine("WARN", "existing trust store source", `not found: ${config.existingTrustStorePath}`);
    }
  }

  const dirs = [
    ["cache dir", config.cacheDir],
    ["cert dir", config.certDir],
    ["log dir", config.downloadLogDir],
  ];

  for (const [name, dirPath] of dirs) {
    try {
      await fs.promises.mkdir(dirPath, { recursive: true });
      printDoctorLine("PASS", name, dirPath);
    } catch (error) {
      failures.push(`${name} create failed`);
      printDoctorLine("FAIL", name, error.message);
    }
  }

  const proxyPort = await canBindPort(config.proxyPort);
  if (proxyPort.ok) {
    printDoctorLine("PASS", "proxy port", `${config.proxyPort} available`);
  } else {
    failures.push("proxy port unavailable");
    printDoctorLine("FAIL", "proxy port", `${config.proxyPort} ${proxyPort.message}`);
  }

  const repoPort = await canBindPort(config.repoPort);
  if (repoPort.ok) {
    printDoctorLine("PASS", "repo port", `${config.repoPort} available`);
  } else {
    failures.push("repo port unavailable");
    printDoctorLine("FAIL", "repo port", `${config.repoPort} ${repoPort.message}`);
  }

  if (failures.length > 0) {
    console.log(`[doctor] done with failures=${failures.length} warnings=${warnings.length}`);
    process.exitCode = 2;
    return;
  }

  if (warnings.length > 0) {
    console.log(`[doctor] done with warnings=${warnings.length}`);
    return;
  }

  console.log("[doctor] all checks passed");
}

function printTruststoreUsage() {
  console.log("Usage:");
  console.log("  maven-proxy truststore print");
  console.log("  maven-proxy truststore init");
  console.log(
    "  maven-proxy truststore merge --source <path> --target <path> [--source-pass <pwd>] [--target-pass <pwd>] [--source-type <JKS|PKCS12>] [--target-type <JKS|PKCS12>] [--on-conflict <fail|overwrite>] [--dry-run]",
  );
}

function parseCliOptions(args) {
  const parsed = {};

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (!token.startsWith("--")) {
      continue;
    }

    const key = token.slice(2);

    if (key === "dry-run") {
      parsed[key] = true;
      continue;
    }

    const value = args[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for option: --${key}`);
    }

    parsed[key] = value;
    i += 1;
  }

  return parsed;
}

async function runTruststore(options) {
  const action = options.commandArgs[0] || "print";
  const args = options.commandArgs.slice(1);

  if (action === "--help" || action === "-h") {
    printTruststoreUsage();
    return;
  }

  if (args.includes("--help") || args.includes("-h")) {
    printTruststoreUsage();
    return;
  }

  applyConfigOverrides(options);

  const [{ config }, trustUtils] = await Promise.all([
    import("../src/config/config.js"),
    import("../src/cert/truststore-utils.js"),
  ]);

  const {
    getTrustStoreCommands,
    initTrustStore,
    mergeTrustStores,
  } = trustUtils;

  if (action === "init") {
    initTrustStore(config);
    console.log("Trust store initialized.");
    return;
  }

  if (action === "merge") {
    const parsed = parseCliOptions(args);
    if (!parsed.source || !parsed.target) {
      throw new Error("truststore merge requires --source and --target");
    }

    const mergeResult = mergeTrustStores({
      sourcePath: parsed.source,
      targetPath: parsed.target,
      sourcePassword: parsed["source-pass"] || config.trustStorePassword,
      targetPassword: parsed["target-pass"] || config.trustStorePassword,
      sourceType: (parsed["source-type"] || "JKS").toUpperCase(),
      targetType: (parsed["target-type"] || "JKS").toUpperCase(),
      onConflict: (parsed["on-conflict"] || "fail").toLowerCase(),
      dryRun: Boolean(parsed["dry-run"]),
    });

    if (mergeResult?.dryRun) {
      console.log("Dry run passed: merge validation completed, no changes were made.");
    } else {
      console.log("Trust stores merged successfully.");
    }
    return;
  }

  if (action !== "print") {
    printTruststoreUsage();
    throw new Error(`Unknown truststore action: ${action}`);
  }

  const commands = getTrustStoreCommands(config);
  console.log("Trust store commands:");
  console.log(commands.copyCmd);
  console.log(commands.importCmd);
  console.log(commands.listCmd);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    if (options.command === "truststore") {
      printTruststoreUsage();
      return;
    }
    printHelp();
    return;
  }

  const command = resolveCliCommand(options);
  const configFile = resolvePath(options.configPath) || defaultConfigFile;

  await ensureAutoConfigIfNeeded(options, command === defaultForegroundCommand ? "start" : command);

  if (command === "init-config") {
    if (options.commandArgs.length > 0) {
      throw new Error(`Unknown argument for init-config: ${options.commandArgs[0]}`);
    }
    await initConfigFile(configFile, options.force);
    return;
  }

  if (command === "truststore") {
    await runTruststore(options);
    return;
  }

  if (command === "doctor") {
    if (options.commandArgs.length > 0) {
      throw new Error(`Unknown argument for doctor: ${options.commandArgs[0]}`);
    }
    await runDoctor(options);
    return;
  }

  if (command === "stop") {
    if (options.commandArgs.length > 0) {
      throw new Error(`Unknown argument for stop: ${options.commandArgs[0]}`);
    }
    await stopServer(options);
    return;
  }

  if (command === "start") {
    if (options.commandArgs.length > 0) {
      throw new Error(`Unknown argument for start: ${options.commandArgs[0]}`);
    }
    await startServer(options);
    return;
  }

  if (command === defaultForegroundCommand) {
    if (options.commandArgs.length > 0) {
      throw new Error(`Unknown argument for default start: ${options.commandArgs[0]}`);
    }
    await restartIntoForeground(options);
    return;
  }

  if (command === internalRunCommand) {
    if (options.commandArgs.length > 0) {
      throw new Error(`Unknown argument for ${internalRunCommand}: ${options.commandArgs[0]}`);
    }
    await runServerInCurrentProcess(options);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

function isEntrypoint() {
  if (!process.argv[1]) {
    return false;
  }

  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(cliFilePath);
  } catch {
    // If realpathSync fails (e.g. path does not exist), fall back to string compare.
    return path.resolve(process.argv[1]) === cliFilePath;
  }
}

if (isEntrypoint()) {
  main().catch((error) => {
    console.error(`[maven-proxy] ${error.message}`);
    process.exit(1);
  });
}
