import util from "node:util";
import { DailyLogFile } from "./daily-log-file.js";

const MIRROR_INSTALLED = Symbol.for("maven-proxy.console-log-file.installed");
const GLOBAL_ERROR_HOOK_INSTALLED = Symbol.for("maven-proxy.global-error-hook.installed");

function mirrorConsoleMethod({
  level,
  originalMethod,
  appLogFile,
  errorLogFile,
  outputToConsole,
}) {
  return (...args) => {
    const time = new Date().toLocaleString();
    if (outputToConsole) {
      originalMethod(`[${time}]`,...args);
    }

    const line = `[${time}] [${level}] ${util.format(...args)}`;
    appLogFile.appendLine(line).catch((error) => {
      process.stderr.write(`[maven-proxy] write console log failed: ${error.message}\n`);
    });

    if (level === "ERROR") {
      errorLogFile.appendLine(line).catch((error) => {
        process.stderr.write(`[maven-proxy] write error log failed: ${error.message}\n`);
      });
    }
  };
}

export function installConsoleLogFileMirror({
  logDir,
  retentionDays = 7,
  outputToConsole = true,
}) {
  if (globalThis[MIRROR_INSTALLED]) {
    return;
  }
  globalThis[MIRROR_INSTALLED] = true;

  const appLogFile = new DailyLogFile({
    logDir,
    filePrefix: "app",
    retentionDays,
  });

  const errorLogFile = new DailyLogFile({
    logDir,
    filePrefix: "error",
    retentionDays,
  });

  console.log = mirrorConsoleMethod({
    level: "INFO",
    originalMethod: console.log.bind(console),
    appLogFile,
    errorLogFile,
    outputToConsole,
  });

  console.warn = mirrorConsoleMethod({
    level: "WARN",
    originalMethod: console.warn.bind(console),
    appLogFile,
    errorLogFile,
    outputToConsole,
  });

  console.error = mirrorConsoleMethod({
    level: "ERROR",
    originalMethod: console.error.bind(console),
    appLogFile,
    errorLogFile,
    outputToConsole,
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
