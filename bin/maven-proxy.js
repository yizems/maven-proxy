#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawnSync } from "node:child_process";

const defaultConfigDir = path.resolve(os.homedir(), "maven-proxy");
const defaultConfigFile = path.join(defaultConfigDir, "config");

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

  // CLI defaults to user mode to load ~/maven-proxy/config unless explicitly overridden.
  return "user";
}

function printHelp() {
  console.log("maven-proxy CLI");
  console.log("");
  console.log("Usage:");
  console.log("  maven-proxy");
  console.log("  maven-proxy start [--mode <development|user>] [--config <file>]");
  console.log("  maven-proxy init-config [--force] [--config <file>]");
  console.log("  maven-proxy truststore <print|init|merge> [options]");
  console.log("  maven-proxy doctor [--mode <development|user>] [--config <file>]");
  console.log("");
  console.log("Examples:");
  console.log("  npx maven-proxy");
  console.log("  maven-proxy init-config");
  console.log("  maven-proxy start --mode development");
  console.log("  maven-proxy --config ~/maven-proxy/config");
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
    "REPO_FALLBACK_REPOS=https://repo1.maven.org/maven2,https://jitpack.io,https://plugins.gradle.org/m2,https://maven.google.com",
    "ENABLE_HTTPS_PROXY=true",
    "HTTPS_MITM_DOMAINS=repo1.maven.org,repo.maven.apache.org,registry.npmjs.org",
    "HTTPS_PASSTHROUGH_FOR_UNMATCHED=true",
    "NPM_REGISTRY_DOMAINS=registry.npmjs.org,registry.npmmirror.com,npm.pkg.github.com",
    "MAVEN_REPO_DOMAINS=repo1.maven.org,repo.maven.apache.org,jitpack.io,plugins.gradle.org,maven.google.com",
    "MULTI_THREAD_DOMAINS=repo1.maven.org",
    "MULTI_THREAD_COUNT=8",
    "MULTI_THREAD_MIN_SIZE_BYTES=1048576",
    "DOWNLOAD_TIMEOUT_MS=60000",
    "DOWNLOAD_LOG_DIR=data/logs/downloads",
    "LOG_RETENTION_DAYS=7",
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

async function startServer(options) {
  applyConfigOverrides(options);

  await import("../src/index.js");
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
    printDoctorLine("WARN", "config file", "no .env/.evn loaded, using defaults");
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

  if (command === "start") {
    if (options.commandArgs.length > 0) {
      throw new Error(`Unknown argument for start: ${options.commandArgs[0]}`);
    }
    await startServer(options);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(`[maven-proxy] ${error.message}`);
  process.exit(1);
});
