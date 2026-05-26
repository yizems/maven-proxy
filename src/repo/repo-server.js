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

function sanitizeHostSegment(hostname) {
  return String(hostname || "unknown").toLowerCase().replace(/[<>:\\"|?*]/g, "_");
}

function collectRepoHosts(repoBases = []) {
  const hosts = new Set();

  for (const repoBase of repoBases) {
    try {
      const parsed = new URL(repoBase);
      hosts.add(sanitizeHostSegment(parsed.hostname));
    } catch {
      // ignore invalid URL
    }
  }

  return [...hosts];
}

function buildDomainScopedPath(mavenCacheDir, hostname, relativePath) {
  const hostDir = sanitizeHostSegment(hostname);
  return safeJoin(path.join(mavenCacheDir, hostDir), relativePath);
}

function buildDefaultRepoFilePath(config, relativePath) {
  if (!config.mavenCacheUseDomainDir) {
    return safeJoin(config.mavenCacheDir, relativePath);
  }

  const hosts = collectRepoHosts(config.repoFallbackRepos || []);
  const host = hosts[0] || "unknown";
  return buildDomainScopedPath(config.mavenCacheDir, host, relativePath);
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

async function findCachedMavenFile(config, relativePath) {
  if (!config.mavenCacheUseDomainDir) {
    const filePath = safeJoin(config.mavenCacheDir, relativePath);
    const stats = await statIfExists(filePath);
    return { filePath, stats };
  }

  const checkedHosts = new Set();
  const preferredHosts = collectRepoHosts(config.repoFallbackRepos || []);

  for (const host of preferredHosts) {
    checkedHosts.add(host);
    const filePath = buildDomainScopedPath(config.mavenCacheDir, host, relativePath);
    const stats = await statIfExists(filePath);
    if (stats && stats.isFile()) {
      return { filePath, stats };
    }
  }

  let entries = [];
  try {
    entries = await fs.promises.readdir(config.mavenCacheDir, { withFileTypes: true });
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    if (checkedHosts.has(entry.name)) {
      continue;
    }

    const filePath = safeJoin(path.join(config.mavenCacheDir, entry.name), relativePath);
    const stats = await statIfExists(filePath);
    if (stats && stats.isFile()) {
      return { filePath, stats };
    }
  }

  return {
    filePath: buildDefaultRepoFilePath(config, relativePath),
    stats: null,
  };
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

async function ensureFromRemoteRepos(config, downloader, relativePath, cacheCleanupManager = null) {
  if (!downloader) {
    return { filePath: buildDefaultRepoFilePath(config, relativePath), stats: null };
  }

  const repos = config.repoFallbackRepos || [];
  if (repos.length === 0) {
    return { filePath: buildDefaultRepoFilePath(config, relativePath), stats: null };
  }

  let hasNon404Error = false;
  let lastError = null;
  const candidatePaths = buildCandidateRelativePaths(relativePath);

  for (const repoBase of repos) {
    for (const candidatePath of candidatePaths) {
      const remoteUrl = buildRemoteUrl(repoBase, candidatePath);

      try {
        const targetPath = config.mavenCacheUseDomainDir
          ? buildDomainScopedPath(config.mavenCacheDir, remoteUrl.hostname, relativePath)
          : safeJoin(config.mavenCacheDir, relativePath);

        if (cacheCleanupManager) {
          await cacheCleanupManager.checkAndCleanupIfNeeded("repo-cache-miss");
        }
        console.log(`[repo] cache miss, try remote ${remoteUrl.href}`);
        await downloader.ensureCached(remoteUrl, targetPath, {});
        return {
          filePath: targetPath,
          stats: await statIfExists(targetPath),
        };
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

  return { filePath: buildDefaultRepoFilePath(config, relativePath), stats: null };
}

export function startRepoServer(config, downloader = null, cacheCleanupManager = null) {
  const server = http.createServer(async (req, res) => {
    try {
      const urlObj = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      const relativePath = path.posix.normalize(urlObj.pathname || "/").replace(/^\/+/, "");
      let { filePath, stats } = await findCachedMavenFile(config, relativePath);

      if (!stats || !stats.isFile()) {
        const fetched = await ensureFromRemoteRepos(config, downloader, relativePath, cacheCleanupManager);
        filePath = fetched.filePath;
        stats = fetched.stats;
      }

      if (!stats || !stats.isFile()) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("Not Found");
        return;
      }

      res.setHeader("content-length", String(stats.size));
      res.setHeader("cache-control", "public, max-age=3600");

      if (cacheCleanupManager) {
        cacheCleanupManager.touchFileOnHit(filePath);
      }

      if (req.method === "HEAD") {
        res.writeHead(200);
        res.end();
        return;
      }

      res.writeHead(200);
      fs.createReadStream(filePath).pipe(res);
    } catch (error) {
      const statusCode = error.statusCode && error.statusCode >= 400 ? 502 : 500;
      const message = `Repo server error: ${error.message}`;
      console.error(`[repo] response error status=${statusCode} message=${message}`);
      res.writeHead(statusCode, { "content-type": "text/plain; charset=utf-8" });
      res.end(message);
    }
  });

  server.listen(config.repoPort);
  return server;
}
