# 变更日志

本文件记录了本项目的所有重要变更。

## [1.4.0] - 2026-06-03

### 变更
- 实现了对缓存未命中 GET 请求的流式处理，以改善客户端响应时间。

## [1.3.6] - 2026-05-26

修复使用meta.json时的header错误

## [1.3.7] - 2026-05-26

### 变更
- 为 `MULTI_THREAD_MIN_SIZE_MB` 和 `MAVEN_NEGATIVE_EVENT_MAX_MB` 增加对带单位的大小值支持（支持 `K/M/G/T`，例如 `1M`、`512K`）。
- 提取公共工具：`parseSizeToBytes` -> `src/common/size-utils.js`，`parseDurationToMs` 与 `formatBytes` -> `src/common/format-utils.js`，并更新调用方以复用实现。
- 更新 CLI 生成的默认配置模板与 `config.properties`，在对应项中使用带单位的默认值与示例说明。
- 更新 `README.md` 与 `README-zh.md`，在环境变量参考中记录单位支持。

### 新增
- 为尺寸与格式工具添加单元测试（`test/size-utils.unit.test.js`, `test/format-utils.unit.test.js`）。

### 其他
- 精简并消除配置与缓存清理模块中的重复实现。

## [1.3.4] - 2026-05-26

### 新增
- 实现 `meta.json` 处理以支持相关制品下载。 (4e50d41)
- 为 HTTPS 代理添加透传配置支持。 (6f1dc7e)

### 变更
- 改进 404 响应处理。 (2226291)

### 其他
- 忽略提交：ignore。 (2446d7c)
- 变更：prepare 1.3.4。 (942e413)

### 包含的 Git 提交
- `4e50d41` feat(proxy): implement meta.json handling for related artifact downloads
- `2226291` enhance 404 response
- `6f1dc7e` feat(proxy): add support for passthrough configuration in HTTPS proxy
- `2446d7c` ignore
- `942e413` prepare 1.3.4

## [1.3.3]

### 新增
- 增加了按 host 忽略 Maven 缓存路径前缀的支持。
- 增加了 Maven domain-dir 切换及缓存路径接线功能。

### 变更
- 移除正向 affinity 缓存重用：索引改为仅保留负缓存（404/410）以抑制重复上游请求。
- 将环境变量从 `MAVEN_AFFINITY_*` 重命名为 `MAVEN_NEGATIVE_*`，并保留对旧 `MAVEN_AFFINITY_*` 的向后兼容回退。
- 重写索引实现为 `src/cache/maven-negative-index.js`，并删除旧的 `maven-affinity-index.js`。
- 更新生成的配置模板（`bin/maven-proxy.js`）和示例 `config.properties` 以使用 `MAVEN_NEGATIVE_*`。
- 更新 `src/proxy/proxy-http-handler.js`：对无后缀路径跳过缓存，并在成功获取后清理负缓存条目。
- 更新测试与 npm 脚本以使用 `negative` 命名；移除了依赖正向 affinity 的回放/集成测试。
- 更新文档（README、docs）与 `ChangeLog.md` 以反映重命名与迁移说明。

### 移除
- 移除正向 affinity 索引逻辑以及相关的回放 / 端到端测试。

### 包含的 Git 提交（自 `1.3.1` 之后）
- `20ef408` feat(cache): add maven cache ignore path prefixes by host
- `75264bf` feat(cache): add maven domain-dir switch and wire cache paths

## [1.3.1] - 2026-05-26

### 新增
- 生成的默认 CLI 配置现在为每个属性都包含中英文注释，与 README 的环境变量描述保持一致。
- 新增 `cli:doctor:user` npm 脚本，可在用户模式下运行 doctor 检查。

### 变更
- 运行时默认值和生成的配置默认值中的 Google Maven 端点由 `maven.google.com` 更新为 `dl.google.com`。

### 包含的 Git 提交（自 `1.3.0` 之后）
- `e2398a7` feat(cli): add bilingual default config comments and refresh repo defaults

## [1.3.0] - 2026-05-25

### 重大变更
- 移除了对旧版时间环境变量键的兼容，以下键不再支持：
  - `DOWNLOAD_TIMEOUT_SECONDS`
  - `OUTBOUND_KEEP_ALIVE_SECONDS`
  - `MAVEN_NEGATIVE_CACHE_TTL_HOURS`
  - `MAVEN_NEGATIVE_FLUSH_INTERVAL_SECONDS`
  - `LOG_RETENTION_DAYS`
- 时间配置现在只接受带单位的键和值（如 `1s`, `1m`, `1h`, `1d`）：
  - `DOWNLOAD_TIMEOUT`（示例：`60s`）
  - `OUTBOUND_KEEP_ALIVE_INTERVAL`（示例：`1s`）
  - `MAVEN_NEGATIVE_CACHE_TTL`（示例：`24h`）
  - `MAVEN_NEGATIVE_FLUSH_INTERVAL`（示例：`5s`）
  - `LOG_RETENTION`（示例：`7d`）

### 新增
- 新增缓存清理管理器，包含：
  - 命中缓存时按文件最小触摸间隔更新 mtime（`utimes`）；
  - 缓存未命中路径下的压力触发清理检查；
  - 每日定时清理检查调度；
  - 从配置的保留窗口到最小窗口的分阶段清理。

### 变更
- Maven affinity 索引默认目录从本地缓存 `.index` 移至 `data/index`。
- 生成的配置模板和项目示例配置已使用新的带单位时间变量。
- 同步更新了 README 和 README-zh 的环境变量文档。

### 包含的 Git 提交（自 `1.2.1` 之后）
- `8b7a7ab` feat: add cache cleanup manager and move affinity index to data/index
- `ef40594` refactor: unify time env vars to duration format

## [1.2.1]

### 新增
- 新增非阻塞 CLI 进程控制：`maven-proxy start` 现在以后台守护进程方式运行，`maven-proxy stop` 可通过 PID 文件终止。

### 变更
- 正向 Maven affinity 缓存项不再因 TTL 过期，仅在本地文件缺失或冲突时移除。
- 通过新增 `LOG_CONNECT_EVENTS`（默认 `false`）减少 CONNECT/MITM 日志噪音。
- 新增代理日志，明确记录 `local cache hit` 和 `local cache miss`，提升缓存行为可观测性。
- 运行时默认值和生成的配置模板中，`HTTPS_PASSTHROUGH_FOR_UNMATCHED` 默认值改为 `false`。

### 修复
- 启动日志现在即使 `LOG_TO_STDOUT=false` 也会打印，并明确记录启动成功。
- 正向 Maven affinity 仅复用二进制制品（`.jar/.aar/.war` 及相关校验/签名文件），避免 `.pom/.module` 跨仓库元数据污染。

### 包含的 Git 提交（自 `prepare 1.2.0` 之后）
- `bbf1771` fix: keep positive affinity cache without ttl
- `cdb1421` fix: always print startup logs when stdout logging is off
- `4e8146f` feat: add non-blocking cli start and stop commands
- `b515910` fix: restrict maven affinity to binary assets
- `20fb0b9` chore: reduce connect noise and log cache hit miss
- `f99cf59` chore: default unmatched https passthrough to false

## [1.2.0]

### 重大变更
- 移除了对旧版环境变量的兼容，以下旧键不再支持：
  - `MULTI_THREAD_MIN_SIZE_BYTES`
  - `DOWNLOAD_TIMEOUT_MS`
  - `OUTBOUND_KEEP_ALIVE_MSECS`
  - `MAVEN_NEGATIVE_CACHE_TTL_MS`
  - `MAVEN_NEGATIVE_FLUSH_INTERVAL_MS`
  - `MAVEN_NEGATIVE_EVENT_MAX_BYTES`
- 环境配置现在只接受新的带单位键：
  - `MULTI_THREAD_MIN_SIZE_MB`
  - `DOWNLOAD_TIMEOUT_SECONDS`
  - `OUTBOUND_KEEP_ALIVE_SECONDS`
  - `MAVEN_NEGATIVE_CACHE_TTL_HOURS`
  - `MAVEN_NEGATIVE_FLUSH_INTERVAL_SECONDS`
  - `MAVEN_NEGATIVE_EVENT_MAX_MB`
- 默认配置文件重命名为 `config.properties`：
  - 开发模式加载项目根目录下的 `config.properties`。
  - CLI 用户模式使用 `~/maven-proxy/config.properties`。

### 变更（来自 1.1.1 之后的 git 提交）
- 统一日志策略，支持可选 stdout 镜像（`LOG_TO_STDOUT`）并简化日志输出。
- 新增 Maven affinity 缓存索引，支持持久化，并将测试入口标准化为 Node.js 内置测试。
- 启用出站连接池，并同步相关文档。

### 包含的 Git 提交
- `16d85fd` feat: unify logging and add stdout toggle
- `c3b9132` feat: add maven affinity cache and standardize tests
- `5f28c64` feat: enable outbound connection pooling and sync docs

## [1.1.1] - 2026-05-25

### 新增
- 新增成功下载日志，包含文件大小和耗时。

### 发布
- 1.1.1 版本发布准备提交。

### 包含的 Git 提交
- `e2391b7` feat: log successful downloads with size and elapsed time
- `66fa44f` prepare 1.1.1

## [1.1.0] - 2026-05-25

### 发布
- 上述条目的基线发布点。

### 包含的 Git 提交
- `39a7a65` prepare 1.1.0
