import net from "node:net";
import tls from "node:tls";

function parseConnectTarget(rawUrl) {
  const [host, portText] = String(rawUrl || "").split(":");
  const port = Number.parseInt(portText || "443", 10);
  return {
    host,
    port: Number.isFinite(port) ? port : 443,
  };
}

function writeTunnelResponse(socket, statusLine, callback) {
  socket.write(`${statusLine}\r\n\r\n`, callback);
}

async function openConnectUpstreamSocket(targetHost, targetPort, timeoutMs, upstreamProxyManager = null) {
  const useUpstreamProxy =
    upstreamProxyManager &&
    upstreamProxyManager.hasProxyFor("https:", targetHost);

  if (useUpstreamProxy) {
    if (upstreamProxyManager?.config?.logConnectEvents) {
      console.log(`[proxy] CONNECT via upstream target=${targetHost}:${targetPort}`);
    }
    const tunnel = await upstreamProxyManager.createConnectTunnel(targetHost, targetPort, timeoutMs);
    return {
      upstreamSocket: tunnel.socket,
      bufferedData: tunnel.bufferedData || Buffer.alloc(0),
    };
  }

  const upstreamSocket = await new Promise((resolve, reject) => {
    const socket = net.connect(targetPort, targetHost, () => resolve(socket));
    socket.once("error", reject);
  });

  return {
    upstreamSocket,
    bufferedData: Buffer.alloc(0),
  };
}

async function handlePassThroughConnect(clientSocket, head, targetHost, targetPort, timeoutMs, upstreamProxyManager = null) {
  const { upstreamSocket, bufferedData } = await openConnectUpstreamSocket(
    targetHost,
    targetPort,
    timeoutMs,
    upstreamProxyManager,
  );

  await new Promise((resolve, reject) => {
    writeTunnelResponse(clientSocket, "HTTP/1.1 200 Connection Established", (error) => {
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
      writeTunnelResponse(clientSocket, "HTTP/1.1 502 Bad Gateway");
      clientSocket.destroy(error);
    }
  });

  clientSocket.on("error", () => {
    upstreamSocket.destroy();
  });
}

async function handleMitmConnect(clientSocket, head, targetHost, certManager, mitmHttpServer) {
  if (certManager?.config?.logConnectEvents) {
    console.log(`[proxy] MITM prepare ${targetHost}`);
  }
  const leaf = await certManager.getOrCreateLeaf(targetHost);
  if (certManager?.config?.logConnectEvents) {
    console.log(`[proxy] MITM cert ready ${targetHost}`);
  }

  await new Promise((resolve, reject) => {
    writeTunnelResponse(clientSocket, "HTTP/1.1 200 Connection Established", (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
  if (certManager?.config?.logConnectEvents) {
    console.log(`[proxy] MITM tunnel established ${targetHost}`);
  }

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

export function attachConnectHandler(server, {
  config,
  certManager,
  matchesDomain,
  upstreamProxyManager = null,
  mitmHttpServer,
}) {
  server.on("connect", (req, clientSocket, head) => {
    const { host, port } = parseConnectTarget(req.url);

    if (!host) {
      writeTunnelResponse(clientSocket, "HTTP/1.1 400 Bad Request");
      clientSocket.destroy();
      return;
    }

    const mitmEnabled =
      (config.enableHttpsProxy &&
        matchesDomain(host, config.httpsMitmDomains)) ||
      !config.httpsPassthroughForUnmatched;

    if (config.logConnectEvents) {
      console.log(`[proxy] CONNECT ${host}:${port} mitm=${mitmEnabled}`);
    }

    if (!mitmEnabled) {
      if (!config.httpsPassthroughForUnmatched) {
        writeTunnelResponse(clientSocket, "HTTP/1.1 403 Forbidden");
        clientSocket.destroy();
        return;
      }

      handlePassThroughConnect(
        clientSocket,
        head,
        host,
        port,
        config.downloadTimeoutMs,
        upstreamProxyManager,
      ).catch((error) => {
        if (!clientSocket.destroyed) {
          writeTunnelResponse(clientSocket, "HTTP/1.1 502 Bad Gateway");
          clientSocket.destroy(error);
        }
      });
      return;
    }

    handleMitmConnect(clientSocket, head, host, certManager, mitmHttpServer).catch((error) => {
      if (!clientSocket.destroyed) {
        writeTunnelResponse(clientSocket, "HTTP/1.1 502 Bad Gateway");
      }
      clientSocket.destroy(error);
    });
  });
}
