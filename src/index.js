import fs from "node:fs";
import { config } from "./config/config.js";
import { matchesDomain } from "./common/domain-match.js";
import { CertManager } from "./cert/cert-manager.js";
import { Downloader } from "./cache/downloader.js";
import { startProxyServer } from "./proxy/proxy-server.js";
import { startRepoServer } from "./repo/repo-server.js";
import { getTrustStoreCommands } from "./cert/truststore-utils.js";
import { UpstreamProxyManager } from "./proxy/upstream-proxy.js";

async function main() {
  await fs.promises.mkdir(config.cacheDir, { recursive: true });
  await fs.promises.mkdir(config.certDir, { recursive: true });
  await fs.promises.mkdir(config.leafCertDir, { recursive: true });

  const certManager = new CertManager(config);
  await certManager.init();

  for (const pattern of config.httpsMitmDomains) {
    if (!pattern.includes("*")) {
      await certManager.getOrCreateLeaf(pattern);
    }
  }

  const upstreamProxyManager = new UpstreamProxyManager(config, matchesDomain);

  const downloader = new Downloader(config, matchesDomain, upstreamProxyManager);

  const { proxyServer, mitmHttpServer } = startProxyServer(
    config,
    certManager,
    downloader,
    matchesDomain,
    upstreamProxyManager,
  );
  const repoServer = startRepoServer(config, downloader);

  const trustCommands = getTrustStoreCommands(config);

  console.log("[maven-proxy] started");
  console.log(`[maven-proxy] proxy port: ${config.proxyPort}`);
  console.log(`[maven-proxy] repo  port: ${config.repoPort}`);
  console.log(`[maven-proxy] cache dir : ${config.cacheDir}`);
  console.log(`[maven-proxy] root cert : ${config.rootCertPath}`);
  console.log(`[maven-proxy] repo fallback repos: ${(config.repoFallbackRepos || []).join(",") || "(none)"}`);
  if (config.upstreamProxyUrl || config.upstreamHttpProxyUrl || config.upstreamHttpsProxyUrl) {
    console.log(`[maven-proxy] upstream proxy (generic): ${config.upstreamProxyUrl || "(none)"}`);
    console.log(`[maven-proxy] upstream proxy (http)   : ${config.upstreamHttpProxyUrl || "(none)"}`);
    console.log(`[maven-proxy] upstream proxy (https)  : ${config.upstreamHttpsProxyUrl || "(none)"}`);
    console.log(`[maven-proxy] upstream no-proxy       : ${(config.upstreamNoProxyDomains || []).join(",") || "(none)"}`);
    console.log(`[maven-proxy] upstream ignore-domains : ${(config.upstreamIgnoreDomains || []).join(",") || "(none)"}`);
  }
  console.log("[maven-proxy] trust store command (copy):");
  console.log(trustCommands.copyCmd);
  console.log("[maven-proxy] trust store command (import):");
  console.log(trustCommands.importCmd);

  const shutdown = () => {
    proxyServer.close();
    mitmHttpServer.close();
    repoServer.close();
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error("[maven-proxy] fatal error:", error);
  process.exit(1);
});
