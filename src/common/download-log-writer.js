import { DailyLogFile } from "./daily-log-file.js";

export class DownloadLogWriter {
  constructor(logDir, retentionDays = 7) {
    this.logFile = new DailyLogFile({
      logDir,
      filePrefix: "download",
      retentionDays,
    });
  }

  async append(event, url, details = {}) {
    const record = {
      time: new Date().toISOString(),
      event,
      url,
      ...details,
    };
    await this.logFile.appendLine(JSON.stringify(record));
  }

  write(event, url, details = {}) {
    this.append(event, url, details).catch((error) => {
      console.warn(`[downloader] write download log failed: ${error.message}`);
    });
  }
}