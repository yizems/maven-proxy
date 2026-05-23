import util from "node:util";
import { DailyLogFile } from "./daily-log-file.js";

const MIRROR_INSTALLED = Symbol.for("maven-proxy.console-log-file.installed");

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

  const originalLog = console.log.bind(console);

  console.log = (...args) => {
    originalLog(...args);

    const line = `[${new Date().toISOString()}] ${util.format(...args)}`;
    logFile.appendLine(line).catch((error) => {
      process.stderr.write(`[maven-proxy] write console log failed: ${error.message}\n`);
    });
  };
}