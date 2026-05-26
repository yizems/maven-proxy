import fs from "node:fs";
import path from "node:path";
import { parseSizeToBytes } from "../common/size-utils.js";
import { parseDurationToMs, formatBytes } from "../common/format-utils.js";

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function toBool(value, fallback) {
  if (value == null || value === "") {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}



function parseDailyAt(text, fallback = { hour: 3, minute: 0 }) {
  const raw = String(text || "").trim();
  const match = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    return fallback;
  }

  const hour = Number.parseInt(match[1], 10);
  const minute = Number.parseInt(match[2], 10);

  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return fallback;
  }

  return { hour, minute };
}

async function statIfFile(filePath) {
  try {
    const stats = await fs.promises.stat(filePath);
    return stats.isFile() ? stats : null;
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function getDiskFreeBytes(targetDir) {
  if (typeof fs.promises.statfs !== "function") {
    return Number.POSITIVE_INFINITY;
  }

  const info = await fs.promises.statfs(targetDir);
  return Number(info.bavail || 0) * Number(info.bsize || 0);
}

async function walkFiles(dirPath, onFile) {
  const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      await walkFiles(fullPath, onFile);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    await onFile(fullPath);
  }
}

async function getDirSizeBytes(dirPath) {
  let total = 0;

  try {
    await walkFiles(dirPath, async (filePath) => {
      const stats = await statIfFile(filePath);
      if (stats) {
        total += stats.size;
      }
    });
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  return total;
}

// parseDurationToMs and formatBytes provided by ../common/format-utils.js

export class CacheCleanupManager {
  constructor(config) {
    this.config = config;
    this.enabled = toBool(config.cacheCleanupEnabled, true);
    this.touchOnHit = toBool(config.cacheTouchOnHit, true);
    this.touchMinIntervalMs = Math.max(0, parseDurationToMs(config.cacheTouchMinInterval, DAY_MS));
    this.retentionStartDays = Math.max(1, Math.floor(parseDurationToMs(config.cacheRetentionStart, 10 * DAY_MS) / DAY_MS));
    this.retentionMinDays = Math.max(1, Math.floor(parseDurationToMs(config.cacheRetentionMin, DAY_MS) / DAY_MS));
    this.diskFreeTriggerBytes = Math.max(0, parseSizeToBytes(config.cacheDiskFreeTrigger, 20 * 1024 ** 3));
    this.diskFreeTargetBytes = Math.max(
      this.diskFreeTriggerBytes,
      parseSizeToBytes(config.cacheDiskFreeTarget, 25 * 1024 ** 3),
    );
    this.cacheMaxSizeBytes = Math.max(0, parseSizeToBytes(config.cacheMaxSize, 0));
    this.cacheTargetSizeBytes = Math.max(
      0,
      parseSizeToBytes(config.cacheTargetSize, this.cacheMaxSizeBytes || 0),
    );
    this.checkMinIntervalMs = Math.max(MINUTE_MS, parseDurationToMs(config.cacheCleanupCheckMinInterval, 10 * MINUTE_MS));
    this.dailyAt = parseDailyAt(config.cacheCleanupDailyAt, { hour: 3, minute: 0 });

    this.lastTouchAt = new Map();
    this.lastPressureCheckAt = 0;
    this.cleanupRunning = false;
    this.dailyTimer = null;
  }

  async init() {
    if (!this.enabled) {
      return;
    }

    this.#scheduleDailyCheck();
  }

  async destroy() {
    if (this.dailyTimer) {
      clearTimeout(this.dailyTimer);
      this.dailyTimer = null;
    }
  }

  touchFileOnHit(filePath) {
    if (!this.enabled || !this.touchOnHit || !filePath) {
      return;
    }

    const now = Date.now();
    const last = this.lastTouchAt.get(filePath) || 0;
    if (now - last < this.touchMinIntervalMs) {
      return;
    }

    this.lastTouchAt.set(filePath, now);

    fs.promises.utimes(filePath, new Date(now), new Date(now)).catch((error) => {
      if (error.code !== "ENOENT") {
        console.warn(`[cache-cleanup] touch failed path=${filePath} message=${error.message}`);
      }
    });
  }

  async checkAndCleanupIfNeeded(reason = "manual", force = false) {
    if (!this.enabled) {
      return { triggered: false, reason: "disabled" };
    }

    const now = Date.now();
    if (!force && now - this.lastPressureCheckAt < this.checkMinIntervalMs) {
      return { triggered: false, reason: "throttled" };
    }
    this.lastPressureCheckAt = now;

    const metrics = await this.#collectMetrics();
    const overLimit = this.#isOverLimit(metrics);

    if (!overLimit) {
      return {
        triggered: false,
        reason: "below-limit",
        metrics,
      };
    }

    return this.#runCleanup(reason, metrics);
  }

  async #runCleanup(reason, beforeMetrics) {
    if (this.cleanupRunning) {
      return { triggered: false, reason: "already-running" };
    }

    this.cleanupRunning = true;

    try {
      console.warn(
        `[cache-cleanup] start reason=${reason} free=${formatBytes(beforeMetrics.diskFreeBytes)} cache=${formatBytes(beforeMetrics.cacheSizeBytes)}`,
      );

      const rounds = [];
      const startDay = Math.max(this.retentionStartDays, this.retentionMinDays);
      const endDay = this.retentionMinDays;

      for (let day = startDay; day >= endDay; day -= 1) {
        const cutoffMs = Date.now() - (day * DAY_MS);
        const result = await this.#deleteOlderThan(cutoffMs);
        const metrics = await this.#collectMetrics();

        rounds.push({
          day,
          deletedFiles: result.deletedFiles,
          releasedBytes: result.releasedBytes,
          diskFreeBytes: metrics.diskFreeBytes,
          cacheSizeBytes: metrics.cacheSizeBytes,
        });

        console.warn(
          `[cache-cleanup] round day=${day} deleted=${result.deletedFiles} released=${formatBytes(result.releasedBytes)} free=${formatBytes(metrics.diskFreeBytes)} cache=${formatBytes(metrics.cacheSizeBytes)}`,
        );

        if (this.#meetsTarget(metrics)) {
          console.warn(`[cache-cleanup] success reason=${reason} stop-day=${day}`);
          return {
            triggered: true,
            success: true,
            stopDay: day,
            before: beforeMetrics,
            after: metrics,
            rounds,
          };
        }
      }

      const afterMetrics = await this.#collectMetrics();
      console.error(
        `[cache-cleanup] warn cannot meet target at min-day=${this.retentionMinDays} free=${formatBytes(afterMetrics.diskFreeBytes)} cache=${formatBytes(afterMetrics.cacheSizeBytes)}`,
      );

      return {
        triggered: true,
        success: false,
        stopDay: this.retentionMinDays,
        before: beforeMetrics,
        after: afterMetrics,
        rounds,
      };
    } finally {
      this.cleanupRunning = false;
    }
  }

  async #deleteOlderThan(cutoffMs) {
    let deletedFiles = 0;
    let releasedBytes = 0;

    try {
      await walkFiles(this.config.cacheDir, async (filePath) => {
        const stats = await statIfFile(filePath);
        if (!stats) {
          return;
        }

        if (stats.mtimeMs >= cutoffMs) {
          return;
        }

        try {
          await fs.promises.unlink(filePath);
          deletedFiles += 1;
          releasedBytes += stats.size;
          this.lastTouchAt.delete(filePath);
        } catch (error) {
          if (error.code !== "ENOENT") {
            console.warn(`[cache-cleanup] delete failed path=${filePath} message=${error.message}`);
          }
        }
      });
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }

    return { deletedFiles, releasedBytes };
  }

  async #collectMetrics() {
    const [diskFreeBytes, cacheSizeBytes] = await Promise.all([
      getDiskFreeBytes(this.config.cacheDir),
      getDirSizeBytes(this.config.cacheDir),
    ]);

    return { diskFreeBytes, cacheSizeBytes };
  }

  #isOverLimit(metrics) {
    const diskLow = this.diskFreeTriggerBytes > 0 && metrics.diskFreeBytes <= this.diskFreeTriggerBytes;
    const cacheOver = this.cacheMaxSizeBytes > 0 && metrics.cacheSizeBytes >= this.cacheMaxSizeBytes;
    return diskLow || cacheOver;
  }

  #meetsTarget(metrics) {
    const diskOk =
      this.diskFreeTriggerBytes <= 0 ||
      metrics.diskFreeBytes >= this.diskFreeTargetBytes;

    const cacheTarget = this.cacheTargetSizeBytes > 0 ? this.cacheTargetSizeBytes : this.cacheMaxSizeBytes;
    const cacheOk =
      this.cacheMaxSizeBytes <= 0 ||
      (cacheTarget > 0 && metrics.cacheSizeBytes <= cacheTarget);

    return diskOk && cacheOk;
  }

  #scheduleDailyCheck() {
    const now = new Date();
    const next = new Date(now);
    next.setHours(this.dailyAt.hour, this.dailyAt.minute, 0, 0);

    if (next.getTime() <= now.getTime()) {
      next.setDate(next.getDate() + 1);
    }

    const delay = Math.max(1000, next.getTime() - now.getTime());

    this.dailyTimer = setTimeout(() => {
      this.checkAndCleanupIfNeeded("daily-check", true)
        .catch((error) => {
          console.error(`[cache-cleanup] daily check failed: ${error.message}`);
        })
        .finally(() => {
          this.#scheduleDailyCheck();
        });
    }, delay);

    if (typeof this.dailyTimer.unref === "function") {
      this.dailyTimer.unref();
    }
  }
}
