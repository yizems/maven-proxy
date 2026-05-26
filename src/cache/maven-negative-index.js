import fs from "node:fs";
import path from "node:path";

function toPositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function toBool(value, fallback) {
  if (value == null || value === "") {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function nowMs() {
  return Date.now();
}

function readJsonFile(filePath, fallback) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }

  try {
    const text = fs.readFileSync(filePath, "utf8");
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function normalizeRequestPath(pathname) {
  return String(pathname || "")
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/+/, "")
    .trim();
}

function buildNegativeScope(urlObj) {
  if (!urlObj || typeof urlObj !== "object") {
    return "";
  }

  const protocol = urlObj.protocol === "https:" ? "https:" : "http:";
  const host = String(urlObj.host || "").toLowerCase();
  const pathname = normalizeRequestPath(urlObj.pathname || "");
  return `${protocol}//${host}/${pathname}`;
}

function buildNegativeKey(scope, canonicalKey) {
  return `${String(scope || "").toLowerCase()}|${canonicalKey}`;
}

function serializeSnapshot(negativeMap) {
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    negative: [...negativeMap.entries()],
  };
}

export class MavenNegativeIndex {
  constructor(config) {
    this.enabled = toBool(config.mavenNegativeEnabled, true);
    this.indexDir = config.mavenNegativeIndexDir;
    this.negativeTtlMs = toPositiveInt(config.mavenNegativeCacheTtlMs, 24 * 60 * 60 * 1000);
    this.flushIntervalMs = toPositiveInt(config.mavenNegativeFlushIntervalMs, 5000);
    this.maxEventBytes = toPositiveInt(config.mavenNegativeEventMaxBytes, 8 * 1024 * 1024);

    this.snapshotPath = path.join(this.indexDir, "maven-negative.snapshot.json");
    this.eventLogPath = path.join(this.indexDir, "maven-negative.events.log");

    this.negative = new Map();

    this.pendingEvents = [];
    this.flushTimer = null;
    this.flushing = false;
    this.dirtySinceSnapshot = false;
  }

  async init() {
    if (!this.enabled) {
      return;
    }

    await fs.promises.mkdir(this.indexDir, { recursive: true });
    this.#loadSnapshot();
    this.#replayEventLog();

    this.flushTimer = setInterval(() => {
      this.flush().catch((error) => {
        console.error(`[maven-negative] flush failed: ${error.message}`);
      });
    }, this.flushIntervalMs);

    if (typeof this.flushTimer.unref === "function") {
      this.flushTimer.unref();
    }
  }

  #loadSnapshot() {
    const snapshot = readJsonFile(this.snapshotPath, null);
    if (!snapshot || typeof snapshot !== "object") {
      return;
    }

    const currentTime = nowMs();
    for (const [key, value] of snapshot.negative || []) {
      if (value?.expireAt && value.expireAt > currentTime) {
        this.negative.set(key, value);
      }
    }
  }

  #replayEventLog() {
    if (!fs.existsSync(this.eventLogPath)) {
      return;
    }

    let raw = "";
    try {
      raw = fs.readFileSync(this.eventLogPath, "utf8");
    } catch {
      return;
    }

    const lines = raw.split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        this.#applyEvent(event, false);
      } catch {
        // ignore invalid line
      }
    }
  }

  #enqueueEvent(type, payload) {
    this.pendingEvents.push(JSON.stringify({ t: nowMs(), type, payload }));
    this.dirtySinceSnapshot = true;
  }

  #applyEvent(event, append = true) {
    if (!event || typeof event !== "object") {
      return;
    }

    const { type, payload } = event;
    if (!type || !payload || typeof payload !== "object") {
      return;
    }

    if (type === "negative_upsert") {
      if (payload.value?.expireAt > nowMs()) {
        this.negative.set(payload.key, payload.value);
      } else {
        this.negative.delete(payload.key);
      }
      if (append) {
        this.#enqueueEvent(type, payload);
      }
      return;
    }

    if (type === "negative_remove") {
      this.negative.delete(payload.key);
      if (append) {
        this.#enqueueEvent(type, payload);
      }
      return;
    }
  }

  shouldSkipRequest(canonicalKey, urlObj) {
    const scope = buildNegativeScope(urlObj);
    if (!this.enabled || !canonicalKey || !scope) {
      return false;
    }

    const key = buildNegativeKey(scope, canonicalKey);
    const entry = this.negative.get(key);
    if (!entry) {
      return false;
    }

    if (entry.expireAt <= nowMs()) {
      this.#applyEvent({
        type: "negative_remove",
        payload: { key },
      });
      return false;
    }

    return true;
  }

  recordNegative({ canonicalKey, urlObj, statusCode = 404, ttlMs = this.negativeTtlMs }) {
    const scope = buildNegativeScope(urlObj);
    if (!this.enabled || !canonicalKey || !scope) {
      return;
    }

    const expireAt = nowMs() + toPositiveInt(ttlMs, this.negativeTtlMs);
    const key = buildNegativeKey(scope, canonicalKey);
    this.#applyEvent({
      type: "negative_upsert",
      payload: {
        key,
        value: {
          scope,
          statusCode,
          expireAt,
          updatedAt: nowMs(),
        },
      },
    });
  }

  clearNegative({ canonicalKey, urlObj }) {
    const scope = buildNegativeScope(urlObj);
    if (!this.enabled || !canonicalKey || !scope) {
      return;
    }

    const key = buildNegativeKey(scope, canonicalKey);
    this.#applyEvent({ type: "negative_remove", payload: { key } });
  }

  async flush() {
    if (!this.enabled || this.flushing) {
      return;
    }

    this.flushing = true;
    try {
      if (this.pendingEvents.length > 0) {
        const text = `${this.pendingEvents.join("\n")}\n`;
        this.pendingEvents = [];
        await fs.promises.appendFile(this.eventLogPath, text, "utf8");
      }

      const stats = await fs.promises.stat(this.eventLogPath).catch(() => null);
      const needsSnapshot = this.dirtySinceSnapshot && (!stats || stats.size >= this.maxEventBytes);

      if (needsSnapshot) {
        await this.#writeSnapshotAndResetEventLog();
      }
    } finally {
      this.flushing = false;
    }
  }

  async #writeSnapshotAndResetEventLog() {
    const snapshot = serializeSnapshot(this.negative);
    const tempPath = `${this.snapshotPath}.tmp`;
    await fs.promises.writeFile(tempPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    await fs.promises.rename(tempPath, this.snapshotPath);
    await fs.promises.writeFile(this.eventLogPath, "", "utf8");
    this.dirtySinceSnapshot = false;
  }

  async destroy() {
    if (!this.enabled) {
      return;
    }

    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    await this.flush();
    if (this.dirtySinceSnapshot) {
      await this.#writeSnapshotAndResetEventLog();
    }
  }
}
