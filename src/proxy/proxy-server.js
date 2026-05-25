import http from "node:http";
import { createHttpRequestHandler, createMitmHttpServer } from "./proxy-http-handler.js";
import { attachConnectHandler } from "./proxy-connect-handler.js";

function sendText(res, statusCode, message) {
  res.writeHead(statusCode, { "content-type": "text/plain; charset=utf-8" });
  res.end(message);
}

function sendErrorText(res, statusCode, message) {
  console.error(`[proxy] response error status=${statusCode} message=${message}`);
  sendText(res, statusCode, message);
}

export function startProxyServer(config, certManager, downloader, matchesDomain, upstreamProxyManager = null) {
  const handleHttpRequestPath = createHttpRequestHandler({
    config,
    downloader,
    upstreamProxyManager,
    matchesDomain,
  });
  const mitmHttpServer = createMitmHttpServer(handleHttpRequestPath);

  const server = http.createServer((req, res) => {
    handleHttpRequestPath(req, res, null).catch((error) => {
      const message = `Proxy request failed: ${error.message}`;
      sendErrorText(res, 500, message);
    });
  });

  attachConnectHandler(server, {
    config,
    certManager,
    matchesDomain,
    upstreamProxyManager,
    mitmHttpServer,
  });

  server.listen(config.proxyPort);
  return { proxyServer: server, mitmHttpServer };
}
