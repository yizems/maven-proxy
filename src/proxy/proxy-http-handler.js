import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { getCacheFilePath } from "../cache/cache-path.js";
import { detectPackageEcosystem } from "../common/ecosystem.js";
import { parseMavenReleaseCanonical } from "../common/maven-canonical.js";

const LOCAL_FS_ERROR_CODES = new Set([
  "EACCES",
  "EPERM",
  "ENOSPC",
  "EROFS",
  "ENOTDIR",
  "EISDIR",
  "EINVAL",
  "EMFILE",
  "ENFILE",
  "EEXIST",
]);

function isLocalFsWriteError(error) {
  if (!error || typeof error !== "object") {
    return false;
  }

  if (LOCAL_FS_ERROR_CODES.has(error.code)) {
    return true;
  }

  const message = String(error.message || "").toLowerCase();
  return message.includes("enotdir") || message.includes("read-only file system");
}

function pickClient(protocol) {
  return protocol === "https:" ? https : http;
}

function sanitizeHeaders(headers = {}) {
  const result = { ...headers };
  const blocked = [
    "proxy-connection",
    "proxy-authorization",
    "proxy-authenticate",
    "connection",
    "keep-alive",
    "transfer-encoding",
    "upgrade",
    "te",
    "trailer",
  ];

  for (const key of blocked) {
    delete result[key];
    delete result[key.toLowerCase()];
  }

  return result;
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

function sendText(res, statusCode, message) {
  res.writeHead(statusCode, { "content-type": "text/plain; charset=utf-8" });
  res.end(message);
}

function sendErrorText(res, statusCode, message, context = "proxy") {
  console.error(`[${context}] response error status=${statusCode} message=${message}`);
  sendText(res, statusCode, message);
}

export function isPositiveAffinityEligible(fileName) {
  const lower = String(fileName || "").toLowerCase();
  const base = lower.replace(/\.(sha1|sha256|sha512|md5|asc)$/i, "");
  return /\.(jar|aar|war)$/i.test(base);
}

function buildUrl(req, forcedProtocol = null) {
  const raw = req.url || "/";
  if (/^https?:\/\//i.test(raw)) {
    return new URL(raw);
  }

  const host = req.headers.host || req.socket.__mitmHost;
  if (!host) {
    throw new Error("Missing host header");
  }

  const protocol = forcedProtocol || "http:";
  return new URL(`${protocol}//${host}${raw}`);
}

async function serveFile(res, req, filePath) {
  const stats = await statIfFile(filePath);
  if (!stats) {
    sendText(res, 404, "Not Found");
    return;
  }

  res.setHeader("content-length", String(stats.size));
  if (!res.hasHeader("x-cache")) {
    res.setHeader("x-cache", "HIT");
  }

  if (req.method === "HEAD") {
    res.writeHead(200);
    res.end();
    return;
  }

  res.writeHead(200);
  fs.createReadStream(filePath).pipe(res);
}

function forwardDirectRequest(req, res, urlObj, timeoutMs, upstreamProxyManager = null) {
  const client = pickClient(urlObj.protocol);
  const headers = sanitizeHeaders(req.headers);
  headers.host = urlObj.host;
  const agent = upstreamProxyManager ? upstreamProxyManager.getAgentForUrl(urlObj) : undefined;

  if (agent) {
    console.log(`[proxy] direct forward via upstream host=${urlObj.hostname} protocol=${urlObj.protocol}`);
  }

  const upstreamReq = client.request(
    {
      protocol: urlObj.protocol,
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === "https:" ? 443 : 80),
      method: req.method,
      path: `${urlObj.pathname}${urlObj.search}`,
      headers,
      agent,
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );

  upstreamReq.setTimeout(timeoutMs, () => {
    upstreamReq.destroy(new Error(`Upstream timeout after ${timeoutMs}ms`));
  });

  upstreamReq.on("error", (error) => {
    if (!res.headersSent) {
      const message = `Proxy forward failed: ${error.message}`;
      sendErrorText(res, 502, message, "proxy");
    } else {
      res.destroy(error);
    }
  });

  req.pipe(upstreamReq);
}

export function createHttpRequestHandler({
  config,
  downloader,
  upstreamProxyManager = null,
  matchesDomain,
  mavenAffinityIndex = null,
}) {
  return async function handleHttpRequestPath(req, res, forcedProtocol = null) {
    let urlObj;
    try {
      urlObj = buildUrl(req, forcedProtocol);
    } catch (error) {
      const message = `Bad request: ${error.message}`;
      sendErrorText(res, 400, message, "proxy");
      return;
    }

    const method = (req.method || "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      forwardDirectRequest(req, res, urlObj, config.downloadTimeoutMs, upstreamProxyManager);
      return;
    }

    let cachePath;
    let ecosystem;
    let canonical = null;
    try {
      ecosystem = detectPackageEcosystem(urlObj, config, matchesDomain);
      cachePath = getCacheFilePath(config.cacheDir, urlObj, {
        ecosystem,
        includeHost: ecosystem !== "maven",
      });

      if (ecosystem === "maven" && mavenAffinityIndex?.enabled) {
        canonical = parseMavenReleaseCanonical(urlObj);
      }
    } catch (error) {
      const message = `Invalid cache path: ${error.message}`;
      sendErrorText(res, 400, message, "proxy");
      return;
    }

    const existing = await statIfFile(cachePath);
    if (existing) {
      console.log(`[proxy] local cache hit host=${urlObj.hostname} path=${urlObj.pathname}`);
      await serveFile(res, req, cachePath);
      return;
    }

    if (canonical && mavenAffinityIndex) {
      if (isPositiveAffinityEligible(canonical.fileName)) {
        const preferredPath = await mavenAffinityIndex.resolvePreferredCachePath(canonical.canonicalKey);
        if (preferredPath) {
          console.log(`[proxy] affinity hit canonical=${canonical.canonicalKey} host=${urlObj.hostname}`);
          await serveFile(res, req, preferredPath);
          return;
        }
      }

      if (mavenAffinityIndex.shouldSkipRequest(canonical.canonicalKey, urlObj)) {
        console.log(`[proxy] affinity negative skip canonical=${canonical.canonicalKey} host=${urlObj.hostname}`);
        sendText(res, 404, "Not Found");
        return;
      }
    }

    try {
      console.log(`[proxy] local cache miss host=${urlObj.hostname} path=${urlObj.pathname}`);
      await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
      await downloader.ensureCached(urlObj, cachePath, req.headers);

      if (canonical && mavenAffinityIndex && isPositiveAffinityEligible(canonical.fileName)) {
        mavenAffinityIndex.recordSuccess({
          canonicalKey: canonical.canonicalKey,
          host: urlObj.hostname,
          cachePath,
          fileName: canonical.fileName,
          urlObj,
        });
      }

      res.setHeader("x-cache", "MISS");
      await serveFile(res, req, cachePath);
    } catch (error) {
      if (
        canonical &&
        mavenAffinityIndex &&
        (error.statusCode === 404 || error.statusCode === 410)
      ) {
        mavenAffinityIndex.recordNegative({
          canonicalKey: canonical.canonicalKey,
          urlObj,
          statusCode: error.statusCode,
        });
      }

      if (isLocalFsWriteError(error)) {
        if (!error.statusCode) {
          error.statusCode = 500;
        }

        if (typeof downloader?.logDownload === "function") {
          downloader.logDownload("local cache write failed", urlObj, {
            code: error.code || "UNKNOWN",
            cachePath,
            message: error.message,
          });
        }

        console.error(`[proxy] local cache write failed cachePath=${cachePath} code=${error.code || "UNKNOWN"} message=${error.message}`);
      }

      const statusCode = error.statusCode || 502;
      const label = statusCode === 500 ? "Local cache write failed" : "Download failed";
      const message = `${label}: ${error.message}`;
      sendErrorText(res, statusCode, message, "proxy");
    }
  };
}

export function createMitmHttpServer(handleHttpRequestPath) {
  const server = http.createServer((req, res) => {
    handleHttpRequestPath(req, res, "https:").catch((error) => {
      const message = `MITM request failed: ${error.message}`;
      sendErrorText(res, 500, message, "proxy-mitm");
    });
  });

  server.on("clientError", (error, socket) => {
    socket.destroy(error);
  });

  return server;
}
