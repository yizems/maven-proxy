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

function serializeSnapshot(positiveMap, negativeMap, conflictMap) {
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    positive: [...positiveMap.entries()],
    negative: [...negativeMap.entries()],
    conflicts: [...conflictMap.entries()],
  };
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

export class MavenAffinityIndex {
  constructor(config) {
    this.enabled = toBool(config.mavenAffinityEnabled, true);
    this.indexDir = config.mavenAffinityIndexDir;
    this.negativeTtlMs = toPositiveInt(config.mavenNegativeCacheTtlMs, 24 * 60 * 60 * 1000);
    this.flushIntervalMs = toPositiveInt(config.mavenAffinityFlushIntervalMs, 5000);
    this.maxEventBytes = toPositiveInt(config.mavenAffinityEventMaxBytes, 8 * 1024 * 1024);

    this.snapshotPath = path.join(this.indexDir, "maven-affinity.snapshot.json");
    this.eventLogPath = path.join(this.indexDir, "maven-affinity.events.log");

    // Positive entries are persistent and have no TTL. They are removed only
    // when the cache file disappears or a conflict is detected.
    this.positive = new Map();
    this.negative = new Map();
    this.conflicts = new Map();

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
        console.error(`[affinity] flush failed: ${error.message}`);
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

    for (const [key, value] of snapshot.positive || []) {
      this.positive.set(key, value);
    }

    const currentTime = nowMs();
    for (const [key, value] of snapshot.negative || []) {
      if (value?.expireAt && value.expireAt > currentTime) {
        this.negative.set(key, value);
      }
    }

    for (const [key, value] of snapshot.conflicts || []) {
      this.conflicts.set(key, value);
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

    if (type === "positive_upsert") {
      this.positive.set(payload.key, payload.value);
      if (append) {
        this.#enqueueEvent(type, payload);
      }
      return;
    }

    if (type === "positive_remove") {
      this.positive.delete(payload.key);
      if (append) {
        this.#enqueueEvent(type, payload);
      }
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

    if (type === "conflict_set") {
      this.conflicts.set(payload.key, payload.value);
      if (append) {
        this.#enqueueEvent(type, payload);
      }
      return;
    }

    if (type === "conflict_clear") {
      this.conflicts.delete(payload.key);
      if (append) {
        this.#enqueueEvent(type, payload);
      }
    }
  }

  async resolvePreferredCachePath(canonicalKey) {
    if (!this.enabled || !canonicalKey) {
      return "";
    }

    if (this.conflicts.has(canonicalKey)) {
      return "";
    }

    const existing = this.positive.get(canonicalKey);
    if (!existing?.cachePath) {
      return "";
    }

    try {
      const stats = await fs.promises.stat(existing.cachePath);
      if (!stats.isFile()) {
        throw new Error("not-file");
      }
      return existing.cachePath;
    } catch {
      this.#applyEvent({
        type: "positive_remove",
        payload: { key: canonicalKey },
      });
      return "";
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

  recordSuccess({ canonicalKey, host, cachePath, fileName, urlObj = null }) {
    if (!this.enabled || !canonicalKey || !cachePath || !fileName) {
      return;
    }

    const previous = this.positive.get(canonicalKey);
    if (previous && previous.fileName !== fileName) {
      this.#applyEvent({
        type: "conflict_set",
        payload: {
          key: canonicalKey,
          value: {
            reason: "file-name-mismatch",
            updatedAt: nowMs(),
            previousFileName: previous.fileName,
            currentFileName: fileName,
          },
        },
      });

      this.#applyEvent({
        type: "positive_remove",
        payload: { key: canonicalKey },
      });
      return;
    }

    this.#applyEvent({
      type: "positive_upsert",
      payload: {
        key: canonicalKey,
        value: {
          cachePath,
          fileName,
          host: String(host || "").toLowerCase(),
          updatedAt: nowMs(),
        },
      },
    });

    const successScope = buildNegativeScope(urlObj);
    if (successScope) {
      const negativeKey = buildNegativeKey(successScope, canonicalKey);
      if (this.negative.has(negativeKey)) {
        this.#applyEvent({
          type: "negative_remove",
          payload: { key: negativeKey },
        });
      }
    }
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
    const snapshot = serializeSnapshot(this.positive, this.negative, this.conflicts);
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
