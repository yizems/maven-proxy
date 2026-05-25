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
}

function parseArgs(args) {
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
  return [
    "# Maven Proxy default user config",
    "# This file is loaded by default in user mode.",
    "",
    "PROXY_PORT=8080",
    "REPO_PORT=8081",
    "CACHE_DIR=data/cache",
    "CACHE_CLEANUP_ENABLED=true",
    "CACHE_CLEANUP_DAILY_AT=03:00",
    "CACHE_CLEANUP_CHECK_MIN_INTERVAL=10m",
    "CACHE_TOUCH_ON_HIT=true",
    "CACHE_TOUCH_MIN_INTERVAL=1d",
    "CACHE_RETENTION_START=10d",
    "CACHE_RETENTION_MIN=1d",
    "CACHE_DISK_FREE_TRIGGER=20G",
    "CACHE_DISK_FREE_TARGET=25G",
    "CACHE_MAX_SIZE=",
    "CACHE_TARGET_SIZE=",
    "REPO_FALLBACK_REPOS=https://repo1.maven.org/maven2,https://jitpack.io,https://plugins.gradle.org/m2,https://maven.google.com",
    "ENABLE_HTTPS_PROXY=true",
    "HTTPS_MITM_DOMAINS=repo1.maven.org,repo.maven.apache.org,registry.npmjs.org",
    "HTTPS_PASSTHROUGH_FOR_UNMATCHED=false",
    "NPM_REGISTRY_DOMAINS=registry.npmjs.org,registry.npmmirror.com,npm.pkg.github.com",
    "MAVEN_REPO_DOMAINS=repo1.maven.org,repo.maven.apache.org,jitpack.io,plugins.gradle.org,maven.google.com",
    "MULTI_THREAD_DOMAINS=repo1.maven.org",
    "MULTI_THREAD_COUNT=8",
    "MULTI_THREAD_MIN_SIZE_MB=1",
    "DOWNLOAD_TIMEOUT=60s",
    "OUTBOUND_KEEP_ALIVE=true",
    "OUTBOUND_KEEP_ALIVE_INTERVAL=1s",
    "OUTBOUND_MAX_SOCKETS=64",
    "OUTBOUND_MAX_FREE_SOCKETS=16",
    "MAVEN_AFFINITY_ENABLED=true",
    "MAVEN_AFFINITY_INDEX_DIR=data/index",
    "MAVEN_NEGATIVE_CACHE_TTL=24h",
    "MAVEN_AFFINITY_FLUSH_INTERVAL=5s",
    "MAVEN_AFFINITY_EVENT_MAX_MB=8",
    "DOWNLOAD_LOG_DIR=data/logs/downloads",
    "LOG_RETENTION=7d",
    "LOG_TO_STDOUT=false",
    "UPSTREAM_PROXY_URL=",
    "UPSTREAM_HTTP_PROXY_URL=",
    "UPSTREAM_HTTPS_PROXY_URL=",
    "UPSTREAM_NO_PROXY=127.0.0.1,localhost",
    "UPSTREAM_IGNORE_DOMAINS=",
    "CERT_DIR=data/certs",
    "ROOT_CERT_PATH=data/certs/root-ca.crt",
    "ROOT_KEY_PATH=data/certs/root-ca.key.pem",
    "LEAF_CERT_DIR=data/certs/leaf",
    "TRUST_STORE_PATH=data/certs/proxy-truststore.jks",
    "TRUST_STORE_ALIAS=maven-proxy-root-ca",
    "TRUST_STORE_PASSWORD=changeit",
    "EXISTING_TRUST_STORE_PATH=",
    "EXISTING_TRUST_STORE_PASSWORD=",
    "JAVA_HOME=",
    "",
  ].join("\n");
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

function parsePid(rawText) {
  const pid = Number.parseInt(String(rawText || "").trim(), 10);
  return Number.isFinite(pid) && pid > 0 ? pid : 0;
}

function readDaemonPid() {
  if (!fs.existsSync(daemonPidFile)) {
    return 0;
  }

  try {
    const text = fs.readFileSync(daemonPidFile, "utf8");
    return parsePid(text);
  } catch {
    return 0;
  }
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

async function stopServer(options) {
  const pid = readDaemonPid();
  if (!pid) {
    console.log("[maven-proxy] not running (pid file not found)");
    return;
  }

  if (!isProcessRunning(pid)) {
    await removeDaemonPidFile();
    console.log(`[maven-proxy] stale pid removed: ${pid}`);
    return;
  }

  process.kill(pid, "SIGTERM");
  const stopped = await waitForProcessExit(pid, 5000);
  if (!stopped) {
    process.kill(pid, "SIGKILL");
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

  const command = options.command || "start";
  const configFile = resolvePath(options.configPath) || defaultConfigFile;

  await ensureAutoConfigIfNeeded(options, command);

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

  if (command === internalRunCommand) {
    if (options.commandArgs.length > 0) {
      throw new Error(`Unknown argument for ${internalRunCommand}: ${options.commandArgs[0]}`);
    }
    await runServerInCurrentProcess(options);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(`[maven-proxy] ${error.message}`);
  process.exit(1);
});
