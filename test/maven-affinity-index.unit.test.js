import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { MavenNegativeIndex } from "../src/cache/maven-negative-index.js";

const tempDirs = [];

function createTempDir(prefix) {
  const dirPath = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dirPath);
  return dirPath;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dirPath = tempDirs.pop();
    await fs.promises.rm(dirPath, { recursive: true, force: true });
  }
});

describe("maven negative index ttl semantics", () => {
  test("negative entries honor ttl and can be cleared on success", async () => {
    const indexDir = createTempDir("maven-affinity-index-");

    const index = new MavenNegativeIndex({
      mavenNegativeEnabled: true,
      mavenNegativeIndexDir: indexDir,
      mavenNegativeCacheTtlMs: 50,
      mavenNegativeFlushIntervalMs: 1000,
      mavenNegativeEventMaxBytes: 1024 * 1024,
    });

    await index.init();

    const canonicalKey = "com/acme/demo/1.0.0/demo-1.0.0.pom";
    const urlObj = new URL("https://repo1.maven.org/maven2/com/acme/demo/1.0.0/demo-1.0.0.pom");

    index.recordNegative({ canonicalKey, urlObj, statusCode: 404, ttlMs: 50 });
    assert.equal(index.shouldSkipRequest(canonicalKey, urlObj), true);

    await new Promise((resolve) => setTimeout(resolve, 80));

    // Negative cache entry expires by TTL.
    assert.equal(index.shouldSkipRequest(canonicalKey, urlObj), false);

    // Clear negative entry on success
    index.recordNegative({ canonicalKey, urlObj, statusCode: 404, ttlMs: 10000 });
    assert.equal(index.shouldSkipRequest(canonicalKey, urlObj), true);
    index.clearNegative({ canonicalKey, urlObj });
    assert.equal(index.shouldSkipRequest(canonicalKey, urlObj), false);

    await index.destroy();
  });
});
