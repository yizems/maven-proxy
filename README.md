# Maven Proxy Requirements and Usage

[English](README.md) | [中文](README-zh.md)

[English ChangeLog](ChangeLog.md) | [中文更新日志](ChangeLog-zh.md)

[![npm version](https://img.shields.io/npm/v/maven-proxy.svg)](https://www.npmjs.com/package/maven-proxy)

## 1. Project Positioning

This project is a Maven proxy service used to improve dependency download speed and stability for Maven and Gradle.

Core goals:
- Expose a proxy port for Maven and Gradle clients.
- Cache dependency files locally and serve cached files on hits.
- Support HTTPS proxying, including Root CA based certificate issuance for selected domains.
- Enable multi-threaded downloading for selected domains.
- Expose a local Maven repository port so Gradle and Maven can consume cached artifacts directly.

## 2. Functional Requirements

### 2.1 Proxy Service Port
- The service must start on a configurable proxy port.
- Maven and Gradle requests should be processed through this proxy endpoint.

### 2.2 HTTPS Proxy and Certificate Issuance
- Support HTTPS proxy scenarios for Maven and Gradle repositories.
- Generate and persist a local Root CA certificate/key pair.
- For matched domains, dynamically issue leaf certificates from the local Root CA.
- For unmatched HTTPS targets, allow passthrough tunnel behavior based on configuration.
- Reuse persisted CA files across restarts.

### 2.3 Cache Hit and Fallback Download
When a dependency is requested:
1. Check the local cache path first.
2. If found and valid, return the cached file.
3. If missing, download from upstream.
4. Download to a temporary file with a .temp suffix first.
5. Atomically rename .temp to final file only after completion and integrity checks.
6. Return the final cached file.

Failure handling:
- Never leave partial final files.
- Clean up temporary files after failures.

### 2.4 Multi-thread Download by Domain
- Domain-based strategy is supported for fallback downloads.
- Matched domains use multi-threaded download.
- Unmatched domains use single-threaded download.
- Thread count and threshold are configurable.

### 2.5 Local Repository Port
- Start an additional configurable repository port.
- Publish local cache as a Maven repository endpoint.
- Maven and Gradle can use this endpoint directly.
- If artifact is missing locally, fetch from configured fallback repositories, cache it, then return it.

### 2.6 Java Trust Store Support
- Provide trust store command templates for Java environments.
- Cover creating/copying trust store, importing Root CA, and verification.
- Include executable keytool examples for Windows and macOS.

### 2.7 Configurability
At minimum, these settings are configurable:
- Proxy service port.
- HTTPS proxy toggle.
- MITM domain matching rules.
- Root CA certificate and key paths.
- Local repository publish port.
- Cache directory.
- Multi-thread downloader options.
- Multi-thread domain matching rules.
- Trust store settings (path, alias, password behavior).

## 3. Main Flow

1. Client requests dependency through proxy port.
2. If HTTPS and host matches MITM rules, TLS is handled with Root CA issued certificate.
3. Service checks local cache.
4. On cache hit, return cached file.
5. On cache miss, fallback download begins.
6. Write to .temp first.
7. Verify integrity and atomically rename to final file.
8. Return final file.
9. Cached files are also available through repository port.

## 4. Java Trust Store Commands (Windows)

1. Copy default JDK cacerts to project trust store:

```powershell
Copy-Item "$env:JAVA_HOME\\lib\\security\\cacerts" ".\\data\\certs\\proxy-truststore.jks"
```

2. Import project Root CA:

```powershell
keytool -importcert -noprompt -trustcacerts `
  -alias maven-proxy-root-ca `
  -file .\\data\\certs\\root-ca.crt `
  -keystore .\\data\\certs\\proxy-truststore.jks `
  -storepass changeit
```

3. Verify imported certificate:

```powershell
keytool -list -v `
  -keystore .\\data\\certs\\proxy-truststore.jks `
  -storepass changeit `
  -alias maven-proxy-root-ca
```

4. JVM runtime flags:

```powershell
-Djavax.net.ssl.trustStore=.\\data\\certs\\proxy-truststore.jks
-Djavax.net.ssl.trustStorePassword=changeit
```

## 5. Out of Scope

- Authentication and authorization.
- Complex management UI.
- Cache eviction/TTL/capacity management.

## 6. Acceptance Criteria

- Proxy and repository ports both start successfully.
- Maven and Gradle can download via proxy.
- HTTPS proxy works; matched domains complete Root CA based MITM flow.
- Repeated dependency requests hit cache.
- Missing dependencies can be downloaded and cached.
- .temp files are used for in-progress downloads.
- Final files are created only through atomic rename.
- Multi-thread download is applied on configured domains.
- Repository port can serve cached dependencies to Maven and Gradle.
- Trust store operations can import Root CA successfully.
- Key settings are configurable.
- Repository fallback supports Maven Central, JitPack, Gradle Plugin Portal, and Google Maven by default.

## 7. Optional Future Enhancements

- Corrupted cache detection and repair.
- Better retry and circuit-breaker behavior.
- Access logs, hit-rate metrics, health checks.
- Cache cleanup and disk quota management.

## 8. Current Implementation and Runtime Guide

Source code is in src and uses Node.js ESM imports. Utility scripts are in scripts.

Suggested structure:

```text
src/
  index.js
  config/
    config.js
  common/
    domain-match.js
  cache/
    cache-path.js
    downloader.js
  cert/
    cert-manager.js
    truststore-utils.js
  proxy/
    proxy-server.js
    proxy-http-handler.js
    proxy-connect-handler.js
    upstream-proxy.js
  repo/
    repo-server.js
scripts/
  truststore.js
```

### 8.1 Start

1. Install dependencies:

```powershell
npm install
```

2. Configure environment variables as needed.

Notes:
- Development mode (default): npm start loads config.properties in the project root.
- User mode (CLI default): npx maven-proxy or global command uses ~/maven-proxy/config.properties.
- Override mode with MAVEN_PROXY_CONFIG_MODE as development or user.
- Override config file path with MAVEN_PROXY_CONFIG_FILE.
- JAVA_HOME supports auto-detection:
  - macOS: /usr/libexec/java_home
  - Windows: where java, then common JDK install paths
  - Linux: which java, then common JDK install directories

Useful Java path commands:
- macOS/Linux: echo $JAVA_HOME, which java, /usr/libexec/java_home (macOS only)
- Windows cmd: echo %JAVA_HOME%, where java
- Windows PowerShell: $env:JAVA_HOME, Get-Command java

3. Start service:

```powershell
npm start
```

Default ports:
- Proxy: 8080 (override with PROXY_PORT)
- Repository: 8081 (override with REPO_PORT)

### 8.2 Implemented Features

- HTTP and HTTPS proxy entry.
- Domain-based HTTPS MITM with Root CA issued leaf certs.
- Temporary file download + integrity check + atomic rename.
- Cache-miss GET now streams upstream bytes to client while writing `.temp` cache in parallel.
- Multi-thread download with thresholds.
- Upstream proxy support for outbound requests and CONNECT.
- npm proxy support for registry metadata and tarballs.
- Ecosystem-separated cache directories: cache/maven, cache/npm, cache/generic.
- Dedicated daily logs with retention.
- Local cache published as Maven repository.
- Trust store scripts and commands:
  - npm run truststore:print
  - npm run truststore:init
  - npm run truststore:merge -- --source <src.jks> --target <dest.jks>

### 8.3 Minimal Validation Commands (Windows)

1. Proxy download test (first MISS, second HIT):

```powershell
curl.exe -k -sS -D - -o NUL -x http://127.0.0.1:8080 https://repo1.maven.org/maven2/junit/junit/4.13.2/junit-4.13.2.pom
curl.exe -k -sS -D - -o NUL -x http://127.0.0.1:8080 https://repo1.maven.org/maven2/junit/junit/4.13.2/junit-4.13.2.pom
```

2. Repository port cache access:

```powershell
curl.exe -sS -D - -o NUL http://127.0.0.1:8081/maven2/junit/junit/4.13.2/junit-4.13.2.pom
```

3. Ensure no leftover .temp files:

```powershell
Get-ChildItem -Recurse -File .\data\cache -Filter '*.temp'
```

4. npm proxy validation:

```powershell
curl.exe -k -sS -D - -o NUL -x http://127.0.0.1:8080 https://registry.npmjs.org/lodash
curl.exe -k -sS -D - -o NUL -x http://127.0.0.1:8080 https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz
```

### 8.4 Upstream Proxy Settings

Environment variables:
- CACHE_CLEANUP_ENABLED: enable automatic cache cleanup.
- CACHE_CLEANUP_DAILY_AT: daily cleanup check time in local timezone (HH:mm), for example 03:00.
- CACHE_CLEANUP_CHECK_MIN_INTERVAL: minimum interval between pressure checks (supports s/m/h/d), for example 10m.
- CACHE_TOUCH_ON_HIT: update file mtime when cache hit returns successfully.
- CACHE_TOUCH_MIN_INTERVAL: minimum interval between two touches for the same file (supports s/m/h/d), default 1d.
- CACHE_RETENTION_START: initial retention window for cleanup rounds (supports s/m/h/d), default 10d.
- CACHE_RETENTION_MIN: minimum retention window for cleanup rounds (supports s/m/h/d), default 1d.
- CACHE_DISK_FREE_TRIGGER: trigger cleanup when disk free bytes are below this value (supports K/M/G/T), for example 20G.
- CACHE_DISK_FREE_TARGET: stop cleanup when disk free bytes recover to this value (supports K/M/G/T), for example 25G.
- CACHE_MAX_SIZE: optional cache-size trigger threshold (supports K/M/G/T).
- CACHE_TARGET_SIZE: optional cache-size target to stop cleanup (supports K/M/G/T).
- UPSTREAM_PROXY_URL: generic upstream proxy URL.
- UPSTREAM_HTTP_PROXY_URL: upstream proxy for HTTP.
- UPSTREAM_HTTPS_PROXY_URL: upstream proxy for HTTPS.
- UPSTREAM_NO_PROXY: domains that bypass upstream proxy (wildcards supported, `*` means bypass all).
- UPSTREAM_IGNORE_DOMAINS: ignored domains, wildcard supported.
- REPO_FALLBACK_REPOS: repository fallback list.
- NPM_REGISTRY_DOMAINS: npm domains for ecosystem routing (wildcards supported).
- MAVEN_REPO_DOMAINS: maven domains for ecosystem routing (wildcards supported).
- MAVEN_CACHE_USE_DOMAIN_DIR: whether Maven cache uses hostname as the first-level directory. Default false.
- MAVEN_CACHE_IGNORE_PATH_PREFIXES: Maven cache path-prefix ignore rules (comma-separated, supports host/path and host:port/path). Default: repo1.maven.org/maven2,repo.maven.apache.org/maven2,jitpack.io/,plugins.gradle.org/m2,dl.google.com/dl/android/maven2,dl.google.com/dl/google/maven.
- HTTPS_MITM_DOMAINS: MITM domain list (includes registry.npmjs.org by default, wildcards supported).
- DOWNLOAD_LOG_DIR: log directory.
- LOG_RETENTION: log retention duration (supports s/m/h/d), for example 7d.
- LOG_TO_STDOUT: whether to also print runtime logs to stdout/stderr; startup logs are always printed.
- LOG_CONNECT_EVENTS: whether to print verbose CONNECT/MITM handshake logs. Default false.
- OUTBOUND_KEEP_ALIVE: enable outbound keep-alive connection pooling.
- OUTBOUND_KEEP_ALIVE_INTERVAL: keep-alive interval (supports s/m/h/d), for example 1s.
- OUTBOUND_MAX_SOCKETS: max outbound sockets per origin.
- OUTBOUND_MAX_FREE_SOCKETS: max idle outbound sockets per origin.
 - MAVEN_NEGATIVE_ENABLED: enable Maven negative index. Default true.
 - MAVEN_NEGATIVE_INDEX_DIR: Maven negative index directory. Default data/index.
 - MAVEN_NEGATIVE_CACHE_TTL: negative cache TTL (supports s/m/h/d), for example 24h.
 - MAVEN_NEGATIVE_FLUSH_INTERVAL: flush interval for negative event log (supports s/m/h/d), for example 5s.
 - MAVEN_NEGATIVE_EVENT_MAX_MB: max size threshold for negative event log compaction in MB.
- MAVEN_PROXY_CONFIG_MODE: development or user.
- MAVEN_PROXY_CONFIG_FILE: explicit config file path.
- EXISTING_TRUST_STORE_PATH: optional existing truststore path. If present, truststore init prefers it as source.
- EXISTING_TRUST_STORE_PASSWORD: optional password for the existing truststore source.

Rules:
- UPSTREAM_NO_PROXY and UPSTREAM_IGNORE_DOMAINS are merged.
- In the current implementation, both lists share equivalent matching behavior. Prefer UPSTREAM_NO_PROXY for standard no-proxy settings and UPSTREAM_IGNORE_DOMAINS for project-specific exclusions.
- Exact and wildcard domains are supported.

Priority:
1. HTTP: UPSTREAM_HTTP_PROXY_URL, then UPSTREAM_PROXY_URL.
2. HTTPS: UPSTREAM_HTTPS_PROXY_URL, then UPSTREAM_PROXY_URL, then UPSTREAM_HTTP_PROXY_URL.

### 8.4.1 Full Environment Variable Reference

- `PROXY_PORT`: Proxy server port. Default `8080`.
- `REPO_PORT`: Local repository server port. Default `8081`.
- `CACHE_DIR`: Base cache directory. Default `data/cache`.
- `CACHE_CLEANUP_ENABLED`: Enable automatic cache cleanup. Default `true`.
- `CACHE_CLEANUP_DAILY_AT`: Daily cleanup check time in local timezone (`HH:mm`). Default `03:00`.
- `CACHE_CLEANUP_CHECK_MIN_INTERVAL`: Minimum interval between pressure checks (supports `s/m/h/d`). Default `10m`.
- `CACHE_TOUCH_ON_HIT`: Update file mtime when cache hit returns successfully. Default `true`.
- `CACHE_TOUCH_MIN_INTERVAL`: Minimum interval between two touches for the same file (supports `s/m/h/d`). Default `1d`.
- `CACHE_RETENTION_START`: Initial retention window for cleanup rounds (supports `s/m/h/d`). Default `10d`.
- `CACHE_RETENTION_MIN`: Minimum retention window for cleanup rounds (supports `s/m/h/d`). Default `1d`.
- `CACHE_DISK_FREE_TRIGGER`: Trigger cleanup when disk free bytes are below this value (supports `K/M/G/T`). Default `20G`.
- `CACHE_DISK_FREE_TARGET`: Stop cleanup when disk free bytes recover to this value (supports `K/M/G/T`). Default `25G`.
- `CACHE_MAX_SIZE`: Optional cache-size trigger threshold (supports `K/M/G/T`). Default empty (disabled).
- `CACHE_TARGET_SIZE`: Optional cache-size target to stop cleanup (supports `K/M/G/T`). Default empty (disabled).
- `REPO_FALLBACK_REPOS`: Comma-separated fallback repository URLs for cache misses.
- `ENABLE_HTTPS_PROXY`: Enable HTTPS proxy handling (`true/false`).
- `HTTPS_MITM_DOMAINS`: Comma-separated domains to apply MITM certificate issuance (wildcards supported).
- `HTTPS_PASSTHROUGH_FOR_UNMATCHED`: Whether unmatched HTTPS domains are tunneled directly. Default `false`.
- `NPM_REGISTRY_DOMAINS`: Domains treated as npm ecosystem for cache routing (wildcards supported).
- `MAVEN_REPO_DOMAINS`: Domains treated as Maven ecosystem for cache routing (wildcards supported).
- `MAVEN_CACHE_USE_DOMAIN_DIR`: Whether Maven cache uses hostname as the first-level directory. Default `false`.
- `MAVEN_CACHE_IGNORE_PATH_PREFIXES`: Maven cache path-prefix ignore rules (comma-separated, supports `host/path` and `host:port/path`). Default `repo1.maven.org/maven2,repo.maven.apache.org/maven2,jitpack.io/,plugins.gradle.org/m2,dl.google.com/dl/android/maven2,dl.google.com/dl/google/maven`.
- `MULTI_THREAD_DOMAINS`: Domains allowed to use multi-thread download (wildcards supported).
- `MULTI_THREAD_COUNT`: Number of download threads for ranged downloads.
- `MULTI_THREAD_MIN_SIZE_MB`: Minimum size threshold to trigger multi-thread download (supports `K/M/G/T`, e.g. `1M` or `512K`). Default `1M`.
- `DOWNLOAD_TIMEOUT`: Upstream request timeout (supports `s/m/h/d`). Default `60s`.
- `DOWNLOAD_LOG_DIR`: Directory for unified app/error logs.
- `LOG_RETENTION`: Log retention duration (supports `s/m/h/d`). Default `7d`.
- `LOG_TO_STDOUT`: Whether to also print runtime logs to stdout/stderr. Startup logs are always printed. Default `true`.
- `LOG_CONNECT_EVENTS`: Whether to print verbose CONNECT/MITM handshake logs. Default `false`.
- `OUTBOUND_KEEP_ALIVE`: Enable outbound keep-alive connection pooling. Default `true`.
- `OUTBOUND_KEEP_ALIVE_INTERVAL`: Keep-alive interval (supports `s/m/h/d`). Default `1s`.
- `OUTBOUND_MAX_SOCKETS`: Max outbound sockets per origin. Default `64`.
- `OUTBOUND_MAX_FREE_SOCKETS`: Max idle outbound sockets per origin. Default `16`.
 - `MAVEN_NEGATIVE_ENABLED`: Enable Maven negative cache index. Default `true`.
 - `MAVEN_NEGATIVE_INDEX_DIR`: Maven negative index directory. Default `data/index`.
 - `MAVEN_NEGATIVE_CACHE_TTL`: Negative cache TTL (supports `s/m/h/d`). Default `24h`.
 - `MAVEN_NEGATIVE_FLUSH_INTERVAL`: Flush interval for negative event log (supports `s/m/h/d`). Default `5s`.
 - `MAVEN_NEGATIVE_EVENT_MAX_MB`: Max size threshold for negative event log compaction (supports `K/M/G/T`, e.g. `8M` or `8192K`). Default `8M`.
- `UPSTREAM_PROXY_URL`: Generic upstream proxy URL (fallback for HTTP/HTTPS).
- `UPSTREAM_HTTP_PROXY_URL`: Upstream proxy URL for HTTP requests.
- `UPSTREAM_HTTPS_PROXY_URL`: Upstream proxy URL for HTTPS requests.
- `UPSTREAM_NO_PROXY`: Comma-separated domains that bypass upstream proxy (wildcards supported, `*` means bypass all).
- `UPSTREAM_IGNORE_DOMAINS`: Additional bypass domains (wildcards supported).
- `CERT_DIR`: Base directory for certificates.
- `ROOT_CERT_PATH`: Path to Root CA certificate.
- `ROOT_KEY_PATH`: Path to Root CA private key.
- `LEAF_CERT_DIR`: Directory for issued leaf certificates.
- `TRUST_STORE_PATH`: Path to Java trust store file.
- `TRUST_STORE_ALIAS`: Alias used when importing Root CA into trust store.
- `TRUST_STORE_PASSWORD`: Trust store password.
- `EXISTING_TRUST_STORE_PATH`: Optional existing truststore path. If present, init prefers it as source and writes output to `TRUST_STORE_PATH`.
- `EXISTING_TRUST_STORE_PASSWORD`: Optional password used to read `EXISTING_TRUST_STORE_PATH`.
- `JAVA_HOME`: Preferred Java home path. If empty or invalid, auto-detection is used.
- `MAVEN_PROXY_CONFIG_MODE`: Config load mode (`development` or `user`).
- `MAVEN_PROXY_CONFIG_FILE`: Explicit config file path override.

### 8.5 Trust Store Merge

Use merge command to combine trust stores.

`truststore init` behavior:

- If `EXISTING_TRUST_STORE_PATH` exists: it is used as source, copied to `TRUST_STORE_PATH`, then Root CA is imported.
- If it does not exist: fallback source is `${JAVA_HOME}/lib/security/cacerts`, then output is written to `TRUST_STORE_PATH` and Root CA is imported.
- If source truststore password differs from `TRUST_STORE_PASSWORD`, init rotates output store password to `TRUST_STORE_PASSWORD`.

Help:

```powershell
npm run truststore:merge -- --help
```

Basic merge:

```powershell
npm run truststore:merge -- \
  --source .\data\certs\source-truststore.jks \
  --target .\data\certs\proxy-truststore.jks \
  --source-pass changeit \
  --target-pass changeit
```

Overwrite on alias conflict:

```powershell
npm run truststore:merge -- \
  --source .\data\certs\source-truststore.jks \
  --target .\data\certs\proxy-truststore.jks \
  --source-pass changeit \
  --target-pass changeit \
  --on-conflict overwrite
```

Dry-run:

```powershell
npm run truststore:merge -- \
  --source .\data\certs\source-truststore.jks \
  --target .\data\certs\proxy-truststore.jks \
  --source-pass changeit \
  --target-pass changeit \
  --dry-run
```

Optional flags:
- --source-type: default JKS.
- --target-type: default JKS.
- --on-conflict: fail or overwrite.
- --dry-run: validation only.

### 8.6 Publish as CLI Tool (npx / global)

The project provides executable command maven-proxy.

Run with npx:

```bash
npx maven-proxy
```

Install globally:

```bash
npm install -g maven-proxy
maven-proxy
```

Default CLI config path:
- ~/maven-proxy/config.properties

Common commands:
- maven-proxy --config /path/to/config
- maven-proxy start --mode development
- maven-proxy start --mode user
- maven-proxy stop
- maven-proxy init-config --force
- maven-proxy truststore print
- maven-proxy truststore init
- maven-proxy truststore merge --source /path/source.jks --target /path/target.jks
- maven-proxy doctor

Start/stop behavior:
- `maven-proxy start` runs in background and returns immediately.
- `maven-proxy stop` stops the background process using PID file `~/maven-proxy/maven-proxy.pid`.

Doctor command:
- Checks config loading, port availability, keytool, JAVA_HOME, cert/truststore paths, and writable log/cache directories.
- Reports PASS/WARN/FAIL.
- Returns exit code 2 when FAIL exists.

## 9. Client Usage

Default proxy port in examples: 8080. Replace with your configured value if different.

### 9.1 Gradle: Proxy + trust store

1. Initialize trust store (if needed):

```bash
npm run truststore:init
```

2. Update ~/.gradle/gradle.properties:

```properties
systemProp.http.proxyHost=127.0.0.1
systemProp.http.proxyPort=8080
systemProp.https.proxyHost=127.0.0.1
systemProp.https.proxyPort=8080
org.gradle.jvmargs=-Djavax.net.ssl.trustStore=/Users/yize/projects/maven-proxy/data/certs/proxy-truststore.jks -Djavax.net.ssl.trustStorePassword=changeit
```

3. Validate:

```bash
./gradlew --refresh-dependencies dependencies
```

Note: always set `trustStorePassword` together with `trustStore`. If you use `systemProp.javax.net.ssl.trustStore`, also set `systemProp.javax.net.ssl.trustStorePassword`.

### 9.2 npm: Proxy + SSL behavior

For local troubleshooting only, you can disable strict SSL temporarily. Recommended long-term approach is to import Root CA and keep strict SSL enabled.

Set npm proxy:

```bash
npm config set proxy http://127.0.0.1:8080
npm config set https-proxy http://127.0.0.1:8080
```

Temporary disable strict SSL:

```bash
npm config set strict-ssl false
```

Validate:

```bash
npm ping
npm view lodash version
```

Restore safer defaults:

```bash
npm config set strict-ssl true
npm config delete proxy
npm config delete https-proxy
```
