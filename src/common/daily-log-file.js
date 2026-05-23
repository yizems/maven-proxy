import fs from "node:fs";
import path from "node:path";

function toDateStampLocal(date = new Date()) {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class DailyLogFile {
  constructor({ logDir, filePrefix, retentionDays = 7 }) {
    this.logDir = logDir;
    this.filePrefix = filePrefix;
    this.retentionDays = Math.max(1, Number.parseInt(retentionDays, 10) || 7);
    this.ensureDirPromise = null;
    this.lastCleanupStamp = "";
  }

  async ensureDir() {
    if (!this.ensureDirPromise) {
      this.ensureDirPromise = fs.promises.mkdir(this.logDir, { recursive: true });
    }
    await this.ensureDirPromise;
  }

  getDailyLogPath(date = new Date()) {
    return path.join(this.logDir, `${this.filePrefix}-${toDateStampLocal(date)}.log`);
  }

  async cleanupOldLogsIfNeeded(date = new Date()) {
    const todayStamp = toDateStampLocal(date);
    if (this.lastCleanupStamp === todayStamp) {
      return;
    }

    this.lastCleanupStamp = todayStamp;

    const cutoff = new Date(date);
    cutoff.setHours(0, 0, 0, 0);
    cutoff.setDate(cutoff.getDate() - (this.retentionDays - 1));
    const cutoffStamp = toDateStampLocal(cutoff);

    const pattern = new RegExp(`^${escapeRegExp(this.filePrefix)}-(\\d{4}-\\d{2}-\\d{2})\\.log$`);
    const entries = await fs.promises.readdir(this.logDir, { withFileTypes: true });

    const deleteTasks = [];
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }

      const match = entry.name.match(pattern);
      if (!match) {
        continue;
      }

      const dateStamp = match[1];
      if (dateStamp < cutoffStamp) {
        deleteTasks.push(fs.promises.unlink(path.join(this.logDir, entry.name)));
      }
    }

    if (deleteTasks.length > 0) {
      await Promise.all(deleteTasks);
    }
  }

  async appendLine(line, date = new Date()) {
    await this.ensureDir();
    await this.cleanupOldLogsIfNeeded(date);
    const content = line.endsWith("\n") ? line : `${line}\n`;
    await fs.promises.appendFile(this.getDailyLogPath(date), content, "utf8");
  }
}