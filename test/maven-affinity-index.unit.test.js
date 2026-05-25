import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { MavenAffinityIndex } from "../src/cache/maven-affinity-index.js";

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

describe("maven affinity index ttl semantics", () => {
  test("positive entries do not expire while negative entries honor ttl", async () => {
    const indexDir = createTempDir("maven-affinity-index-");
    const cacheFile = path.join(indexDir, "demo-1.0.0.pom");
    const cacheBody = "<project/>";
    await fs.promises.writeFile(cacheFile, cacheBody, "utf8");

    const index = new MavenAffinityIndex({
      mavenAffinityEnabled: true,
      mavenAffinityIndexDir: indexDir,
      mavenNegativeCacheTtlMs: 50,
      mavenAffinityFlushIntervalMs: 1000,
      mavenAffinityEventMaxBytes: 1024 * 1024,
    });

    await index.init();

    const canonicalKey = "com/acme/demo/1.0.0/demo-1.0.0.pom";
    const urlObj = new URL("https://repo1.maven.org/maven2/com/acme/demo/1.0.0/demo-1.0.0.pom");

    index.recordSuccess({
      canonicalKey,
      host: urlObj.hostname,
      cachePath: cacheFile,
      fileName: "demo-1.0.0.pom",
      urlObj,
    });

    index.recordNegative({
      canonicalKey,
      urlObj,
      statusCode: 404,
      ttlMs: 50,
    });

    assert.equal(index.shouldSkipRequest(canonicalKey, urlObj), true);

    await new Promise((resolve) => setTimeout(resolve, 80));

    // Negative cache entry expires by TTL.
    assert.equal(index.shouldSkipRequest(canonicalKey, urlObj), false);

    // Positive cache entry remains available without TTL expiration.
    const preferredPath = await index.resolvePreferredCachePath(canonicalKey);
    assert.equal(preferredPath, cacheFile);

    await index.destroy();
  });
});
