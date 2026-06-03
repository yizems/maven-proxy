# Gradle 配置代理端口后的下载工作链路（HTTP/HTTPS）

本文说明：当 Gradle 在 `gradle.properties` 中配置 `http/https` 代理为本服务代理端口（默认 `127.0.0.1:8080`）后，请求在本项目中的关键执行链路。

## 1. 入口与启动阶段

### 1.1 进程启动
- 入口：`src/index.js` -> `main()`
- 关键动作：
  1. 创建缓存目录、证书目录、日志目录。
  2. 初始化证书管理器：`new CertManager(config)` + `certManager.init()`。
  3. 初始化上游代理管理器：`new UpstreamProxyManager(config, matchesDomain)`。
  4. 初始化 Maven 负向索引：`new MavenNegativeIndex(config)`。
  5. 初始化缓存清理管理器：`new CacheCleanupManager(config)`。
  6. 创建下载器：`new Downloader(config, matchesDomain, upstreamProxyManager)`。
  7. 启动代理服务：`startProxyServer(...)`。

### 1.2 代理服务挂载
- 文件：`src/proxy/proxy-server.js`
- 关键方法：`startProxyServer(...)`
- 行为：
  1. 生成 HTTP 请求处理器：`createHttpRequestHandler(...)`。
  2. 创建 MITM 内部 HTTP 服务器：`createMitmHttpServer(handleHttpRequestPath)`。
  3. 挂载 CONNECT 处理器：`attachConnectHandler(server, {...})`。

> 到这里，服务已同时具备：
> - 普通 HTTP 代理能力（客户端直接发送 HTTP 请求）
> - HTTPS CONNECT 处理能力（隧道透传或 MITM 解密后再走统一 HTTP 处理逻辑）

---

## 2. Gradle 下载 HTTP 库时的链路

Gradle 在使用 HTTP 仓库地址时，会通过代理发送普通 HTTP 请求。

### 2.1 请求进入统一 HTTP 处理器
- 文件：`src/proxy/proxy-http-handler.js`
- 关键方法：
  - `createHttpRequestHandler(...)`
  - 返回的处理函数 `handleHttpRequestPath(req, res, forcedProtocol)`

处理顺序：
1. `buildUrl(req, forcedProtocol)` 解析目标 URL。
2. 仅 `GET/HEAD` 进入缓存逻辑；其他方法调用 `forwardDirectRequest(...)` 直接转发。

### 2.2 路由到 Maven 缓存路径
- 文件：`src/common/ecosystem.js`
  - `detectPackageEcosystem(urlObj, config, matchesDomain)` 识别生态（maven/npm/generic）。
- 文件：`src/cache/cache-path.js`
  - `getCacheFilePath(cacheDir, urlObj, options)` 计算本地缓存文件路径。
  - Maven 场景会应用 `stripMavenIgnoredPathPrefix(...)` 等规则。

### 2.3 缓存命中
- 文件：`src/proxy/proxy-http-handler.js`
- 关键方法：
  - `statIfFile(cachePath)`
  - `serveFile(res, req, cachePath, cacheCleanupManager)`

命中时行为：
1. 记录 HIT 日志。
2. 返回文件内容（HEAD 只返回头）。
3. 设置 `x-cache: HIT`。
4. 可触发 `cacheCleanupManager.touchFileOnHit(...)` 更新访问时间。

### 2.4 缓存未命中 -> 回源下载
- 文件：`src/proxy/proxy-http-handler.js`
- 关键方法：
  - `downloader.streamMissToClient(downloadUrlObj, cachePath, downloadRequestHeaders, res)`（GET）
  - `downloader.ensureCached(downloadUrlObj, cachePath, downloadRequestHeaders)`（HEAD / 兼容路径）

下载前关键分支：
1. Maven 负向索引拦截：`mavenAffinityIndex.shouldSkipRequest(...)` 可直接返回 404。
2. 无扩展名路径：`hasFileExtension(urlObj)` 不满足则不缓存，直接 `forwardDirectRequest(...)`。
3. Maven `meta.json` 存在时，可优先使用历史 `originalUrl` 作为下载源（同目录同镜像策略）。
4. GET 的 MISS 请求会在下载过程中持续向客户端回写数据，避免客户端长时间收不到首包导致读超时。

---

## 3. Gradle 下载 HTTPS 库时的链路

Gradle 在使用 HTTPS 仓库地址时，会先向代理发送 CONNECT 请求。

### 3.1 CONNECT 入口
- 文件：`src/proxy/proxy-connect-handler.js`
- 关键方法：`attachConnectHandler(server, {...})`

CONNECT 处理顺序：
1. `parseConnectTarget(req.url)` 解析 `host:port`。
2. 计算是否启用 MITM：
   - `config.enableHttpsProxy`
   - `matchesDomain(host, config.httpsMitmDomains)`

### 3.2 HTTPS 两种模式

#### A. 未命中 MITM 域名：隧道透传
- 方法：`handlePassThroughConnect(...)`
- 行为：
  1. `openConnectUpstreamSocket(...)` 连接目标站点（或上游代理）。
  2. 返回 `HTTP/1.1 200 Connection Established` 给 Gradle。
  3. `clientSocket <-> upstreamSocket` 双向 pipe。
- 结果：代理不解密 HTTPS 内容，只做 TCP 隧道转发。

#### B. 命中 MITM 域名：解密后统一走 HTTP 处理器
- 方法：`handleMitmConnect(...)`
- 行为：
  1. `certManager.getOrCreateLeaf(targetHost)` 生成/复用目标域名叶子证书。
  2. 返回 `200 Connection Established`。
  3. 基于 `tls.TLSSocket` 与客户端完成 TLS 服务端握手。
  4. 将 TLS socket 注入 `mitmHttpServer.emit("connection", tlsSocket)`。
- 结果：后续 HTTPS 内部的 HTTP 请求，会进入 `createMitmHttpServer(...)`，并调用
  `handleHttpRequestPath(req, res, "https:")`，从而与 HTTP 请求复用同一套缓存/下载逻辑。

---

## 4. 回源下载与落盘（HTTP/HTTPS 共用）

核心在 `src/cache/downloader.js` 的 `Downloader`。

### 4.1 防并发重复下载
- 方法：`ensureCached(urlObj, finalPath, requestHeaders)`
- 方法：`streamMissToClient(urlObj, finalPath, requestHeaders, res)`
- 机制：`this.inflight` 映射同一路径下载 Promise，避免同一文件被重复下载。

### 4.2 GET MISS 流式回写 + 原子缓存
- 方法：`#downloadAtomicAndMirror(urlObj, finalPath, requestHeaders, res)`

顺序：
1. 以 GET 向上游发起请求，解析重定向后的最终 URL。
2. 立即把上游响应头回写给客户端（附加 `x-cache: MISS`）。
3. 上游响应体同时 pipe 到：
  - 客户端响应流（尽快产生首包）；
  - 本地 `.temp` 文件（用于缓存落盘）。
4. 上游完成后校验文件大小。
5. `fs.promises.rename(temp, final)` 原子替换。
6. 写入 `meta.json`，记录 `originalUrl`。

### 4.3 原子下载流程（非流式路径）
- 私有方法：`#downloadAtomic(urlObj, finalPath, requestHeaders)`

顺序：
1. 目标目录确保存在。
2. 使用临时文件：`tempPath = finalPath + ".temp"`。
3. `probe(...)` 先做 HEAD 预探测（长度、是否支持 range、重定向后最终 URL）。
4. 依据条件选择下载模式：
   - 多线程：`downloadMultiThread(...)`（域名匹配 + 大文件 + 支持 range）
   - 单线程：`downloadSingle(...)`
5. `verifyFileSize(tempPath, expectedSize)` 做完整性校验。
6. `fs.promises.rename(tempPath, finalPath)` 原子替换。
7. 写入同目录 `meta.json`（记录 originalUrl）。
8. 失败时 `removeIfExists(tempPath)` 清理临时文件。

### 4.4 上游代理生效点
- 文件：`src/proxy/upstream-proxy.js`
- 关键方法：
  - `getAgentForUrl(urlObj)`：为 HTTP/HTTPS 请求选择直连或上游代理 Agent。
  - `createConnectTunnel(targetHost, targetPort, timeoutMs)`：CONNECT 场景通过上游代理再打洞。
- 在下载器中通过 `getAgent` 注入请求。

---

## 5. 与 Gradle 代理配置的关系

当 Gradle 配置：

```properties
systemProp.http.proxyHost=127.0.0.1
systemProp.http.proxyPort=8080
systemProp.https.proxyHost=127.0.0.1
systemProp.https.proxyPort=8080
```

可以映射到本项目的两条主路径：

1. HTTP 仓库下载：
   - 直接走 `proxy-server` 的普通 HTTP 请求处理器。
   - 进入缓存命中/回源下载/原子落盘链路。

2. HTTPS 仓库下载：
   - 先走 CONNECT。
   - 命中 MITM 域名则进入证书签发 + TLS 解密，再复用同一缓存链路。
   - 不命中 MITM 域名则走隧道透传。

---

## 6. 关键方法速查（按调用阶段）

### 启动与组件装配
- `src/index.js` -> `main()`
- `src/proxy/proxy-server.js` -> `startProxyServer(...)`

### HTTP/HTTPS 入口
- `src/proxy/proxy-http-handler.js` -> `createHttpRequestHandler(...)`
- `src/proxy/proxy-http-handler.js` -> `createMitmHttpServer(...)`
- `src/proxy/proxy-connect-handler.js` -> `attachConnectHandler(...)`

### HTTPS MITM
- `src/proxy/proxy-connect-handler.js` -> `handleMitmConnect(...)`
- `src/cert/cert-manager.js` -> `CertManager.init()`
- `src/cert/cert-manager.js` -> `CertManager.getOrCreateLeaf(hostname)`

### 缓存与下载
- `src/common/ecosystem.js` -> `detectPackageEcosystem(...)`
- `src/cache/cache-path.js` -> `getCacheFilePath(...)`
- `src/proxy/proxy-http-handler.js` -> `serveFile(...)`
- `src/cache/downloader.js` -> `Downloader.ensureCached(...)`
- `src/cache/downloader.js` -> `Downloader.streamMissToClient(...)`
- `src/cache/downloader.js` -> `Downloader.#downloadAtomicAndMirror(...)`
- `src/cache/downloader.js` -> `Downloader.#downloadAtomic(...)`
- `src/cache/downloader.js` -> `downloadSingle(...)`
- `src/cache/downloader.js` -> `downloadMultiThread(...)`

### 上游代理
- `src/proxy/upstream-proxy.js` -> `UpstreamProxyManager.getAgentForUrl(...)`
- `src/proxy/upstream-proxy.js` -> `UpstreamProxyManager.createConnectTunnel(...)`

---

## 7. 一句话总结

Gradle 无论走 HTTP 还是 HTTPS 下载库，最终都会汇聚到本项目统一的「缓存路径计算 -> 缓存命中判断 -> 回源下载（GET MISS 为流式回写）-> `.temp` 原子落盘」主链路；HTTPS 仅多了 CONNECT 与可选 MITM 解密这层入口处理。