# Maven Proxy 

[English](README.md) | [中文](README-zh.md)

[English ChangeLog](ChangeLog.md) | [中文更新日志](ChangeLog-zh.md)

[![npm version](https://img.shields.io/npm/v/maven-proxy.svg)](https://www.npmjs.com/package/maven-proxy)

## 1. 项目定位
本项目是一个 Maven 代理服务（Maven Proxy），用于在团队或本机环境中加速与稳定 Maven/Gradle 依赖下载。

核心目标：
- 对外提供一个代理端口，供 Maven/Gradle 客户端作为仓库代理访问。
- 对依赖文件进行本地缓存：命中缓存时直接返回，未命中时回源下载并落盘缓存后再返回。
- 支持 HTTPS 连接代理能力，可基于本地 Root CA 为特定域名动态签发证书。
- 对指定域名的回源下载支持“多线程下载器”策略，以提升下载效率与稳定性。
- 额外提供一个本地 Maven 仓库发布端口，将已缓存成功的文件作为 Maven 仓库对外提供，Gradle 也可直接配置该仓库使用。

## 2. 功能需求

### 2.1 代理服务端口
- 系统需启动一个可配置端口，作为 Maven/Gradle 的代理入口。
- 客户端请求依赖时通过该端口转发处理。

### 2.2 HTTPS 代理与证书签发
- 代理需支持 HTTPS 连接场景（用于 Maven/Gradle 访问 HTTPS 仓库）。
- 系统需支持生成一套本地 Root CA 证书（可使用自签名方式，作为开发/内网用途）。
- 对命中的特定域名规则，代理可基于 Root CA 动态签发站点证书用于连接代理。
- 对未命中特定域名规则的 HTTPS 目标，可按配置选择：
  - 直接隧道转发（CONNECT passthrough）。
  - 或不进行证书签发拦截。
- Root CA 证书与私钥文件需落盘保存并可复用，避免每次重启重新生成。

### 2.3 缓存命中与回源逻辑
- 当客户端请求某个依赖文件时：
  1. 先按请求路径检查本地缓存目录是否已有对应文件。
  2. 若已存在且可用，直接返回本地缓存文件。
  3. 若不存在，则从原始地址下载该文件。
  4. 下载过程先写入临时文件（正式文件名 + `.temp` 后缀），不得直接覆盖正式文件。
  5. 仅在下载完成且通过完整性确认后，将 `.temp` 文件原子改名为正式文件名。
  6. 改名成功后再作为可命中的缓存返回给客户端。

- 下载失败、中断或校验失败时：
  - 不得生成或保留不完整的正式缓存文件。
  - 应清理残留的 `.temp` 文件（或将其标记为可回收状态，避免被误命中）。

- 缓存目录结构需可持续复用，满足 Maven/Gradle 仓库路径约定。

### 2.4 指定域名多线程下载
- 对回源下载场景，支持“按域名匹配策略”。
- 当请求目标域名命中配置列表时，使用多线程下载器进行下载。
- 未命中配置列表时，使用常规下载方式。
- 多线程下载器行为可配置（如线程数、分片策略、重试次数等，具体字段见配置需求）。

### 2.5 本地仓库发布端口
- 系统需额外启动一个可配置端口，用于将本地已缓存成功的目录作为 Maven 仓库对外提供。
- 该仓库地址可被：
  - Maven 的 `repositories` 配置直接引用。
  - Gradle 的 `repositories` 配置直接引用。
- 当请求文件本地不存在时，仓库服务需按配置仓库列表回源下载，下载成功后缓存到本地并返回。

### 2.6 Java Trust Store 支持
- 需提供面向 Java 环境的 trust store 使用说明与命令模板，用于信任本项目生成的 Root CA。
- 需至少覆盖以下能力：
  - 生成（或复制）一个可供 Java 使用的 trust store 文件。
  - 将 Root CA 导入指定 trust store。
  - 验证导入结果（列出证书条目）。
- 文档需给出 Windows和mac 场景可直接执行的 `keytool` 示例命令。

### 2.7 配置化要求
以下参数必须可配置：
- 代理服务端口。
- HTTPS 代理开关。
- HTTPS 证书签发域名匹配配置。
- Root CA 证书与私钥存储路径。
- 本地仓库发布端口。
- 缓存目录路径。
- 多线程下载相关配置。
- 需要启用多线程下载的域名匹配配置。
- Java trust store 相关配置（如 trust store 路径、别名、默认口令是否允许覆盖）。

## 3. 关键流程（逻辑描述）
1. 客户端通过代理端口请求某依赖资源。
2. 若为 HTTPS 且域名命中证书签发规则，代理基于 Root CA 处理 TLS 连接。
3. 服务根据请求路径检查本地缓存目录。
4. 若缓存命中，直接返回缓存文件。
5. 若缓存未命中，执行回源下载：
   - 若域名命中“多线程下载域名规则”，走多线程下载器。
   - 否则走常规下载。
6. 下载时先写入目标路径对应的 `.temp` 临时文件。
7. 下载完成并通过完整性确认后，将 `.temp` 原子改名为正式文件。
8. 将正式文件响应给客户端。
9. 同时，缓存目录可通过“本地仓库发布端口”作为 Maven 仓库被 Maven/Gradle 消费。

## 4. Java Trust Store 命令示例（Windows）

说明：以下为需求阶段约定的命令模板，具体路径与口令按实际配置替换。

1. 从 JDK 默认 `cacerts` 复制一份项目专用 trust store（推荐）

```powershell
Copy-Item "$env:JAVA_HOME\\lib\\security\\cacerts" ".\\data\\certs\\proxy-truststore.jks"
```

2. 将项目 Root CA 导入 trust store

```powershell
keytool -importcert -noprompt -trustcacerts `
  -alias maven-proxy-root-ca `
  -file .\\data\\certs\\root-ca.crt `
  -keystore .\\data\\certs\\proxy-truststore.jks `
  -storepass changeit
```

3. 验证导入结果

```powershell
keytool -list -v `
  -keystore .\\data\\certs\\proxy-truststore.jks `
  -storepass changeit `
  -alias maven-proxy-root-ca
```

4. Maven/Gradle 运行时使用该 trust store（示例 JVM 参数）

```powershell
-Djavax.net.ssl.trustStore=.\\data\\certs\\proxy-truststore.jks
-Djavax.net.ssl.trustStorePassword=changeit
```

## 5. 非目标（当前阶段不要求）
- 暂不要求实现权限认证与鉴权。
- 暂不要求实现复杂的管理后台界面。
- 暂不要求支持缓存淘汰策略（如 LRU、TTL）与容量治理（后续可扩展）。

## 6. 验收标准
- 能正常启动两个端口：代理端口、仓库发布端口。
- Maven/Gradle 客户端指向代理端口后可拉取依赖。
- HTTPS 仓库访问可通过代理完成；命中特定域名时可完成基于 Root CA 的证书签发流程。
- 同一依赖第二次请求可命中本地缓存并直接返回。
- 未缓存依赖可成功回源下载、落盘并返回。
- 下载阶段使用 `.temp` 临时文件，未完成前不得出现可命中的正式文件。
- 下载完成后需通过原子改名生成正式文件，避免半文件/损坏文件被缓存命中。
- 指定域名回源时可按配置启用多线程下载。
- Maven/Gradle 可将仓库发布端口作为仓库地址并成功解析已缓存依赖。
- 可通过命令生成/维护 Java trust store，并成功导入 Root CA。
- 端口、缓存目录、多线程下载、HTTPS 证书与 trust store 配置均可通过配置项调整。
- 仓库服务在缓存缺失时可回源 Maven Central、JitPack、Gradle Plugin Portal、Google Maven（默认列表，可配置）。

## 7. 建议的后续扩展（可选）
- 缓存校验与损坏文件自动修复。
- 下载失败重试与熔断机制增强。
- 访问日志、命中率统计、健康检查接口。
- 缓存清理策略与磁盘配额管理。

## 8. 当前实现与运行说明

当前仓库已提供可运行实现，主工程源码位于 `src/`，采用 Node.js ESM（`import`）格式；辅助脚本位于 `scripts/`。

当前源码目录建议按职责组织：

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

### 8.1 启动
1. 安装依赖：

```powershell
npm install
```

2. 按需创建并修改配置文件（项目根目录 `config.properties`）。

说明：

- 开发模式（默认）：当你在本项目目录运行 `npm start` 时，读取项目根目录 `config.properties`。
- 用户模式（CLI 默认）：通过 `npx maven-proxy` 或全局命令运行时，默认读取 `~/maven-proxy/config.properties`。
- 可通过 `MAVEN_PROXY_CONFIG_MODE` 强制模式（`development` 或 `user`）。
- 可通过 `MAVEN_PROXY_CONFIG_FILE` 指定配置文件路径。
- `JAVA_HOME` 支持自动识别：
  - macOS：优先使用 `/usr/libexec/java_home` 自动探测。
  - Windows：优先使用 `where java`，其次扫描常见 JDK 安装目录。
  - Linux：优先使用 `which java`，其次扫描常见 JDK 目录（如 `/usr/lib/jvm`、`/usr/java`）。
  - 若配置文件中的 `JAVA_HOME` 无效，系统会回退到自动探测结果（doctor 会提示）。

查看当前 Java 路径可用命令：

- macOS/Linux：`echo $JAVA_HOME`、`which java`、`/usr/libexec/java_home`（仅 macOS）。
- Windows cmd：`echo %JAVA_HOME%`、`where java`。
- Windows PowerShell：`$env:JAVA_HOME`、`Get-Command java`。

3. 启动服务：

```powershell
npm start
```

默认情况下会启动两个端口：
- 代理端口：`8080`（可由 `PROXY_PORT` 覆盖）。
- 仓库发布端口：`8081`（可由 `REPO_PORT` 覆盖）。

### 8.2 已实现能力
- HTTP/HTTPS 代理入口。
- 指定域名 HTTPS MITM（Root CA 动态签发证书）。
- `.temp` 临时文件下载 + 完整性校验 + 原子改名。
- GET 请求缓存未命中时，若目标域名未开启多线程下载，则支持“边回源下载边向客户端回写”，并行写入 `.temp` 缓存文件。
- 指定域名多线程下载（支持阈值、线程数配置）。
- 支持上级代理（出站请求与 CONNECT 透传可经上级代理转发）。
- 支持 npm 代理请求（registry 元数据与 tarball）。
- 缓存按生态分目录：`cache/maven`、`cache/npm`、`cache/generic`。
- 日志单独落盘：
  - 统一主日志：`app-YYYY-MM-DD.log`（包含 `INFO/WARN/ERROR`）。
  - 错误专用日志：`error-YYYY-MM-DD.log`（仅 `ERROR`）。
  - 记录全局异常：未捕获异常（uncaught exception）与未处理 Promise 拒绝（unhandled rejection）。
  - 日志文件按天切分，默认仅保留最近 7 天。
- 本地缓存目录作为 Maven 仓库发布。
- Java trust store 命令与脚本支持：
  - `npm run truststore:print`
  - `npm run truststore:init`
  - `npm run truststore:merge -- --source <src.jks> --target <dest.jks>`

### 8.4 上级代理配置

可通过以下环境变量启用上级代理：

- `CACHE_CLEANUP_ENABLED`: 是否启用自动缓存清理。
- `CACHE_CLEANUP_DAILY_AT`: 每日固定检查时间（本地时区，格式 `HH:mm`），例如 `03:00`。
- `CACHE_CLEANUP_CHECK_MIN_INTERVAL`: 压力检测最小间隔（支持 `s/m/h/d`），例如 `10m`。
- `CACHE_TOUCH_ON_HIT`: 缓存命中成功返回时是否更新文件 mtime。
- `CACHE_TOUCH_MIN_INTERVAL`: 同一文件两次 touch 的最小间隔（支持 `s/m/h/d`），默认 `1d`。
- `CACHE_RETENTION_START`: 清理轮次初始保留窗口（支持 `s/m/h/d`），默认 `10d`。
- `CACHE_RETENTION_MIN`: 清理轮次最小保留窗口（支持 `s/m/h/d`），默认 `1d`。
- `CACHE_DISK_FREE_TRIGGER`: 磁盘剩余空间低于该值时触发清理（支持 `K/M/G/T`），例如 `20G`。
- `CACHE_DISK_FREE_TARGET`: 磁盘剩余空间恢复到该值时可停止清理（支持 `K/M/G/T`），例如 `25G`。
- `CACHE_MAX_SIZE`: 可选，缓存总大小触发阈值（支持 `K/M/G/T`）。
- `CACHE_TARGET_SIZE`: 可选，缓存总大小回落目标（支持 `K/M/G/T`）。
- `UPSTREAM_PROXY_URL`: 通用上级代理地址（如 `http://127.0.0.1:8888`）。
- `UPSTREAM_HTTP_PROXY_URL`: 仅 HTTP 出站使用的上级代理。
- `UPSTREAM_HTTPS_PROXY_URL`: 仅 HTTPS 出站使用的上级代理。
- `UPSTREAM_NO_PROXY`: 不走上级代理的域名列表（逗号分隔，支持通配符，如 `*.internal.local`，`*` 表示全部直连）。
- `UPSTREAM_IGNORE_DOMAINS`: 上级代理忽略域名列表（逗号分隔，支持通配符，如 `*.acb.com`）。
- `REPO_FALLBACK_REPOS`: 仓库端口回源地址列表（逗号分隔），默认：Maven Central、JitPack、Gradle Plugin Portal、Google Maven。
- `NPM_REGISTRY_DOMAINS`: npm 域名识别列表（用于缓存分流，支持通配符），默认：`registry.npmjs.org,registry.npmmirror.com,npm.pkg.github.com`。
- `MAVEN_REPO_DOMAINS`: Maven 域名识别列表（用于缓存分流，支持通配符），默认包含 Maven Central、JitPack、Gradle Plugin、Google Maven。
- `MAVEN_CACHE_USE_DOMAIN_DIR`: Maven 缓存是否按域名作为一级目录，默认 `false`。
- `MAVEN_CACHE_IGNORE_PATH_PREFIXES`: Maven 缓存应忽略的路径前缀规则（逗号分隔，支持 `host/path` 与 `host:port/path`）。默认：`repo1.maven.org/maven2,repo.maven.apache.org/maven2,jitpack.io/,plugins.gradle.org/m2,dl.google.com/dl/android/maven2,dl.google.com/dl/google/maven`。
- `HTTPS_MITM_DOMAINS`: 默认已包含 `registry.npmjs.org`，可按需追加 npm 私有域名（支持通配符）。
- `DOWNLOAD_LOG_DIR`: 日志目录，默认 `data/logs/downloads`；统一主日志与错误日志都在该目录。
- `LOG_RETENTION`: 日志保留时长（支持 `s/m/h/d`），默认 `7d`，超过该时长的历史日志会自动清理。
- `LOG_TO_STDOUT`: 是否同时输出运行期日志到命令行；启动日志始终输出，默认 `true`。
- `LOG_CONNECT_EVENTS`: 是否输出详细 CONNECT/MITM 握手日志，默认 `false`。
- `OUTBOUND_KEEP_ALIVE`: 是否启用出站 keep-alive 连接复用池，默认 `true`。
- `OUTBOUND_KEEP_ALIVE_INTERVAL`: keep-alive 间隔（支持 `s/m/h/d`），默认 `1s`。
- `OUTBOUND_MAX_SOCKETS`: 每个源站允许的最大出站连接数，默认 `64`。
- `OUTBOUND_MAX_FREE_SOCKETS`: 每个源站保留的空闲连接上限，默认 `16`。
 - `MAVEN_NEGATIVE_ENABLED`: 是否启用 Maven negative 索引。默认 `true`。
 - `MAVEN_NEGATIVE_INDEX_DIR`: Maven negative 索引目录，默认 `data/index`。
 - `MAVEN_NEGATIVE_CACHE_TTL`: 负缓存 TTL（支持 `s/m/h/d`），例如 `24h`。
 - `MAVEN_NEGATIVE_FLUSH_INTERVAL`: negative 事件日志 flush 周期（支持 `s/m/h/d`），例如 `5s`。
 - `MAVEN_NEGATIVE_EVENT_MAX_MB`: negative 事件日志压缩阈值（MB）。
- `MAVEN_PROXY_CONFIG_MODE`: 配置模式，`development` 或 `user`。
- `MAVEN_PROXY_CONFIG_FILE`: 指定配置文件路径（优先级高于默认路径）。
- `EXISTING_TRUST_STORE_PATH`: 已有 truststore 路径（可选）。若文件存在，`truststore init` 会优先以它作为源。
- `EXISTING_TRUST_STORE_PASSWORD`: 已有 truststore 密码（可选）。当使用已有 truststore 作为源时生效。

说明：

- `UPSTREAM_NO_PROXY` 与 `UPSTREAM_IGNORE_DOMAINS` 会合并生效。
- 当前实现中，这两个列表的匹配行为等价；建议将 `UPSTREAM_NO_PROXY` 用于标准 no-proxy 配置，将 `UPSTREAM_IGNORE_DOMAINS` 用于项目自定义排除项。
- 支持精确域名与通配符域名（例如 `repo.maven.apache.org`、`*.acb.com`）。

优先级：

1. HTTP 请求优先使用 `UPSTREAM_HTTP_PROXY_URL`，其次 `UPSTREAM_PROXY_URL`。
2. HTTPS 请求优先使用 `UPSTREAM_HTTPS_PROXY_URL`，其次 `UPSTREAM_PROXY_URL`，再其次 `UPSTREAM_HTTP_PROXY_URL`。

### 8.4.1 完整环境变量说明

- `PROXY_PORT`: 代理服务端口，默认 `8080`。
- `REPO_PORT`: 本地仓库服务端口，默认 `8081`。
- `CACHE_DIR`: 缓存根目录，默认 `data/cache`。
- `CACHE_CLEANUP_ENABLED`: 是否启用自动缓存清理。默认 `true`。
- `CACHE_CLEANUP_DAILY_AT`: 每日固定检查时间（本地时区，格式 `HH:mm`）。默认 `03:00`。
- `CACHE_CLEANUP_CHECK_MIN_INTERVAL`: 压力检测最小间隔（支持 `s/m/h/d`）。默认 `10m`。
- `CACHE_TOUCH_ON_HIT`: 缓存命中成功返回时是否更新文件 mtime。默认 `true`。
- `CACHE_TOUCH_MIN_INTERVAL`: 同一文件两次 touch 的最小间隔（支持 `s/m/h/d`）。默认 `1d`。
- `CACHE_RETENTION_START`: 清理轮次初始保留窗口（支持 `s/m/h/d`）。默认 `10d`。
- `CACHE_RETENTION_MIN`: 清理轮次最小保留窗口（支持 `s/m/h/d`）。默认 `1d`。
- `CACHE_DISK_FREE_TRIGGER`: 磁盘剩余空间低于该值时触发清理（支持 `K/M/G/T`）。默认 `20G`。
- `CACHE_DISK_FREE_TARGET`: 磁盘剩余空间恢复到该值时可停止清理（支持 `K/M/G/T`）。默认 `25G`。
- `CACHE_MAX_SIZE`: 可选，缓存总大小触发阈值（支持 `K/M/G/T`）。默认空（禁用）。
- `CACHE_TARGET_SIZE`: 可选，缓存总大小回落目标（支持 `K/M/G/T`）。默认空（禁用）。
- `REPO_FALLBACK_REPOS`: 缓存未命中时的回源仓库地址列表（逗号分隔）。
- `ENABLE_HTTPS_PROXY`: 是否启用 HTTPS 代理处理（`true/false`）。
- `HTTPS_MITM_DOMAINS`: 需要执行 MITM 证书签发的域名列表（逗号分隔，支持通配符）。
- `HTTPS_PASSTHROUGH_FOR_UNMATCHED`: 未命中 MITM 域名时是否允许直连隧道透传。默认 `false`。
- `NPM_REGISTRY_DOMAINS`: 识别为 npm 生态并分流缓存的域名列表（支持通配符）。
- `MAVEN_REPO_DOMAINS`: 识别为 Maven 生态并分流缓存的域名列表（支持通配符）。
- `MAVEN_CACHE_USE_DOMAIN_DIR`: Maven 缓存是否按域名作为一级目录。默认 `false`。
- `MAVEN_CACHE_IGNORE_PATH_PREFIXES`: Maven 缓存应忽略的路径前缀规则（逗号分隔，支持 `host/path` 与 `host:port/path`）。默认 `repo1.maven.org/maven2,repo.maven.apache.org/maven2,jitpack.io/,plugins.gradle.org/m2,dl.google.com/dl/android/maven2,dl.google.com/dl/google/maven`。
- `MULTI_THREAD_DOMAINS`: 启用多线程下载的域名列表（支持通配符）。
- `MULTI_THREAD_COUNT`: 多线程下载线程数。
- `MULTI_THREAD_MIN_SIZE_MB`: 触发多线程下载的最小文件大小阈值（支持 `K/M/G/T`，例如 `1M` 或 `512K`）。默认 `1M`。
- `DOWNLOAD_TIMEOUT`: 上游请求超时时间（支持 `s/m/h/d`）。默认 `60s`。
- `DOWNLOAD_LOG_DIR`: 统一主日志与错误日志目录。
- `LOG_RETENTION`: 日志保留时长（支持 `s/m/h/d`）。默认 `7d`。
- `LOG_TO_STDOUT`: 是否输出运行期日志到命令行。启动日志始终输出。默认 `true`。
- `LOG_CONNECT_EVENTS`: 是否输出详细 CONNECT/MITM 握手日志。默认 `false`。
- `OUTBOUND_KEEP_ALIVE`: 是否启用出站 keep-alive 连接复用池。默认 `true`。
- `OUTBOUND_KEEP_ALIVE_INTERVAL`: keep-alive 间隔（支持 `s/m/h/d`）。默认 `1s`。
- `OUTBOUND_MAX_SOCKETS`: 每个源站的最大出站连接数。默认 `64`。
- `OUTBOUND_MAX_FREE_SOCKETS`: 每个源站可保留的空闲连接上限。默认 `16`。
 - `MAVEN_NEGATIVE_ENABLED`: 是否启用 Maven negative 缓存索引。默认 `true`。
 - `MAVEN_NEGATIVE_INDEX_DIR`: Maven negative 索引目录。默认 `data/index`。
 - `MAVEN_NEGATIVE_CACHE_TTL`: 负缓存 TTL（支持 `s/m/h/d`）。默认 `24h`。
 - `MAVEN_NEGATIVE_FLUSH_INTERVAL`: negative 事件日志 flush 周期（支持 `s/m/h/d`）。默认 `5s`。
 - `MAVEN_NEGATIVE_EVENT_MAX_MB`: negative 事件日志压缩阈值（支持 `K/M/G/T`，例如 `8M` 或 `8192K`）。默认 `8M`。
- `UPSTREAM_PROXY_URL`: 通用上级代理地址（HTTP/HTTPS 的兜底）。
- `UPSTREAM_HTTP_PROXY_URL`: HTTP 请求使用的上级代理地址。
- `UPSTREAM_HTTPS_PROXY_URL`: HTTPS 请求使用的上级代理地址。
- `UPSTREAM_NO_PROXY`: 不走上级代理的域名列表（逗号分隔，支持通配符，`*` 表示全部直连）。
- `UPSTREAM_IGNORE_DOMAINS`: 额外忽略上级代理的域名列表（支持通配符）。
- `CERT_DIR`: 证书根目录。
- `ROOT_CERT_PATH`: Root CA 证书路径。
- `ROOT_KEY_PATH`: Root CA 私钥路径。
- `LEAF_CERT_DIR`: 站点叶子证书目录。
- `TRUST_STORE_PATH`: Java trust store 文件路径。
- `TRUST_STORE_ALIAS`: 导入 Root CA 到 trust store 时使用的别名。
- `TRUST_STORE_PASSWORD`: trust store 密码。
- `EXISTING_TRUST_STORE_PATH`: 现有 truststore 路径（可选）。若存在，初始化时优先使用该文件作为源，并输出到 `TRUST_STORE_PATH`。
- `EXISTING_TRUST_STORE_PASSWORD`: 现有 truststore 密码（可选）。用于读取 `EXISTING_TRUST_STORE_PATH`。
- `JAVA_HOME`: Java 安装路径。为空或无效时会自动探测。
- `MAVEN_PROXY_CONFIG_MODE`: 配置加载模式（`development` 或 `user`）。
- `MAVEN_PROXY_CONFIG_FILE`: 显式指定配置文件路径（优先级最高）。

### 8.3 最小验证命令（Windows）

1. 通过代理下载依赖（首次 MISS，第二次 HIT）：

```powershell
curl.exe -k -sS -D - -o NUL -x http://127.0.0.1:8080 https://repo1.maven.org/maven2/junit/junit/4.13.2/junit-4.13.2.pom
curl.exe -k -sS -D - -o NUL -x http://127.0.0.1:8080 https://repo1.maven.org/maven2/junit/junit/4.13.2/junit-4.13.2.pom
```

2. 通过本地仓库发布端口访问缓存：

```powershell
curl.exe -sS -D - -o NUL http://127.0.0.1:8081/maven2/junit/junit/4.13.2/junit-4.13.2.pom
```

3. 验证无残留 `.temp` 文件：

```powershell
Get-ChildItem -Recurse -File .\data\cache -Filter '*.temp'
```

4. 通过代理访问 npm registry（验证 npm 支持）：

```powershell
curl.exe -k -sS -D - -o NUL -x http://127.0.0.1:8080 https://registry.npmjs.org/lodash
curl.exe -k -sS -D - -o NUL -x http://127.0.0.1:8080 https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz
```

### 8.5 Trust Store 合并（merge）

当你已经有两个 trust store（例如一个团队公共 trust store + 一个项目专用 trust store）时，可使用 `merge` 子命令合并。

`truststore init` 初始化逻辑：

- 若 `EXISTING_TRUST_STORE_PATH` 指向的文件存在：先以该文件作为源，输出到 `TRUST_STORE_PATH`，再导入 Root CA。
- 若上述文件不存在：回退到 `${JAVA_HOME}/lib/security/cacerts` 作为源，再输出到 `TRUST_STORE_PATH` 并导入 Root CA。
- 若源 truststore 密码与 `TRUST_STORE_PASSWORD` 不一致，初始化过程中会将输出文件密码转换为 `TRUST_STORE_PASSWORD`。

1. 查看帮助（脚本会输出参数错误）：

```powershell
npm run truststore:merge -- --help
```

2. 合并源 trust store 到目标 trust store（默认类型 `JKS`，默认冲突策略 `fail`）：

```powershell
npm run truststore:merge -- \
  --source .\data\certs\source-truststore.jks \
  --target .\data\certs\proxy-truststore.jks \
  --source-pass changeit \
  --target-pass changeit
```

3. 若允许同名 alias 覆盖，增加 `--on-conflict overwrite`：

```powershell
npm run truststore:merge -- \
  --source .\data\certs\source-truststore.jks \
  --target .\data\certs\proxy-truststore.jks \
  --source-pass changeit \
  --target-pass changeit \
  --on-conflict overwrite
```

4. 仅做预检（不导入、不改文件），增加 `--dry-run`：

```powershell
npm run truststore:merge -- \
  --source .\data\certs\source-truststore.jks \
  --target .\data\certs\proxy-truststore.jks \
  --source-pass changeit \
  --target-pass changeit \
  --dry-run
```

5. 可选参数：

- `--source-type`：源 trust store 类型，默认 `JKS`。
- `--target-type`：目标 trust store 类型，默认 `JKS`。
- `--on-conflict`：`fail` 或 `overwrite`，默认 `fail`。
- `--dry-run`：只做参数与冲突校验，不执行导入。

6. macOS/Linux 示例：

```bash
npm run truststore:merge -- \
  --source ./data/certs/source-truststore.jks \
  --target ./data/certs/proxy-truststore.jks \
  --source-pass changeit \
  --target-pass changeit
```

### 8.6 发布为命令行工具（npx / 全局安装）

本项目已提供可执行命令 `maven-proxy`。

1. 使用 npx 直接运行：

```bash
npx maven-proxy
```

说明：首次运行时如果未传 `--config` 且 `~/maven-proxy/config.properties` 不存在，CLI 会自动创建默认配置文件。

2. 全局安装后运行：

```bash
npm install -g maven-proxy
maven-proxy
```

3. CLI 默认配置路径：

- `~/maven-proxy/config.properties`

4. 常用 CLI 参数：

- `maven-proxy --config /path/to/config`
- `maven-proxy`
- `maven-proxy start --mode development`
- `maven-proxy start --mode user`
- `maven-proxy stop`
- `maven-proxy init-config --force`
- `maven-proxy truststore print`
- `maven-proxy truststore init`
- `maven-proxy truststore merge --source /path/source.jks --target /path/target.jks`
- `maven-proxy doctor`

启动/停止行为：

- `maven-proxy` 默认以前台同步方式启动；如果检测到之前已有后台实例在运行，会先停止旧实例，再启动新的当前进程。
- `maven-proxy start` 以后台方式启动并立即返回，不阻塞当前终端。
- `maven-proxy stop` 通过 PID 文件 `~/maven-proxy/maven-proxy.pid` 停止后台进程。

PM2 启动示例：

```bash
pm2 start maven-proxy --name maven-proxy --time -- --mode user
```

5. 规则说明：

- 开发阶段（在项目目录执行 `npm start`）默认使用项目 `config.properties`。
- CLI 阶段默认使用用户目录配置文件。
- 当配置项为相对路径时，会基于当前配置文件所在目录解析。

6. Trust Store CLI 说明：

- `maven-proxy truststore print`: 输出 trust store 相关命令模板。
- `maven-proxy truststore init`: 初始化项目 trust store（行为同 `npm run truststore:init`）。
- `maven-proxy truststore merge ...`: 合并 trust store（行为同 `npm run truststore:merge -- ...`）。

7. Doctor 诊断命令：

- `maven-proxy doctor`: 一次性检查配置加载、端口可用性、`keytool` 可用性、`JAVA_HOME`、证书与 trust store 路径、日志/缓存目录可写性。
- 检查结果包含 `PASS/WARN/FAIL`。
- 若存在 `FAIL`，命令将返回非 0 退出码（`2`）。

8. Trust Store merge 增强校验（当前已内置）：

- 校验 `--source-type/--target-type` 仅允许 `JKS` 或 `PKCS12`。
- 校验 source/target 不能是同一路径。
- 校验 source 必须存在且是文件。
- 若 target 已存在，必须是文件。
- 执行 merge/init 前先校验 `keytool` 可用。

9. 开发阶段快捷命令（npm scripts）：

- `npm run cli:help`: 查看 CLI 帮助。
- `npm run cli:start`: 以开发模式后台启动 CLI（等价 `maven-proxy start --mode development`）。
- `npm run cli:stop`: 停止后台 CLI 进程（等价 `maven-proxy stop`）。
- `npm run cli:doctor`: 以开发模式运行 doctor。
- `npm run cli:truststore:print`: 以开发模式输出 truststore 命令模板。
- `npm run cli:truststore:init`: 以开发模式初始化 truststore。
- `npm run cli:truststore:merge -- --source <path> --target <path> ...`: 以开发模式执行 merge。

## 9. 客户端使用方法

以下示例默认代理端口是 `8080`，与当前项目默认 `PROXY_PORT` 一致；如果你改过端口，请替换示例中的端口。

### 9.1 Gradle: 设置代理 + trust store

1. 在本项目中准备 trust store（若已执行过 `npm run truststore:init` 可跳过）：

```bash
npm run truststore:init
```

2. 编辑 `~/.gradle/gradle.properties`（全局生效），增加以下内容：

```properties
# Maven Proxy 代理
systemProp.http.proxyHost=127.0.0.1
systemProp.http.proxyPort=8080
systemProp.https.proxyHost=127.0.0.1
systemProp.https.proxyPort=8080

# 使用项目 trust store 信任本地 Root CA
org.gradle.jvmargs=-Djavax.net.ssl.trustStore=/Users/yize/projects/maven-proxy/data/certs/proxy-truststore.jks -Djavax.net.ssl.trustStorePassword=changeit
```

3. 最小验证（在任意 Gradle 项目下）：

```bash
./gradlew --refresh-dependencies dependencies
```

4. 如果不想改全局 `gradle.properties`，也可以一次性通过命令行传入：

```bash
./gradlew \
  -Dhttp.proxyHost=127.0.0.1 \
  -Dhttp.proxyPort=8080 \
  -Dhttps.proxyHost=127.0.0.1 \
  -Dhttps.proxyPort=8080 \
  -Djavax.net.ssl.trustStore=/Users/yize/projects/maven-proxy/data/certs/proxy-truststore.jks \
  -Djavax.net.ssl.trustStorePassword=changeit \
  dependencies
```

说明：`trustStore` 路径建议与你的 `TRUST_STORE_PATH` 保持一致。

补充：建议始终同时配置 `trustStorePassword`。若采用 `systemProp.javax.net.ssl.trustStore` 写法，也请同时配置 `systemProp.javax.net.ssl.trustStorePassword`；

### 9.2 npm: 设置代理 + 忽略 SSL 校验

> 仅用于本地开发排障。长期使用建议导入 Root CA 并保持 `strict-ssl=true`。

1. 设置 npm 代理：

```bash
npm config set proxy http://127.0.0.1:8080
npm config set https-proxy http://127.0.0.1:8080
```

2. 忽略 SSL 校验（开发环境临时使用）：

```bash
npm config set strict-ssl false
```

3. 验证代理是否生效：

```bash
npm ping
npm view lodash version
```

4. 恢复为安全默认值：

```bash
npm config set strict-ssl true
npm config delete proxy
npm config delete https-proxy
```

