import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import path from "node:path";
import { getCacheFilePath } from "./cache-path.js";

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

function forwardDirect(req, res, urlObj, timeoutMs, upstreamProxyManager = null) {
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
      sendText(res, 502, `Proxy forward failed: ${error.message}`);
    } else {
      res.destroy(error);
    }
  });

  req.pipe(upstreamReq);
}

function splitConnectHost(rawUrl) {
  const [host, portText] = String(rawUrl || "").split(":");
  const port = Number.parseInt(portText || "443", 10);
  return {
    host,
    port: Number.isFinite(port) ? port : 443,
  };
}

export function startProxyServer(config, certManager, downloader, matchesDomain, upstreamProxyManager = null) {
  const mitmHttpServer = http.createServer((req, res) => {
    handleProxyRequest(req, res, "https:").catch((error) => {
      sendText(res, 500, `MITM request failed: ${error.message}`);
    });
  });

  mitmHttpServer.on("clientError", (error, socket) => {
    socket.destroy(error);
  });

  async function handleProxyRequest(req, res, forcedProtocol = null) {
    let urlObj;
    try {
      urlObj = buildUrl(req, forcedProtocol);
    } catch (error) {
      sendText(res, 400, `Bad request: ${error.message}`);
      return;
    }

    const method = (req.method || "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      forwardDirect(req, res, urlObj, config.downloadTimeoutMs, upstreamProxyManager);
      return;
    }

    let cachePath;
    try {
      cachePath = getCacheFilePath(config.cacheDir, urlObj);
    } catch (error) {
      sendText(res, 400, `Invalid cache path: ${error.message}`);
      return;
    }

    const existing = await statIfFile(cachePath);
    if (existing) {
      await serveFile(res, req, cachePath);
      return;
    }

    try {
      await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
      await downloader.ensureCached(urlObj, cachePath, req.headers);
      res.setHeader("x-cache", "MISS");
      await serveFile(res, req, cachePath);
    } catch (error) {
      const statusCode = error.statusCode || 502;
      sendText(res, statusCode, `Download failed: ${error.message}`);
    }
  }

  async function handlePassThroughConnect(req, clientSocket, head, targetHost, targetPort) {
    const useUpstreamProxy =
      upstreamProxyManager &&
      upstreamProxyManager.hasProxyFor("https:", targetHost);

    let upstreamSocket;
    let bufferedData = Buffer.alloc(0);

    if (useUpstreamProxy) {
      console.log(`[proxy] CONNECT via upstream target=${targetHost}:${targetPort}`);
      const tunnel = await upstreamProxyManager.createConnectTunnel(targetHost, targetPort, config.downloadTimeoutMs);
      upstreamSocket = tunnel.socket;
      bufferedData = tunnel.bufferedData || Buffer.alloc(0);
    } else {
      upstreamSocket = await new Promise((resolve, reject) => {
        const socket = net.connect(targetPort, targetHost, () => resolve(socket));
        socket.once("error", reject);
      });
    }

    await new Promise((resolve, reject) => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n", (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

    if (head && head.length > 0) {
      upstreamSocket.write(head);
    }

    if (bufferedData.length > 0) {
      clientSocket.write(bufferedData);
    }

    upstreamSocket.pipe(clientSocket);
    clientSocket.pipe(upstreamSocket);

    upstreamSocket.on("error", (error) => {
      if (!clientSocket.destroyed) {
        clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
        clientSocket.destroy(error);
      }
    });

    clientSocket.on("error", () => {
      upstreamSocket.destroy();
    });
  }

  async function handleMitmConnect(req, clientSocket, head, targetHost) {
    console.log(`[proxy] MITM prepare ${targetHost}`);
    const leaf = await certManager.getOrCreateLeaf(targetHost);
    console.log(`[proxy] MITM cert ready ${targetHost}`);

    await new Promise((resolve, reject) => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n", (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    console.log(`[proxy] MITM tunnel established ${targetHost}`);

    const tlsSocket = new tls.TLSSocket(clientSocket, {
      isServer: true,
      secureContext: tls.createSecureContext({
        key: leaf.keyPem,
        cert: leaf.certPem,
      }),
      ALPNProtocols: ["http/1.1"],
    });

    tlsSocket.__mitmHost = targetHost;

    if (head && head.length > 0) {
      tlsSocket.unshift(head);
    }

    tlsSocket.on("error", () => {
      tlsSocket.destroy();
    });

    mitmHttpServer.emit("connection", tlsSocket);
  }

  const server = http.createServer((req, res) => {
    handleProxyRequest(req, res, null).catch((error) => {
      sendText(res, 500, `Proxy request failed: ${error.message}`);
    });
  });

  server.on("connect", (req, clientSocket, head) => {
    const { host, port } = splitConnectHost(req.url);

    if (!host) {
      clientSocket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      clientSocket.destroy();
      return;
    }

    const mitmEnabled =
      config.enableHttpsProxy &&
      matchesDomain(host, config.httpsMitmDomains);

    console.log(`[proxy] CONNECT ${host}:${port} mitm=${mitmEnabled}`);

    if (!mitmEnabled) {
      if (!config.httpsPassthroughForUnmatched) {
        clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        clientSocket.destroy();
        return;
      }

      handlePassThroughConnect(req, clientSocket, head, host, port).catch((error) => {
        if (!clientSocket.destroyed) {
          clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
          clientSocket.destroy(error);
        }
      });
      return;
    }

    handleMitmConnect(req, clientSocket, head, host).catch((error) => {
      if (!clientSocket.destroyed) {
        clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      }
      clientSocket.destroy(error);
    });
  });

  server.listen(config.proxyPort);
  return { proxyServer: server, mitmHttpServer };
}
