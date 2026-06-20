import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { describe, test } from "node:test";
import { getCacheFilePath } from "../src/cache/cache-path.js";
import { createHttpRequestHandler } from "../src/proxy/proxy-http-handler.js";

class MemoryResponse extends Writable {
  constructor() {
    super();
    this._headers = {};
    this.statusCode = null;
    this._chunks = [];
  }

  setHeader(name, value) {
    this._headers[name.toLowerCase()] = String(value);
  }

  hasHeader(name) {
    return Object.prototype.hasOwnProperty.call(this._headers, name.toLowerCase());
  }

  writeHead(status, headers) {
    this.statusCode = status;
    if (headers && typeof headers === "object") {
      for (const [k, v] of Object.entries(headers)) {
        this.setHeader(k, v);
      }
    }
  }

  _write(chunk, encoding, callback) {
    this._chunks.push(Buffer.from(chunk));
    callback();
  }

  get body() {
    return Buffer.concat(this._chunks).toString("utf8");
  }
}

describe("proxy meta.json usage", () => {
  test("uses streamMissToClient on cache-miss GET when downloader supports streaming", async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "proxy-stream-"));

    const config = {
      cacheDir: tmp,
      downloadTimeoutMs: 1000,
      mavenCacheUseDomainDir: false,
      cacheAllowedExtensions: [".pom", ".jar", ".aar", ".tgz", ".tar.gz", ".json", ".xml", ".sha1", ".md5", ".sha256", ".sha512", ".asc", ".module"],
    };

    const matchesDomain = () => false;

    let streamCalled = false;
    const fakeDownloader = {
      async ensureCached() {
        throw new Error("ensureCached should not be used in stream path");
      },
      async streamMissToClient(urlObj, finalPath, headers, res) {
        streamCalled = true;
        await fsp.mkdir(path.dirname(finalPath), { recursive: true });
        await fsp.writeFile(finalPath, "ok-stream", "utf8");
        res.setHeader("x-cache", "MISS");
        res.writeHead(200);
        res.end("ok-stream");
        return { cacheHit: false, finalPath, responseSent: true };
      },
    };

    const handler = createHttpRequestHandler({
      config,
      downloader: fakeDownloader,
      upstreamProxyManager: null,
      matchesDomain,
      mavenAffinityIndex: null,
      cacheCleanupManager: null,
    });

    const req = {
      method: "GET",
      url: "/maven2/org/example/demo/1.0.0/demo-1.0.0.pom",
      headers: { host: "repo1.maven.org" },
      socket: {},
    };

    const res = new MemoryResponse();
    const finished = new Promise((resolve) => res.on("finish", resolve));

    await handler(req, res);
    await finished;

    assert.equal(streamCalled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, "ok-stream");

    await fsp.rm(tmp, { recursive: true, force: true });
  });

  test("keeps ensureCached path for GET when target host is configured for multi-thread download", async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "proxy-multi-thread-"));

    const config = {
      cacheDir: tmp,
      downloadTimeoutMs: 1000,
      mavenCacheUseDomainDir: false,
      multiThreadDomains: ["repo1.maven.org"],
      cacheAllowedExtensions: [".pom", ".jar", ".aar", ".tgz", ".tar.gz", ".json", ".xml", ".sha1", ".md5", ".sha256", ".sha512", ".asc", ".module"],
    };

    const matchesDomain = (hostname, patterns = []) =>
      patterns.includes(String(hostname || "").toLowerCase());

    let ensureCalled = false;
    let streamCalled = false;
    const fakeDownloader = {
      async ensureCached(urlObj, finalPath) {
        ensureCalled = true;
        await fsp.mkdir(path.dirname(finalPath), { recursive: true });
        await fsp.writeFile(finalPath, "ok-multi", "utf8");
        return { cacheHit: false, finalPath };
      },
      async streamMissToClient() {
        streamCalled = true;
        throw new Error("streamMissToClient should not be used for multi-thread domains");
      },
    };

    const handler = createHttpRequestHandler({
      config,
      downloader: fakeDownloader,
      upstreamProxyManager: null,
      matchesDomain,
      mavenAffinityIndex: null,
      cacheCleanupManager: null,
    });

    const req = {
      method: "GET",
      url: "/maven2/org/example/demo/1.0.0/demo-1.0.0.pom",
      headers: { host: "repo1.maven.org" },
      socket: {},
    };

    const res = new MemoryResponse();
    const finished = new Promise((resolve) => res.on("finish", resolve));

    await handler(req, res);
    await finished;

    assert.equal(ensureCalled, true);
    assert.equal(streamCalled, false);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, "ok-multi");

    await fsp.rm(tmp, { recursive: true, force: true });
  });

  test("uses meta.originalUrl (with filename replaced) to download related artifact", async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "proxy-meta-"));

    const config = {
      cacheDir: tmp,
      downloadTimeoutMs: 1000,
      mavenCacheUseDomainDir: false,
      cacheAllowedExtensions: [".pom", ".jar", ".aar", ".tgz", ".tar.gz", ".json", ".xml", ".sha1", ".md5", ".sha256", ".sha512", ".asc", ".module"],
    };

    const matchesDomain = () => false;

    const fakeDownloader = {
      capturedUrl: null,
      async ensureCached(urlObj, finalPath, headers) {
        this.capturedUrl = typeof urlObj === "string" ? urlObj : urlObj?.href;
        await fsp.mkdir(path.dirname(finalPath), { recursive: true });
        await fsp.writeFile(finalPath, "ok", "utf8");
        return { cacheHit: false, finalPath };
      },
    };

    const handler = createHttpRequestHandler({
      config,
      downloader: fakeDownloader,
      upstreamProxyManager: null,
      matchesDomain,
      mavenAffinityIndex: null,
      cacheCleanupManager: null,
    });

    const requestedPath = "/com/acme/demo/1.0.0/demo-1.0.0.jar";

    // Compute where the cache would live for this requested URL and place meta.json there
    const cachePath = getCacheFilePath(tmp, new URL(`http://repo1.maven.org${requestedPath}`), {
      ecosystem: "maven",
      includeHost: false,
      mavenCacheIgnorePathPrefixRules: [],
    });

    const dir = path.dirname(cachePath);
    await fsp.mkdir(dir, { recursive: true });

    const meta = {
      originalUrl: "https://repo1.maven.org/maven2/com/acme/demo/1.0.0/demo-1.0.0.pom",
      timestamp: new Date().toLocaleString(),
    };

    await fsp.writeFile(path.join(dir, "meta.json"), JSON.stringify(meta), "utf8");

    const req = {
      method: "GET",
      url: requestedPath,
      headers: { host: "repo1.maven.org" },
      socket: {},
    };

    const res = new MemoryResponse();

    const finished = new Promise((resolve) => res.on("finish", resolve));

    await handler(req, res);

    // Wait for response stream to finish piping
    await finished;

    assert.equal(
      fakeDownloader.capturedUrl,
      "https://repo1.maven.org/maven2/com/acme/demo/1.0.0/demo-1.0.0.jar",
    );

    assert.equal(res.statusCode, 200);
    assert.equal(res.body, "ok");

    await fsp.rm(tmp, { recursive: true, force: true });
  });
});
