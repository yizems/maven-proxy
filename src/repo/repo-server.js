import fs from "node:fs";
import http from "node:http";
import path from "node:path";

function safeJoin(baseDir, requestPath) {
  const pathname = decodeURIComponent(requestPath || "/");
  const normalized = path.posix.normalize(pathname).replace(/^\/+/, "");

  if (normalized.includes("..")) {
    throw new Error("Path traversal is not allowed");
  }

  return path.join(baseDir, normalized);
}

async function statIfExists(filePath) {
  try {
    return await fs.promises.stat(filePath);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function buildRemoteUrl(repoBase, relativePath) {
  const base = repoBase.endsWith("/") ? repoBase : `${repoBase}/`;
  const relative = relativePath.replace(/^\/+/, "");
  return new URL(relative, base);
}

function buildCandidateRelativePaths(relativePath) {
  const normalized = relativePath.replace(/^\/+/, "");
  const candidates = [normalized];

  if (normalized.toLowerCase().startsWith("maven2/")) {
    candidates.push(normalized.slice("maven2/".length));
  }

  return [...new Set(candidates.filter(Boolean))];
}

async function ensureFromRemoteRepos(config, downloader, filePath, relativePath) {
  if (!downloader) {
    return null;
  }

  const repos = config.repoFallbackRepos || [];
  if (repos.length === 0) {
    return null;
  }

  let hasNon404Error = false;
  let lastError = null;
  const candidatePaths = buildCandidateRelativePaths(relativePath);

  for (const repoBase of repos) {
    for (const candidatePath of candidatePaths) {
      const remoteUrl = buildRemoteUrl(repoBase, candidatePath);

      try {
        console.log(`[repo] cache miss, try remote ${remoteUrl.href}`);
        await downloader.ensureCached(remoteUrl, filePath, {});
        return await statIfExists(filePath);
      } catch (error) {
        lastError = error;
        if (error.statusCode !== 404) {
          hasNon404Error = true;
        }
      }
    }
  }

  if (hasNon404Error && lastError) {
    throw lastError;
  }

  return null;
}

export function startRepoServer(config, downloader = null) {
  const server = http.createServer(async (req, res) => {
    try {
      const urlObj = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      const relativePath = path.posix.normalize(urlObj.pathname || "/").replace(/^\/+/, "");
      const filePath = safeJoin(config.cacheDir, relativePath);
      let stats = await statIfExists(filePath);

      if (!stats || !stats.isFile()) {
        stats = await ensureFromRemoteRepos(config, downloader, filePath, relativePath);
      }

      if (!stats || !stats.isFile()) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("Not Found");
        return;
      }

      res.setHeader("content-length", String(stats.size));
      res.setHeader("cache-control", "public, max-age=3600");

      if (req.method === "HEAD") {
        res.writeHead(200);
        res.end();
        return;
      }

      res.writeHead(200);
      fs.createReadStream(filePath).pipe(res);
    } catch (error) {
      const statusCode = error.statusCode && error.statusCode >= 400 ? 502 : 500;
      res.writeHead(statusCode, { "content-type": "text/plain; charset=utf-8" });
      res.end(`Repo server error: ${error.message}`);
    }
  });

  server.listen(config.repoPort);
  return server;
}
