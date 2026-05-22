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

function getDefaultCacertsPath(javaHome) {
  return path.join(javaHome, "lib", "security", "cacerts");
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
