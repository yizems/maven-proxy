import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { after, before, describe, test } from "node:test";

const rootDir = process.cwd();

const PROXY_PORT = 19180;
const REPO_PORT = 19181;
const MOCK_A_PORT = 19191;
const MOCK_B_PORT = 19192;

const RELATIVE_A = "/maven2/com/acme/demo/1.0.0/demo-1.0.0.pom";
const RELATIVE_B = "/repository/maven-public/com/acme/demo/1.0.0/demo-1.0.0.pom";

const TARGET_URL_A = `http://127.0.0.1:${MOCK_A_PORT}${RELATIVE_A}`;
const TARGET_URL_B = `http://127.0.0.1:${MOCK_B_PORT}${RELATIVE_B}`;

const TEST_CACHE_DIR = path.resolve(rootDir, "data/cache-replay-test");
const TEST_LOG_DIR = path.resolve(rootDir, "data/logs/replay-test");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPort(port, timeoutMs = 30000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const ok = await new Promise((resolve) => {
      const socket = net.connect({ host: "127.0.0.1", port }, () => {
        socket.destroy();
        resolve(true);
      });

      socket.on("error", () => {
        socket.destroy();
        resolve(false);
      });
    });

    if (ok) {
      return;
    }

    await sleep(100);
  }

  throw new Error(`waitForPort timeout: ${port}`);
}

async function removeDirIfExists(dirPath) {
  await fs.promises.rm(dirPath, { recursive: true, force: true });
}

async function requestViaProxy(proxyPort, targetUrl) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: proxyPort,
        method: "GET",
        path: targetUrl,
        timeout: 15000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode || 0,
            body: Buffer.concat(chunks).toString("utf8"),
            headers: res.headers,
          });
        });
      },
    );

    req.on("timeout", () => {
      req.destroy(new Error(`request timeout: ${targetUrl}`));
    });

    req.on("error", reject);
    req.end();
  });
}

function startMockRepos() {
  const state = {
    repoARequests: 0,
    repoBRequests: 0,
  };

  const serverA = http.createServer((req, res) => {
    state.repoARequests += 1;

    if ((req.url || "").startsWith(RELATIVE_A)) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found on repoA");
      return;
    }

    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("unknown");
  });

  const serverB = http.createServer((req, res) => {
    state.repoBRequests += 1;

    if ((req.url || "").startsWith(RELATIVE_B)) {
      const body = "<project><modelVersion>4.0.0</modelVersion><groupId>com.acme</groupId><artifactId>demo</artifactId><version>1.0.0</version></project>";
      res.writeHead(200, {
        "content-type": "application/xml; charset=utf-8",
        "content-length": String(Buffer.byteLength(body)),
        "accept-ranges": "bytes",
      });

      if ((req.method || "").toUpperCase() === "HEAD") {
        res.end();
        return;
      }

      res.end(body);
      return;
    }

    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("unknown");
  });

  return {
    state,
    async start() {
      await Promise.all([
        new Promise((resolve) => serverA.listen(MOCK_A_PORT, "127.0.0.1", resolve)),
        new Promise((resolve) => serverB.listen(MOCK_B_PORT, "127.0.0.1", resolve)),
      ]);
    },
    async stop() {
      await Promise.all([
        new Promise((resolve) => serverA.close(() => resolve())),
        new Promise((resolve) => serverB.close(() => resolve())),
      ]);
    },
  };
}

function startProxyProcess(logBuffer) {
  const child = spawn(process.execPath, ["src/index.js"], {
    cwd: rootDir,
    env: {
      ...process.env,
      PROXY_PORT: String(PROXY_PORT),
      REPO_PORT: String(REPO_PORT),
      CACHE_DIR: "data/cache-replay-test",
      DOWNLOAD_LOG_DIR: "data/logs/replay-test",
      MAVEN_AFFINITY_ENABLED: "true",
      MAVEN_NEGATIVE_CACHE_TTL_MS: "86400000",
      UPSTREAM_PROXY_URL: "",
      UPSTREAM_HTTP_PROXY_URL: "",
      UPSTREAM_HTTPS_PROXY_URL: "",
      UPSTREAM_NO_PROXY: "127.0.0.1,localhost",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const onData = (chunk) => {
    const text = String(chunk || "");
    logBuffer.push(text);
    if (process.env.REPLAY_TEST_VERBOSE === "1") {
      process.stdout.write(`[proxy-process] ${text}`);
    }
  };

  child.stdout.on("data", onData);
  child.stderr.on("data", onData);

  return child;
}

async function stopProxyProcess(child) {
  if (!child || child.killed) {
    return;
  }

  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 5000);

    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });

    child.kill("SIGINT");
  });
}

describe("proxy affinity replay", () => {
  const proxyLogs = [];
  const mock = startMockRepos();
  let proxyChild = null;

  before(async () => {
    await removeDirIfExists(TEST_CACHE_DIR);
    await removeDirIfExists(TEST_LOG_DIR);
    await mock.start();
    proxyChild = startProxyProcess(proxyLogs);
    await waitForPort(PROXY_PORT, 30000);
  });

  after(async () => {
    await stopProxyProcess(proxyChild);
    await mock.stop();
    await removeDirIfExists(TEST_CACHE_DIR);
    await removeDirIfExists(TEST_LOG_DIR);
  });

  test("serves the third request from affinity cache", { timeout: 60000 }, async () => {
    const r1 = await requestViaProxy(PROXY_PORT, TARGET_URL_A);
    const r2 = await requestViaProxy(PROXY_PORT, TARGET_URL_B);
    const r3 = await requestViaProxy(PROXY_PORT, TARGET_URL_A);

    await sleep(200);

    assert.equal(r1.statusCode, 404);
    assert.equal(r2.statusCode, 200);
    assert.equal(r3.statusCode, 200);
    assert.equal(r2.body, r3.body);

    // #1 => repoA HEAD + GET
    // #2 => repoB HEAD + GET
    // #3 => affinity hit, no upstream
    assert.equal(mock.state.repoARequests, 2);
    assert.equal(mock.state.repoBRequests, 2);

    const mergedLogs = proxyLogs.join("");
    assert.match(mergedLogs, /affinity hit/i);
  });
});
