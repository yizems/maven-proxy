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

function startupInfo(message) {
  if (!config.logToStdout) {
    process.stdout.write(`${message}\n`);
  }
  console.log(message);
}

function startupError(message, error = null) {
  if (!config.logToStdout) {
    process.stderr.write(`${message}\n`);
    if (error) {
      process.stderr.write(`${error?.stack || error?.message || String(error)}\n`);
    }
  }
  if (error) {
    console.error(message, error);
  } else {
    console.error(message);
  }
}

async function waitForServerListening(server, name) {
  if (server?.listening) {
    return;
  }

  await new Promise((resolve, reject) => {
    const onListening = () => {
      cleanup();
      resolve();
    };

    const onError = (error) => {
      cleanup();
      reject(new Error(`${name} listen failed: ${error.message}`));
    };

    const cleanup = () => {
      server.off("listening", onListening);
      server.off("error", onError);
    };

    server.once("listening", onListening);
    server.once("error", onError);
  });
}

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

  await Promise.all([
    waitForServerListening(proxyServer, "proxy server"),
    waitForServerListening(repoServer, "repo server"),
  ]);

  const trustCommands = getTrustStoreCommands(config);

  startupInfo("[maven-proxy] started");
  startupInfo(`[maven-proxy] config mode: ${config.configMode}`);
  startupInfo(`[maven-proxy] config file: ${config.loadedConfigFile || "(none)"}`);
  startupInfo(`[maven-proxy] config base: ${config.configBaseDir}`);
  if (config.configMode === "user") {
    startupInfo(`[maven-proxy] default user config: ${config.defaultUserConfigPath}`);
  }
  startupInfo(`[maven-proxy] proxy port: ${config.proxyPort}`);
  startupInfo(`[maven-proxy] repo  port: ${config.repoPort}`);
  startupInfo(`[maven-proxy] cache dir : ${config.cacheDir}`);
  startupInfo(`[maven-proxy] cache maven: ${config.mavenCacheDir}`);
  startupInfo(`[maven-proxy] cache npm  : ${config.npmCacheDir}`);
  startupInfo(`[maven-proxy] cache other: ${config.genericCacheDir}`);
  startupInfo(`[maven-proxy] log dir: ${config.downloadLogDir}`);
  startupInfo(`[maven-proxy] log retention days: ${config.logRetentionDays}`);
  startupInfo(`[maven-proxy] log to stdout: ${config.logToStdout}`);
  startupInfo(`[maven-proxy] outbound keep-alive: ${config.outboundKeepAlive}`);
  startupInfo(`[maven-proxy] outbound keepAlive(seconds): ${config.outboundKeepAliveMsecs / 1000}`);
  startupInfo(`[maven-proxy] outbound maxSockets: ${config.outboundMaxSockets}`);
  startupInfo(`[maven-proxy] outbound maxFreeSockets: ${config.outboundMaxFreeSockets}`);
  startupInfo(`[maven-proxy] maven affinity enabled: ${config.mavenAffinityEnabled}`);
  startupInfo(`[maven-proxy] maven affinity index dir: ${config.mavenAffinityIndexDir}`);
  startupInfo(`[maven-proxy] maven negative cache ttl(hours): ${config.mavenNegativeCacheTtlMs / (60 * 60 * 1000)}`);
  startupInfo(`[maven-proxy] maven affinity flush interval(seconds): ${config.mavenAffinityFlushIntervalMs / 1000}`);
  startupInfo(`[maven-proxy] maven affinity event max(MB): ${config.mavenAffinityEventMaxBytes / (1024 * 1024)}`);
  startupInfo(`[maven-proxy] root cert : ${config.rootCertPath}`);
  startupInfo(`[maven-proxy] repo fallback repos: ${(config.repoFallbackRepos || []).join(",") || "(none)"}`);
  if (config.upstreamProxyUrl || config.upstreamHttpProxyUrl || config.upstreamHttpsProxyUrl) {
    startupInfo(`[maven-proxy] upstream proxy (generic): ${config.upstreamProxyUrl || "(none)"}`);
    startupInfo(`[maven-proxy] upstream proxy (http)   : ${config.upstreamHttpProxyUrl || "(none)"}`);
    startupInfo(`[maven-proxy] upstream proxy (https)  : ${config.upstreamHttpsProxyUrl || "(none)"}`);
    startupInfo(`[maven-proxy] upstream no-proxy       : ${(config.upstreamNoProxyDomains || []).join(",") || "(none)"}`);
    startupInfo(`[maven-proxy] upstream ignore-domains : ${(config.upstreamIgnoreDomains || []).join(",") || "(none)"}`);
  }
  startupInfo("[maven-proxy] trust store command (copy):");
  startupInfo(trustCommands.copyCmd);
  startupInfo("[maven-proxy] trust store command (import):");
  startupInfo(trustCommands.importCmd);
  startupInfo(`[maven-proxy] startup success: proxy=127.0.0.1:${config.proxyPort}, repo=127.0.0.1:${config.repoPort}`);

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
  startupError("[maven-proxy] fatal error:", error);
  process.exit(1);
});
