import fs from "node:fs";
import { config } from "./config/config.js";
import { matchesDomain } from "./common/domain-match.js";
import { CertManager } from "./cert/cert-manager.js";
import { Downloader } from "./cache/downloader.js";
import { startProxyServer } from "./proxy/proxy-server.js";
import { startRepoServer } from "./repo/repo-server.js";
import { getTrustStoreCommands } from "./cert/truststore-utils.js";
import { UpstreamProxyManager } from "./proxy/upstream-proxy.js";
import { MavenAffinityIndex } from "./cache/maven-affinity-index.js";
import { installConsoleLogFileMirror, installGlobalErrorLogging } from "./common/console-log-file.js";

installConsoleLogFileMirror({
  logDir: config.downloadLogDir,
  retentionDays: config.logRetentionDays,
  outputToConsole: config.logToStdout,
});
installGlobalErrorLogging();

async function main() {
  await fs.promises.mkdir(config.cacheDir, { recursive: true });
  await fs.promises.mkdir(config.mavenCacheDir, { recursive: true });
  await fs.promises.mkdir(config.npmCacheDir, { recursive: true });
  await fs.promises.mkdir(config.genericCacheDir, { recursive: true });
  await fs.promises.mkdir(config.downloadLogDir, { recursive: true });
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
  const mavenAffinityIndex = new MavenAffinityIndex(config);
  await mavenAffinityIndex.init();

  const downloader = new Downloader(config, matchesDomain, upstreamProxyManager);

  const { proxyServer, mitmHttpServer } = startProxyServer(
    config,
    certManager,
    downloader,
    matchesDomain,
    upstreamProxyManager,
    mavenAffinityIndex,
  );
  const repoServer = startRepoServer(config, downloader);

  const trustCommands = getTrustStoreCommands(config);

  console.log("[maven-proxy] started");
  console.log(`[maven-proxy] config mode: ${config.configMode}`);
  console.log(`[maven-proxy] config file: ${config.loadedConfigFile || "(none)"}`);
  console.log(`[maven-proxy] config base: ${config.configBaseDir}`);
  if (config.configMode === "user") {
    console.log(`[maven-proxy] default user config: ${config.defaultUserConfigPath}`);
  }
  console.log(`[maven-proxy] proxy port: ${config.proxyPort}`);
  console.log(`[maven-proxy] repo  port: ${config.repoPort}`);
  console.log(`[maven-proxy] cache dir : ${config.cacheDir}`);
  console.log(`[maven-proxy] cache maven: ${config.mavenCacheDir}`);
  console.log(`[maven-proxy] cache npm  : ${config.npmCacheDir}`);
  console.log(`[maven-proxy] cache other: ${config.genericCacheDir}`);
  console.log(`[maven-proxy] log dir: ${config.downloadLogDir}`);
  console.log(`[maven-proxy] log retention days: ${config.logRetentionDays}`);
  console.log(`[maven-proxy] log to stdout: ${config.logToStdout}`);
  console.log(`[maven-proxy] outbound keep-alive: ${config.outboundKeepAlive}`);
  console.log(`[maven-proxy] outbound keepAliveMsecs: ${config.outboundKeepAliveMsecs}`);
  console.log(`[maven-proxy] outbound maxSockets: ${config.outboundMaxSockets}`);
  console.log(`[maven-proxy] outbound maxFreeSockets: ${config.outboundMaxFreeSockets}`);
  console.log(`[maven-proxy] maven affinity enabled: ${config.mavenAffinityEnabled}`);
  console.log(`[maven-proxy] maven affinity index dir: ${config.mavenAffinityIndexDir}`);
  console.log(`[maven-proxy] maven negative cache ttl(ms): ${config.mavenNegativeCacheTtlMs}`);
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
    upstreamProxyManager.destroy();
    void mavenAffinityIndex.destroy();
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error("[maven-proxy] fatal error:", error);
  process.exit(1);
});
