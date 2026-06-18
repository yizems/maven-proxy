// CommonJS entry point for process managers (pm2, etc.)
// pm2 uses require() which cannot load ES modules directly.
// This wrapper uses dynamic import() to bridge CJS → ESM.
//
// Usage:
//   pm2 start "$(npm root -g)/maven-proxy/bin/server.cjs" --name maven-proxy
//   pm2 start /usr/local/lib/node_modules/maven-proxy/bin/server.cjs --name maven-proxy

if (!process.env.MAVEN_PROXY_CONFIG_MODE) {
  process.env.MAVEN_PROXY_CONFIG_MODE = "user";
}

import("../src/index.js").catch((err) => {
  console.error("[maven-proxy] fatal error:", err.message);
  process.exit(1);
});
