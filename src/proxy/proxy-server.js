import http from "node:http";
import { createHttpRequestHandler, createMitmHttpServer } from "./proxy-http-handler.js";
import { attachConnectHandler } from "./proxy-connect-handler.js";

function sendText(res, statusCode, message) {
  res.writeHead(statusCode, { "content-type": "text/plain; charset=utf-8" });
  res.end(message);
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
      sendText(res, 500, `Proxy request failed: ${error.message}`);
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
