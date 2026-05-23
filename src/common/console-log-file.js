import util from "node:util";
import { DailyLogFile } from "./daily-log-file.js";

const MIRROR_INSTALLED = Symbol.for("maven-proxy.console-log-file.installed");
const GLOBAL_ERROR_HOOK_INSTALLED = Symbol.for("maven-proxy.global-error-hook.installed");

function mirrorConsoleMethod({ level, originalMethod, logFile }) {
  return (...args) => {
    originalMethod(...args);

    const line = `[${new Date().toISOString()}] [${level}] ${util.format(...args)}`;
    logFile.appendLine(line).catch((error) => {
      process.stderr.write(`[maven-proxy] write console log failed: ${error.message}\n`);
    });
  };
}

export function installConsoleLogFileMirror({ logDir, retentionDays = 7 }) {
  if (globalThis[MIRROR_INSTALLED]) {
    return;
  }
  globalThis[MIRROR_INSTALLED] = true;

  const logFile = new DailyLogFile({
    logDir,
    filePrefix: "console",
    retentionDays,
  });

  console.log = mirrorConsoleMethod({
    level: "INFO",
    originalMethod: console.log.bind(console),
    logFile,
  });

  console.warn = mirrorConsoleMethod({
    level: "WARN",
    originalMethod: console.warn.bind(console),
    logFile,
  });

  console.error = mirrorConsoleMethod({
    level: "ERROR",
    originalMethod: console.error.bind(console),
    logFile,
  });
}

export function installGlobalErrorLogging() {
  if (globalThis[GLOBAL_ERROR_HOOK_INSTALLED]) {
    return;
  }
  globalThis[GLOBAL_ERROR_HOOK_INSTALLED] = true;

  process.on("uncaughtExceptionMonitor", (error, origin) => {
    console.error(`[global-error] uncaughtException origin=${origin}`, error);
  });

  process.on("unhandledRejection", (reason) => {
    console.error("[global-error] unhandledRejection", reason);
  });
}