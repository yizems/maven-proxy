import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

function runCommandCapture(command, args) {
  const result = spawnSync(command, args, {
    shell: false,
    encoding: "utf8",
  });

  if (result.error || result.status !== 0) {
    return "";
  }

  return String(result.stdout || "").trim();
}

function isFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isDirectory(dirPath) {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function safeRealpath(targetPath) {
  try {
    return fs.realpathSync(targetPath);
  } catch {
    return targetPath;
  }
}

function deriveJavaHomeFromJavaBin(javaBinPath) {
  const resolved = safeRealpath(javaBinPath);
  const executableName = path.basename(resolved).toLowerCase();

  if (executableName !== "java" && executableName !== "java.exe") {
    return "";
  }

  const binDir = path.dirname(resolved);
  if (path.basename(binDir).toLowerCase() !== "bin") {
    return "";
  }

  const javaHome = path.dirname(binDir);
  return isDirectory(javaHome) ? javaHome : "";
}

function normalizeConfiguredJavaHome(configured, platform) {
  if (!configured) {
    return "";
  }

  const resolved = safeRealpath(configured);
  if (isDirectory(resolved)) {
    const javaName = platform === "win32" ? "java.exe" : "java";
    if (isFile(path.join(resolved, "bin", javaName))) {
      return resolved;
    }

    if (path.basename(resolved).toLowerCase() === "bin" && isFile(path.join(resolved, javaName))) {
      return path.dirname(resolved);
    }

    return "";
  }

  if (isFile(resolved)) {
    return deriveJavaHomeFromJavaBin(resolved);
  }

  return "";
}

function detectFromJavaCommand(platform) {
  const command = platform === "win32" ? "where" : "which";
  const output = runCommandCapture(command, ["java"]);
  if (!output) {
    return "";
  }

  const firstPath = output
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .find(Boolean);

  if (!firstPath) {
    return "";
  }

  return deriveJavaHomeFromJavaBin(firstPath);
}

function detectFromMacJavaHomeCommand() {
  const output = runCommandCapture("/usr/libexec/java_home", []);
  if (!output) {
    return "";
  }

  return isDirectory(output) ? output : "";
}

function detectFromWindowsCommonPaths() {
  const roots = [
    "C:\\Program Files\\Java",
    "C:\\Program Files (x86)\\Java",
    "C:\\Program Files\\Eclipse Adoptium",
    "C:\\Program Files\\Microsoft",
    "C:\\Program Files\\Amazon Corretto",
    "C:\\Program Files\\Zulu",
  ];

  for (const root of roots) {
    if (!isDirectory(root)) {
      continue;
    }

    let children = [];
    try {
      children = fs.readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort((a, b) => b.localeCompare(a));
    } catch {
      continue;
    }

    for (const child of children) {
      const base = path.join(root, child);
      const candidates = [base, path.join(base, "jre")];
      for (const candidate of candidates) {
        if (isFile(path.join(candidate, "bin", "java.exe"))) {
          return candidate;
        }
      }
    }
  }

  return "";
}

function detectAutoJavaHome(platform) {
  if (platform === "darwin") {
    const fromMacCommand = detectFromMacJavaHomeCommand();
    if (fromMacCommand) {
      return {
        javaHome: fromMacCommand,
        source: "auto-macos-java-home",
      };
    }

    const fromCommand = detectFromJavaCommand(platform);
    if (fromCommand) {
      return {
        javaHome: fromCommand,
        source: "auto-java-command",
      };
    }

    return { javaHome: "", source: "none" };
  }

  if (platform === "win32") {
    const fromCommand = detectFromJavaCommand(platform);
    if (fromCommand) {
      return {
        javaHome: fromCommand,
        source: "auto-java-command",
      };
    }

    const fromWindowsPath = detectFromWindowsCommonPaths();
    if (fromWindowsPath) {
      return {
        javaHome: fromWindowsPath,
        source: "auto-windows-common-path",
      };
    }

    return { javaHome: "", source: "none" };
  }

  const fromCommand = detectFromJavaCommand(platform);
  if (fromCommand) {
    return {
      javaHome: fromCommand,
      source: "auto-java-command",
    };
  }

  return { javaHome: "", source: "none" };
}

export function detectJavaHome(configuredJavaHome = "", platform = os.platform()) {
  const configured = String(configuredJavaHome || "").trim();
  const normalizedConfigured = normalizeConfiguredJavaHome(configured, platform);

  if (normalizedConfigured) {
    return {
      javaHome: normalizedConfigured,
      source: "env",
      configuredJavaHome: configured,
    };
  }

  const autoDetected = detectAutoJavaHome(platform);
  if (autoDetected.javaHome) {
    return {
      javaHome: autoDetected.javaHome,
      source: configured ? "auto-fallback" : autoDetected.source,
      configuredJavaHome: configured,
    };
  }

  if (configured) {
    return {
      javaHome: configured,
      source: "env-missing",
      configuredJavaHome: configured,
    };
  }

  return {
    javaHome: "",
    source: "none",
    configuredJavaHome: "",
  };
}