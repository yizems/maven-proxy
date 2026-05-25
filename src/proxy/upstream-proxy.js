import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { ProxyAgent } from "proxy-agent";

function toPositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function buildAgentOptions(config) {
  return {
    keepAlive: Boolean(config.outboundKeepAlive),
    keepAliveMsecs: toPositiveInt(config.outboundKeepAliveMsecs, 1000),
    maxSockets: toPositiveInt(config.outboundMaxSockets, 64),
    maxFreeSockets: toPositiveInt(config.outboundMaxFreeSockets, 16),
  };
}

function normalizeHostname(hostname) {
  return String(hostname || "")
    .trim()
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .toLowerCase();
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function buildProxyAuthHeader(proxyUrl) {
  if (!proxyUrl.username && !proxyUrl.password) {
    return "";
  }

  const username = safeDecode(proxyUrl.username || "");
  const password = safeDecode(proxyUrl.password || "");
  const token = Buffer.from(`${username}:${password}`).toString("base64");
  return `Basic ${token}`;
}

function parseStatusCode(responseHeader) {
  const statusLine = responseHeader.split("\r\n")[0] || "";
  const match = statusLine.match(/^HTTP\/\d\.\d\s+(\d{3})/i);
  const code = match ? Number.parseInt(match[1], 10) : 0;
  return { code, statusLine };
}

function createSocketToProxy(proxyUrl, timeoutMs) {
  const port = proxyUrl.port
    ? Number.parseInt(proxyUrl.port, 10)
    : proxyUrl.protocol === "https:"
      ? 443
      : 80;

  if (proxyUrl.protocol === "https:") {
    return tls.connect({
      host: proxyUrl.hostname,
      port,
      servername: proxyUrl.hostname,
      timeout: timeoutMs,
    });
  }

  return net.connect({
    host: proxyUrl.hostname,
    port,
    timeout: timeoutMs,
  });
}

export class UpstreamProxyManager {
  constructor(config, matchesDomain) {
    this.config = config;
    this.matchesDomain = matchesDomain;
    this.agentCache = new Map();
    this.directHttpAgent = new http.Agent(buildAgentOptions(config));
    this.directHttpsAgent = new https.Agent(buildAgentOptions(config));
  }

  getDirectAgentForProtocol(protocol) {
    return protocol === "https:" ? this.directHttpsAgent : this.directHttpAgent;
  }

  shouldBypass(hostname) {
    const host = normalizeHostname(hostname);
    if (!host) {
      return true;
    }

    const patterns = [
      ...(this.config.upstreamNoProxyDomains || []),
      ...(this.config.upstreamIgnoreDomains || []),
    ];

    const uniquePatterns = [...new Set(patterns.map((item) => String(item).trim()).filter(Boolean))];
    if (uniquePatterns.length === 0) {
      return false;
    }

    if (uniquePatterns.includes("*")) {
      return true;
    }

    return this.matchesDomain(host, uniquePatterns);
  }

  getProxyUrlFor(protocol, hostname) {
    if (this.shouldBypass(hostname)) {
      return "";
    }

    if (protocol === "https:") {
      return (
        this.config.upstreamHttpsProxyUrl ||
        this.config.upstreamProxyUrl ||
        this.config.upstreamHttpProxyUrl ||
        ""
      );
    }

    return (
      this.config.upstreamHttpProxyUrl ||
      this.config.upstreamProxyUrl ||
      ""
    );
  }

  getAgentForUrl(urlObj) {
    const protocol = urlObj?.protocol === "https:" ? "https:" : "http:";
    const hostname = String(urlObj?.hostname || "");
    const proxyUrl = this.getProxyUrlFor(protocol, hostname);

    if (!proxyUrl) {
      return this.getDirectAgentForProtocol(protocol);
    }

    const cacheKey = `proxy:${proxyUrl}`;
    if (!this.agentCache.has(cacheKey)) {
      // proxy-agent v6 expects resolver-style options for deterministic proxy routing.
      this.agentCache.set(
        cacheKey,
        new ProxyAgent({
          ...buildAgentOptions(this.config),
          getProxyForUrl: () => proxyUrl,
        }),
      );
    }

    return this.agentCache.get(cacheKey);
  }

  hasProxyFor(protocol, hostname) {
    return Boolean(this.getProxyUrlFor(protocol, hostname));
  }

  destroy() {
    for (const agent of this.agentCache.values()) {
      if (typeof agent?.destroy === "function") {
        agent.destroy();
      }
    }

    this.agentCache.clear();
    this.directHttpAgent.destroy();
    this.directHttpsAgent.destroy();
  }

  async createConnectTunnel(targetHost, targetPort, timeoutMs) {
    const proxyUrlText = this.getProxyUrlFor("https:", targetHost);
    if (!proxyUrlText) {
      throw new Error("Upstream proxy is not configured for CONNECT");
    }

    const proxyUrl = new URL(proxyUrlText);
    if (proxyUrl.protocol !== "http:" && proxyUrl.protocol !== "https:") {
      throw new Error(`Unsupported upstream proxy protocol for CONNECT: ${proxyUrl.protocol}`);
    }

    const authHeader = buildProxyAuthHeader(proxyUrl);

    const socket = createSocketToProxy(proxyUrl, timeoutMs);
    const connectEvent = proxyUrl.protocol === "https:" ? "secureConnect" : "connect";

    return new Promise((resolve, reject) => {
      let settled = false;
      let bytes = 0;
      const chunks = [];

      const cleanup = () => {
        socket.removeListener(connectEvent, onConnectReady);
        socket.removeListener("data", onData);
        socket.removeListener("timeout", onTimeout);
        socket.removeListener("error", onError);
      };

      const fail = (error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        socket.destroy();
        reject(error);
      };

      const succeed = (bufferedData) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        socket.setTimeout(0);
        resolve({ socket, bufferedData });
      };

      const onConnectReady = () => {
        const headers = [
          `CONNECT ${targetHost}:${targetPort} HTTP/1.1`,
          `Host: ${targetHost}:${targetPort}`,
          "Proxy-Connection: Keep-Alive",
        ];

        if (authHeader) {
          headers.push(`Proxy-Authorization: ${authHeader}`);
        }

        const payload = `${headers.join("\r\n")}\r\n\r\n`;
        socket.write(payload);
      };

      const onData = (chunk) => {
        chunks.push(chunk);
        bytes += chunk.length;

        if (bytes > 128 * 1024) {
          fail(new Error("Upstream proxy CONNECT response is too large"));
          return;
        }

        const merged = Buffer.concat(chunks, bytes);
        const boundary = merged.indexOf("\r\n\r\n");
        if (boundary === -1) {
          return;
        }

        const headerBuffer = merged.slice(0, boundary + 4);
        const headerText = headerBuffer.toString("latin1");
        const { code, statusLine } = parseStatusCode(headerText);

        if (code !== 200) {
          fail(new Error(`Upstream proxy CONNECT failed: ${statusLine || "unknown response"}`));
          return;
        }

        const rest = merged.slice(boundary + 4);
        succeed(rest);
      };

      const onTimeout = () => {
        fail(new Error(`Upstream proxy CONNECT timeout after ${timeoutMs}ms`));
      };

      const onError = (error) => {
        fail(error);
      };

      socket.on(connectEvent, onConnectReady);
      socket.on("data", onData);
      socket.on("timeout", onTimeout);
      socket.on("error", onError);
    });
  }
}
