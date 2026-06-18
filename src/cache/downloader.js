import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { finished, pipeline } from "node:stream/promises";

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;
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

function stripHopByHopHeaders(headers = {}) {
  const result = { ...headers };
  const blocked = [
    "connection",
    "proxy-connection",
    "keep-alive",
    "transfer-encoding",
    "upgrade",
    "te",
    "trailer",
    "proxy-authenticate",
    "proxy-authorization",
  ];

  for (const header of blocked) {
    delete result[header];
    delete result[header.toLowerCase()];
  }

  return result;
}

function stripHopByHopResponseHeaders(headers = {}) {
  const result = { ...headers };
  const blocked = [
    "connection",
    "proxy-connection",
    "keep-alive",
    "transfer-encoding",
    "upgrade",
    "te",
    "trailer",
    "proxy-authenticate",
    "proxy-authorization",
  ];

  for (const header of blocked) {
    delete result[header];
    delete result[header.toLowerCase()];
  }

  return result;
}

function requestRaw(urlObj, { method, headers, timeoutMs, getAgent }) {
  const client = pickClient(urlObj.protocol);
  const agent = getAgent ? getAgent(urlObj) : undefined;

  return new Promise((resolve, reject) => {
    const req = client.request(
      {
        protocol: urlObj.protocol,
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === "https:" ? 443 : 80),
        path: `${urlObj.pathname}${urlObj.search}`,
        method,
        headers,
        agent,
      },
      (res) => resolve({ req, res }),
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Request timeout after ${timeoutMs}ms: ${urlObj.href}`));
    });

    req.on("error", reject);
    req.end();
  });
}

async function requestWithRedirect(urlObj, options, redirectCount = 0) {
  if (redirectCount > MAX_REDIRECTS) {
    throw new Error(`Too many redirects while requesting ${urlObj.href}`);
  }

  const { res } = await requestRaw(urlObj, options);

  if (REDIRECT_STATUS.has(res.statusCode) && res.headers.location) {
    res.resume();
    const nextUrl = new URL(res.headers.location, urlObj);
    return requestWithRedirect(nextUrl, options, redirectCount + 1);
  }

  return { urlObj, res };
}

async function probe(urlObj, headers, timeoutMs, getAgent) {
  try {
    const { urlObj: finalUrl, res } = await requestWithRedirect(urlObj, {
      method: "HEAD",
      headers,
      timeoutMs,
      getAgent,
    });

    const contentLength = Number.parseInt(res.headers["content-length"], 10);
    const acceptRanges = String(res.headers["accept-ranges"] || "").toLowerCase().includes("bytes");
    const statusCode = res.statusCode || 0;
    res.resume();

    if (statusCode >= 400) {
      return { finalUrl, contentLength: null, acceptRanges: false };
    }

    return {
      finalUrl,
      contentLength: Number.isFinite(contentLength) ? contentLength : null,
      acceptRanges,
    };
  } catch {
    return { finalUrl: urlObj, contentLength: null, acceptRanges: false };
  }
}

async function downloadSingle(urlObj, tempPath, headers, timeoutMs, getAgent) {
  const requestHeaders = {
    ...stripHopByHopHeaders(headers),
    "accept-encoding": "identity",
  };

  const { urlObj: finalUrl, res } = await requestWithRedirect(
    urlObj,
    {
      method: "GET",
      headers: requestHeaders,
      timeoutMs,
      getAgent,
    },
    0,
  );

  const statusCode = res.statusCode || 0;
  if (statusCode >= 400) {
    const chunks = [];
    for await (const chunk of res) {
      chunks.push(chunk);
      if (Buffer.concat(chunks).length > 2048) {
        break;
      }
    }
    const body = Buffer.concat(chunks).toString("utf8");
    throw Object.assign(new Error(`Upstream GET failed (${statusCode}) ${finalUrl.href}`), {
      statusCode,
      upstreamBody: body,
    });
  }

  if (statusCode < 200 || statusCode >= 300) {
    throw new Error(`Unexpected status code ${statusCode} for ${finalUrl.href}`);
  }

  const contentLength = Number.parseInt(res.headers["content-length"], 10);

  const stream = fs.createWriteStream(tempPath, { flags: "w" });
  await pipeline(res, stream);

  return {
    finalUrl,
    contentLength: Number.isFinite(contentLength) ? contentLength : null,
  };
}

async function downloadRange(urlObj, tempPath, start, end, headers, timeoutMs, getAgent) {
  const requestHeaders = {
    ...stripHopByHopHeaders(headers),
    "accept-encoding": "identity",
    range: `bytes=${start}-${end}`,
  };

  const { res } = await requestRaw(urlObj, {
    method: "GET",
    headers: requestHeaders,
    timeoutMs,
    getAgent,
  });

  const statusCode = res.statusCode || 0;
  if (statusCode !== 206) {
    res.resume();
    throw new Error(`Range request failed with status ${statusCode} (${start}-${end})`);
  }

  const writeStream = fs.createWriteStream(tempPath, {
    flags: "r+",
    start,
  });

  await pipeline(res, writeStream);
}

async function downloadMultiThread(urlObj, tempPath, headers, timeoutMs, contentLength, threadCount, getAgent) {
  const handle = await fs.promises.open(tempPath, "w");
  await handle.truncate(contentLength);
  await handle.close();

  const partSize = Math.ceil(contentLength / threadCount);
  const tasks = [];

  for (let index = 0; index < threadCount; index += 1) {
    const start = index * partSize;
    const end = Math.min(contentLength - 1, start + partSize - 1);

    if (start > end) {
      continue;
    }

    tasks.push(downloadRange(urlObj, tempPath, start, end, headers, timeoutMs, getAgent));
  }

  await Promise.all(tasks);
}

async function fileExists(filePath) {
  try {
    const stats = await fs.promises.stat(filePath);
    return stats.isFile();
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function verifyFileSize(filePath, expectedSize) {
  if (!Number.isFinite(expectedSize)) {
    return;
  }

  const stats = await fs.promises.stat(filePath);
  if (stats.size !== expectedSize) {
    throw new Error(`Integrity check failed: expected ${expectedSize} bytes, got ${stats.size}`);
  }
}

async function removeIfExists(filePath) {
  try {
    await fs.promises.unlink(filePath);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

function toHost(urlObj) {
  if (!urlObj || typeof urlObj !== "object") {
    return "";
  }

  return String(urlObj.hostname || "");
}

function toBodyPreview(value, maxLength = 512) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) {
    return "";
  }

  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength)}...(truncated)`;
}

export class Downloader {
  constructor(config, domainMatcher, upstreamProxyManager = null) {
    this.config = config;
    this.domainMatcher = domainMatcher;
    this.upstreamProxyManager = upstreamProxyManager;
    this.inflight = new Map();
  }

  logDownload(event, urlObj, details = {}) {
    const url = typeof urlObj === "string" ? urlObj : urlObj?.href;
    const detailText = Object.entries(details)
      .filter(([, value]) => value !== undefined && value !== null && value !== "")
      .map(([key, value]) => `${key}=${value}`)
      .join(" ");

    console.log(`[downloader] ${event} url=${url}${detailText ? ` ${detailText}` : ""}`);
  }

  async ensureCached(urlObj, finalPath, requestHeaders = {}) {
    if (await fileExists(finalPath)) {
      return { cacheHit: true, finalPath };
    }

    const existing = this.inflight.get(finalPath);
    if (existing) {
      await existing;
      return { cacheHit: true, finalPath };
    }

    const downloadPromise = this.#downloadAtomic(urlObj, finalPath, requestHeaders);
    this.inflight.set(finalPath, downloadPromise);

    try {
      await downloadPromise;
    } finally {
      this.inflight.delete(finalPath);
    }

    return { cacheHit: false, finalPath };
  }

  async streamMissToClient(urlObj, finalPath, requestHeaders = {}, res = null) {
    if (!res || typeof res.writeHead !== "function") {
      throw new Error("streamMissToClient requires a valid response object");
    }

    if (await fileExists(finalPath)) {
      return { cacheHit: true, finalPath, responseSent: false };
    }

    const existing = this.inflight.get(finalPath);
    if (existing) {
      await existing;
      return { cacheHit: true, finalPath, responseSent: false };
    }

    const downloadPromise = this.#downloadAtomicAndMirror(urlObj, finalPath, requestHeaders, res);
    this.inflight.set(finalPath, downloadPromise);

    try {
      await downloadPromise;
    } finally {
      this.inflight.delete(finalPath);
    }

    return { cacheHit: false, finalPath, responseSent: true };
  }

  async #downloadAtomicAndMirror(urlObj, finalPath, requestHeaders, res) {
    const startedAt = Date.now();

    await fs.promises.mkdir(path.dirname(finalPath), { recursive: true });
    const tempPath = `${finalPath}.temp`;
    await removeIfExists(tempPath);

    try {
      const headers = stripHopByHopHeaders(requestHeaders);
      headers["accept-encoding"] = "identity";

      const getAgent = this.upstreamProxyManager
        ? (currentUrl) => this.upstreamProxyManager.getAgentForUrl(currentUrl)
        : null;

      const { urlObj: finalUrl, res: upstreamRes } = await requestWithRedirect(
        urlObj,
        {
          method: "GET",
          headers,
          timeoutMs: this.config.downloadTimeoutMs,
          getAgent,
        },
      );

      const statusCode = upstreamRes.statusCode || 0;
      const hostname = finalUrl.hostname;

      this.logDownload("download start", finalUrl, { host: hostname, targetPath: finalPath });

      if (getAgent && this.upstreamProxyManager.hasProxyFor(finalUrl.protocol, hostname)) {
        this.logDownload("outbound via upstream proxy", finalUrl, {
          host: hostname,
          protocol: finalUrl.protocol,
        });
      }

      if (statusCode >= 400) {
        const chunks = [];
        for await (const chunk of upstreamRes) {
          chunks.push(chunk);
          if (Buffer.concat(chunks).length > 2048) {
            break;
          }
        }

        const body = Buffer.concat(chunks).toString("utf8");
        throw Object.assign(new Error(`Upstream GET failed (${statusCode}) ${finalUrl.href}`), {
          statusCode,
          upstreamBody: body,
        });
      }

      if (statusCode < 200 || statusCode >= 300) {
        throw new Error(`Unexpected status code ${statusCode} for ${finalUrl.href}`);
      }

      const expectedLength = Number.parseInt(upstreamRes.headers["content-length"], 10);
      const responseHeaders = stripHopByHopResponseHeaders(upstreamRes.headers || {});
      responseHeaders["x-cache"] = "MISS";

      if (!res.headersSent) {
        res.writeHead(statusCode, responseHeaders);
      }

      const cacheStream = fs.createWriteStream(tempPath, { flags: "w" });
      const cacheDone = pipeline(upstreamRes, cacheStream);

      // Mirror bytes to client as soon as they arrive so client-side read timeouts won't trigger on long downloads.
      upstreamRes.pipe(res);

      res.once("close", () => {
        upstreamRes.unpipe(res);
      });

      res.on("error", () => {
        // Client socket errors should not break cache writing.
        this.logDownload("client response error", finalUrl);
      });

      await cacheDone;
      await verifyFileSize(tempPath, Number.isFinite(expectedLength) ? expectedLength : null);
      await fs.promises.rename(tempPath, finalPath);

      const finalStats = await fs.promises.stat(finalPath);
      this.logDownload("download succeeded", finalUrl, {
        host: hostname,
        targetPath: finalPath,
        size: finalStats.size,
        elapsedMs: Date.now() - startedAt,
      });

      try {
        const meta = {
          originalUrl: typeof finalUrl === "string" ? finalUrl : finalUrl?.href,
          timestamp: new Date().toLocaleString(),
        };
        const metaPath = path.join(path.dirname(finalPath), "meta.json");
        const tmpMetaPath = `${metaPath}.tmp`;
        await fs.promises.writeFile(tmpMetaPath, JSON.stringify(meta), "utf8");
        await fs.promises.rename(tmpMetaPath, metaPath);
      } catch (err) {
        this.logDownload("meta write failed", finalUrl, {
          targetDir: path.dirname(finalPath),
          message: err?.message || String(err),
        });
      }

      if (!res.writableEnded) {
        try {
          await finished(res);
        } catch {
          // client may close early; cache file has already been persisted
        }
      }
    } catch (error) {
      if (isLocalFsWriteError(error)) {
        if (!error.statusCode) {
          error.statusCode = 500;
        }

        this.logDownload("local cache write failed", urlObj, {
          code: error.code || "UNKNOWN",
          targetPath: finalPath,
          tempPath,
          message: error.message,
        });
      }

      this.logDownload("download failed", urlObj, {
        host: toHost(urlObj),
        code: error.code || "UNKNOWN",
        statusCode: error.statusCode || 0,
        targetPath: finalPath,
        tempPath,
        message: error.message,
        upstreamBodyPreview: toBodyPreview(error.upstreamBody),
      });

      await removeIfExists(tempPath);

      if (!res.headersSent) {
        const statusCode = error.statusCode || 502;
        res.writeHead(statusCode, { "content-type": "text/plain; charset=utf-8" });
        res.end(`Download failed: ${error.message}`);
      } else if (!res.writableEnded) {
        res.destroy(error);
      }

      throw error;
    }
  }

  async #downloadAtomic(urlObj, finalPath, requestHeaders) {
    const startedAt = Date.now();

    await fs.promises.mkdir(path.dirname(finalPath), { recursive: true });
    const tempPath = `${finalPath}.temp`;
    await removeIfExists(tempPath);

    try {
      const headers = stripHopByHopHeaders(requestHeaders);
      const getAgent = this.upstreamProxyManager
        ? (currentUrl) => this.upstreamProxyManager.getAgentForUrl(currentUrl)
        : null;
      const metadata = await probe(urlObj, headers, this.config.downloadTimeoutMs, getAgent);
      const downloadUrl = metadata.finalUrl;
      const hostname = downloadUrl.hostname;

      this.logDownload("download start", downloadUrl, { host: hostname, targetPath: finalPath });

      if (getAgent && this.upstreamProxyManager.hasProxyFor(downloadUrl.protocol, hostname)) {
        this.logDownload("outbound via upstream proxy", downloadUrl, {
          host: hostname,
          protocol: downloadUrl.protocol,
        });
      }

      const shouldUseMulti =
        this.domainMatcher(hostname, this.config.multiThreadDomains) &&
        Number.isFinite(metadata.contentLength) &&
        metadata.contentLength >= this.config.multiThreadMinSizeBytes &&
        metadata.acceptRanges;

      if (shouldUseMulti) {
        this.logDownload("multi-thread download enabled", downloadUrl, {
          host: hostname,
          size: metadata.contentLength,
          threads: this.config.multiThreadCount,
        });
        try {
          await downloadMultiThread(
            downloadUrl,
            tempPath,
            headers,
            this.config.downloadTimeoutMs,
            metadata.contentLength,
            this.config.multiThreadCount,
            getAgent,
          );
        } catch (error) {
          await removeIfExists(tempPath);
          this.logDownload("multi-thread fallback to single-thread", downloadUrl, {
            host: hostname,
            reason: error.message,
          });
          await downloadSingle(downloadUrl, tempPath, headers, this.config.downloadTimeoutMs, getAgent);
        }
      } else {
        this.logDownload("single-thread download", downloadUrl, { host: hostname });
        const single = await downloadSingle(downloadUrl, tempPath, headers, this.config.downloadTimeoutMs, getAgent);
        if (single.contentLength != null) {
          metadata.contentLength = single.contentLength;
        }
      }

      await verifyFileSize(tempPath, metadata.contentLength);
      await fs.promises.rename(tempPath, finalPath);

      const finalStats = await fs.promises.stat(finalPath);
      this.logDownload("download succeeded", downloadUrl, {
        host: hostname,
        targetPath: finalPath,
        size: finalStats.size,
        elapsedMs: Date.now() - startedAt,
      });

      // Write a meta.json in the file's directory recording the original download URL.
      // This helps serve related files (e.g., use the same upstream mirror to fetch .jar when .pom exists).
      try {
        const meta = {
          originalUrl: typeof downloadUrl === "string" ? downloadUrl : downloadUrl?.href,
          timestamp: new Date().toLocaleString(),
        };
        const metaPath = path.join(path.dirname(finalPath), "meta.json");
        const tmpMetaPath = `${metaPath}.tmp`;
        await fs.promises.writeFile(tmpMetaPath, JSON.stringify(meta), "utf8");
        await fs.promises.rename(tmpMetaPath, metaPath);
      } catch (err) {
        this.logDownload("meta write failed", downloadUrl, {
          targetDir: path.dirname(finalPath),
          message: err?.message || String(err),
        });
      }
    } catch (error) {
      if (isLocalFsWriteError(error)) {
        if (!error.statusCode) {
          error.statusCode = 500;
        }

        this.logDownload("local cache write failed", urlObj, {
          code: error.code || "UNKNOWN",
          targetPath: finalPath,
          tempPath,
          message: error.message,
        });
      }

      this.logDownload("download failed", urlObj, {
        host: toHost(urlObj),
        code: error.code || "UNKNOWN",
        statusCode: error.statusCode || 0,
        targetPath: finalPath,
        tempPath,
        message: error.message,
        upstreamBodyPreview: toBodyPreview(error.upstreamBody),
      });

      await removeIfExists(tempPath);
      throw error;
    }
  }
}
