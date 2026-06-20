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
  return (
    message.includes("enotdir") || message.includes("read-only file system")
  );
}

function pickClient(protocol) {
  return protocol === "https:" ? https : http;
}

function hasFileExtension(urlObj, allowedExtensions) {
  try {
    const pathname = String(urlObj?.pathname || "");
    const base = path.basename(pathname || "").toLowerCase();
    if (!base) return false;

    return allowedExtensions.some((ext) => base.endsWith(ext));
  } catch {
    return false;
  }
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
  if(statusCode === 404) {
    send404(res);
    return;
  }

  res.writeHead(statusCode, { "content-type": "text/plain; charset=utf-8" });
  res.end(message);
}

function send404(res) {
  res.writeHead(404, {
    "Content-Length": "0",
  });
  res.end();
}

function sendErrorText(res, statusCode, message, context = "proxy") {
  console.error(
    `[${context}] response error status=${statusCode} message=${message}`,
  );
  sendText(res, statusCode, message);
}

// Positive affinity removed: only negative index (404/410) is retained.

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

async function serveFile(res, req, filePath, cacheCleanupManager = null) {
  const stats = await statIfFile(filePath);
  if (!stats) {
    send404(res);
    return;
  }

  if (cacheCleanupManager) {
    cacheCleanupManager.touchFileOnHit(filePath);
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

function forwardDirectRequest(
  req,
  res,
  urlObj,
  timeoutMs,
  upstreamProxyManager = null,
) {
  const client = pickClient(urlObj.protocol);
  const headers = sanitizeHeaders(req.headers);
  headers.host = urlObj.host;
  const agent = upstreamProxyManager
    ? upstreamProxyManager.getAgentForUrl(urlObj)
    : undefined;

  if (agent) {
    console.log(
      `[proxy] direct forward via upstream host=${urlObj.hostname} protocol=${urlObj.protocol}`,
    );
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
  cacheCleanupManager = null,
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
      forwardDirectRequest(
        req,
        res,
        urlObj,
        config.downloadTimeoutMs,
        upstreamProxyManager,
      );
      return;
    }

    let cachePath;
    let ecosystem;
    let canonical = null;
    try {
      ecosystem = detectPackageEcosystem(urlObj, config, matchesDomain);
      cachePath = getCacheFilePath(config.cacheDir, urlObj, {
        ecosystem,
        includeHost: ecosystem !== "maven" || config.mavenCacheUseDomainDir,
        mavenCacheIgnorePathPrefixRules: config.mavenCacheIgnorePathPrefixRules,
      });

      if (ecosystem === "maven" && mavenAffinityIndex) {
        canonical = parseMavenReleaseCanonical(urlObj);
      }
    } catch (error) {
      const message = `Invalid cache path: ${error.message}`;
      sendErrorText(res, 400, message, "proxy");
      return;
    }

    const existing = await statIfFile(cachePath);
    if (existing) {
      console.log(
        `[proxy] local cache hit host=${urlObj.hostname} path=${urlObj.pathname}`,
      );
      await serveFile(res, req, cachePath, cacheCleanupManager);
      return;
    }

    if (canonical && mavenAffinityIndex) {
      if (
        mavenAffinityIndex.shouldSkipRequest(canonical.canonicalKey, urlObj)
      ) {
        console.log(
          `[proxy] negative skip canonical=${canonical.canonicalKey} host=${urlObj.hostname}`,
        );
        send404(res);
        return;
      }
    }

    // Only cache files whose extension is in the configured allow-list.
    // Files without an extension, or with an unrecognised extension, are forwarded directly.
    if (!hasFileExtension(urlObj, config.cacheAllowedExtensions)) {
      console.log(
        `[proxy] skip caching for extensionless path host=${urlObj.hostname} path=${urlObj.pathname}`,
      );
      forwardDirectRequest(
        req,
        res,
        urlObj,
        config.downloadTimeoutMs,
        upstreamProxyManager,
      );
      return;
    }

    try {
      console.log(
        `[proxy] local cache miss host=${urlObj.hostname} path=${urlObj.pathname}`,
      );
      if (cacheCleanupManager) {
        await cacheCleanupManager.checkAndCleanupIfNeeded("cache-miss");
      }

      const dirPath = path.dirname(cachePath);
      let downloadUrlObj = urlObj;

      // If this is a Maven artifact and a meta.json exists in the same directory,
      // prefer to use the original upstream URL recorded in meta.json and replace
      // only the filename part. This ensures we fetch related files from the same
      // upstream mirror instead of trusting the client's provided host/path.
      try {
        if (ecosystem === "maven") {
          const metaPath = path.join(dirPath, "meta.json");
          const metaStat = await statIfFile(metaPath);
          if (metaStat) {
            try {
              const text = await fs.promises.readFile(metaPath, "utf8");
              const meta = JSON.parse(text || "{}");
              if (meta && meta.originalUrl) {
                try {
                  const metaUrl = new URL(meta.originalUrl);
                  const requestedBase = path.posix.basename(
                    urlObj.pathname || "",
                  );
                  const metaDir = path.posix.dirname(metaUrl.pathname || "/");
                  metaUrl.pathname =
                    metaDir === "/"
                      ? `/${requestedBase}`
                      : `${metaDir}/${requestedBase}`;
                  downloadUrlObj = metaUrl;
                  console.log(
                    `[proxy] using meta originalUrl for download host=${metaUrl.hostname} path=${metaUrl.pathname}`,
                  );
                } catch (err) {
                  // ignore invalid meta.originalUrl
                }
              }
            } catch (err) {
              // ignore read/parse errors
            }
          }
        }
      } catch (err) {
        // ignore any unexpected errors here and fall back to client URL
      }

      await fs.promises.mkdir(dirPath, { recursive: true });
      // Ensure Host header matches the actual download target when using meta.originalUrl
      const downloadRequestHeaders = sanitizeHeaders(req.headers || {});
      downloadRequestHeaders.host = downloadUrlObj.host;
      const allowStreamOnMiss =
        method === "GET" &&
        typeof downloader?.streamMissToClient === "function" &&
        !matchesDomain(downloadUrlObj.hostname, config.multiThreadDomains || []);

      // For cache-miss GET requests, stream upstream bytes to client immediately while writing .temp.
      // This avoids long silent waits on client side before first-byte arrives.
      if (allowStreamOnMiss) {
        const streamed = await downloader.streamMissToClient(
          downloadUrlObj,
          cachePath,
          downloadRequestHeaders,
          res,
        );

        if (streamed?.responseSent) {
          if (canonical && mavenAffinityIndex) {
            try {
              mavenAffinityIndex.clearNegative({
                canonicalKey: canonical.canonicalKey,
                urlObj,
              });
            } catch (err) {
              console.error(
                `[proxy] clearing negative index failed: ${err?.message || err}`,
              );
            }
          }
          return;
        }
      } else {
        await downloader.ensureCached(downloadUrlObj, cachePath, downloadRequestHeaders);
      }

      if (canonical && mavenAffinityIndex) {
        try {
          // Clear any negative entry for this request scope on successful fetch.
          mavenAffinityIndex.clearNegative({
            canonicalKey: canonical.canonicalKey,
            urlObj,
          });
        } catch (err) {
          console.error(
            `[proxy] clearing negative index failed: ${err?.message || err}`,
          );
        }
      }

      res.setHeader("x-cache", "MISS");
      await serveFile(res, req, cachePath, cacheCleanupManager);
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

        console.error(
          `[proxy] local cache write failed cachePath=${cachePath} code=${error.code || "UNKNOWN"} message=${error.message}`,
        );
      }

      if (!res.headersSent && !res.writableEnded) {
        const statusCode = error.statusCode || 502;
        const label =
          statusCode === 500 ? "Local cache write failed" : "Download failed";
        const message = `${label}: ${error.message}`;
        sendErrorText(res, statusCode, message, "proxy");
      }
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
