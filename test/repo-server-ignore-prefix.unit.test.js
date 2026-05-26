import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { parseMavenCacheIgnorePathPrefixes } from "../src/cache/cache-path.js";
import { startRepoServer } from "../src/repo/repo-server.js";

function once(emitter, event) {
  return new Promise((resolve) => emitter.once(event, resolve));
}

function request(port, requestPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        method: "GET",
        path: requestPath,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode || 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );

    req.on("error", reject);
    req.end();
  });
}

async function closeServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

describe("repo server cache path ignore prefix", () => {
  test("serves flat maven cache when /maven2 prefix is stripped", async () => {
    const rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), "repo-ignore-flat-"));
    const mavenCacheDir = path.join(rootDir, "maven");
    const artifactRelative = path.join("org", "apache", "commons", "commons-lang3", "3.14.0", "commons-lang3-3.14.0.pom");
    const artifactPath = path.join(mavenCacheDir, artifactRelative);

    await fsp.mkdir(path.dirname(artifactPath), { recursive: true });
    await fsp.writeFile(artifactPath, "flat-ok", "utf8");

    const server = startRepoServer(
      {
        repoPort: 0,
        mavenCacheDir,
        mavenCacheUseDomainDir: false,
        repoFallbackRepos: ["https://repo1.maven.org/maven2"],
        mavenCacheIgnorePathPrefixRules: parseMavenCacheIgnorePathPrefixes("repo1.maven.org/maven2"),
      },
      null,
      null,
    );

    await once(server, "listening");
    const port = server.address().port;

    const res = await request(port, "/maven2/org/apache/commons/commons-lang3/3.14.0/commons-lang3-3.14.0.pom");
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, "flat-ok");

    await closeServer(server);
    await fsp.rm(rootDir, { recursive: true, force: true });
  });

  test("serves domain-dir maven cache when host scoped prefix is stripped", async () => {
    const rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), "repo-ignore-domain-"));
    const mavenCacheDir = path.join(rootDir, "maven");
    const artifactRelative = path.join("org", "apache", "commons", "commons-lang3", "3.14.0", "commons-lang3-3.14.0.pom");
    const artifactPath = path.join(mavenCacheDir, "repo1.maven.org", artifactRelative);

    await fsp.mkdir(path.dirname(artifactPath), { recursive: true });
    await fsp.writeFile(artifactPath, "domain-ok", "utf8");

    const server = startRepoServer(
      {
        repoPort: 0,
        mavenCacheDir,
        mavenCacheUseDomainDir: true,
        repoFallbackRepos: ["https://repo1.maven.org/maven2"],
        mavenCacheIgnorePathPrefixRules: parseMavenCacheIgnorePathPrefixes("repo1.maven.org/maven2"),
      },
      null,
      null,
    );

    await once(server, "listening");
    const port = server.address().port;

    const res = await request(port, "/maven2/org/apache/commons/commons-lang3/3.14.0/commons-lang3-3.14.0.pom");
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, "domain-ok");

    await closeServer(server);
    await fsp.rm(rootDir, { recursive: true, force: true });
  });
});
