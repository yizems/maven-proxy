import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

function runCommand(command, args) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: false,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(" ")}`);
  }
}

function runCommandCapture(command, args) {
  const result = spawnSync(command, args, {
    shell: false,
    encoding: "utf8",
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const stderr = (result.stderr || "").trim();
    throw new Error(
      stderr || `Command failed: ${command} ${args.join(" ")}`,
    );
  }

  return result.stdout || "";
}

function getDefaultCacertsPath(javaHome) {
  return path.join(javaHome, "lib", "security", "cacerts");
}

function parseAliasesFromListOutput(output) {
  const aliases = new Set();
  const verboseMatches = output.matchAll(/Alias name:\s*(.+)\s*$/gm);
  for (const match of verboseMatches) {
    aliases.add(match[1].trim());
  }

  if (aliases.size > 0) {
    return aliases;
  }

  // Fallback for non-verbose list format: "<alias>, <date>, <entryType>, ..."
  const listMatches = output.matchAll(/^([^,\r\n]+),\s.+$/gm);
  for (const match of listMatches) {
    aliases.add(match[1].trim());
  }

  return aliases;
}

function listTrustStoreAliases({ storePath, storePass, storeType }) {
  const output = runCommandCapture("keytool", [
    "-list",
    "-v",
    "-keystore",
    storePath,
    "-storepass",
    storePass,
    "-storetype",
    storeType,
  ]);

  return parseAliasesFromListOutput(output);
}

function validateMergeOptions(options) {
  if (!options || typeof options !== "object") {
    throw new Error("Merge options are required.");
  }

  const required = ["sourcePath", "targetPath", "sourcePassword", "targetPassword"];
  for (const key of required) {
    if (!options[key]) {
      throw new Error(`Missing required option: ${key}`);
    }
  }

  if (!fs.existsSync(options.sourcePath)) {
    throw new Error(`Source truststore not found: ${options.sourcePath}`);
  }

  const mode = options.onConflict || "fail";
  if (!["fail", "overwrite"].includes(mode)) {
    throw new Error(`Invalid onConflict mode: ${mode}. Use \"fail\" or \"overwrite\".`);
  }

  return mode;
}

export function getTrustStoreCommands(runtimeConfig) {
  const isWindows = os.platform() === "win32";
  const javaHome = runtimeConfig.javaHome || "%JAVA_HOME%";
  const defaultCacerts = isWindows
    ? `${javaHome}\\lib\\security\\cacerts`
    : `${javaHome}/lib/security/cacerts`;

  const copyCmd = isWindows
    ? `Copy-Item \"${defaultCacerts}\" \"${runtimeConfig.trustStorePath}\"`
    : `cp \"${defaultCacerts}\" \"${runtimeConfig.trustStorePath}\"`;

  const importCmd = `keytool -importcert -noprompt -trustcacerts -alias ${runtimeConfig.trustStoreAlias} -file ${runtimeConfig.rootCertPath} -keystore ${runtimeConfig.trustStorePath} -storepass ${runtimeConfig.trustStorePassword}`;
  const listCmd = `keytool -list -v -keystore ${runtimeConfig.trustStorePath} -storepass ${runtimeConfig.trustStorePassword} -alias ${runtimeConfig.trustStoreAlias}`;

  return { copyCmd, importCmd, listCmd };
}

export function initTrustStore(runtimeConfig) {
  if (!runtimeConfig || !runtimeConfig.javaHome) {
    throw new Error("JAVA_HOME is required to initialize trust store.");
  }

  const defaultCacerts = getDefaultCacertsPath(runtimeConfig.javaHome);

  if (!fs.existsSync(defaultCacerts)) {
    throw new Error(`JDK cacerts not found: ${defaultCacerts}`);
  }

  if (!fs.existsSync(runtimeConfig.rootCertPath)) {
    throw new Error(`Root certificate not found: ${runtimeConfig.rootCertPath}`);
  }

  fs.mkdirSync(path.dirname(runtimeConfig.trustStorePath), { recursive: true });

  if (!fs.existsSync(runtimeConfig.trustStorePath)) {
    fs.copyFileSync(defaultCacerts, runtimeConfig.trustStorePath);
  }

  runCommand("keytool", [
    "-importcert",
    "-noprompt",
    "-trustcacerts",
    "-alias",
    runtimeConfig.trustStoreAlias,
    "-file",
    runtimeConfig.rootCertPath,
    "-keystore",
    runtimeConfig.trustStorePath,
    "-storepass",
    runtimeConfig.trustStorePassword,
  ]);

  runCommand("keytool", [
    "-list",
    "-v",
    "-keystore",
    runtimeConfig.trustStorePath,
    "-storepass",
    runtimeConfig.trustStorePassword,
    "-alias",
    runtimeConfig.trustStoreAlias,
  ]);
}

export function mergeTrustStores(options) {
  const onConflict = validateMergeOptions(options);
  const sourceType = options.sourceType || "JKS";
  const targetType = options.targetType || "JKS";
  const dryRun = Boolean(options.dryRun);

  if (!dryRun) {
    fs.mkdirSync(path.dirname(options.targetPath), { recursive: true });
  }

  if (onConflict === "fail" && fs.existsSync(options.targetPath)) {
    const sourceAliases = listTrustStoreAliases({
      storePath: options.sourcePath,
      storePass: options.sourcePassword,
      storeType: sourceType,
    });
    const targetAliases = listTrustStoreAliases({
      storePath: options.targetPath,
      storePass: options.targetPassword,
      storeType: targetType,
    });

    const conflicts = [...sourceAliases].filter((alias) => targetAliases.has(alias));
    if (conflicts.length > 0) {
      throw new Error(
        `Alias conflict detected: ${conflicts.join(", ")}. Use --on-conflict overwrite to continue.`,
      );
    }
  }

  if (dryRun) {
    return {
      dryRun: true,
      checkedSource: options.sourcePath,
      checkedTarget: options.targetPath,
      onConflict,
      sourceType,
      targetType,
      targetExists: fs.existsSync(options.targetPath),
    };
  }

  const args = [
    "-importkeystore",
    "-srckeystore",
    options.sourcePath,
    "-srcstoretype",
    sourceType,
    "-srcstorepass",
    options.sourcePassword,
    "-destkeystore",
    options.targetPath,
    "-deststoretype",
    targetType,
    "-deststorepass",
    options.targetPassword,
  ];

  if (onConflict === "overwrite") {
    args.push("-noprompt");
  }

  runCommand("keytool", args);
}

