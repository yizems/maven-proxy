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

export function startRepoServer(config) {
  const server = http.createServer(async (req, res) => {
    try {
      const urlObj = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      const filePath = safeJoin(config.cacheDir, urlObj.pathname);
      const stats = await statIfExists(filePath);

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
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end(`Repo server error: ${error.message}`);
    }
  });

  server.listen(config.repoPort);
  return server;
}
