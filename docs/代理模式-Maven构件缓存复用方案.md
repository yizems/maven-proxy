# 代理模式 Maven 构件缓存复用方案（中文版）

## 1. 背景与问题

在 Gradle 通过代理端口访问仓库时，客户端会按仓库顺序逐个发起最终 URL 请求。
服务端并不知道 Gradle 的仓库列表，只能看到离散的 HTTP 请求。

现象：
- 某构件在第 2/3 个仓库成功后，下一次同构件请求仍可能先打第 1 个仓库。
- 如果仓库路径前缀不一致（如 `/maven2/...` 与 `/repository/maven-public/...`），仅靠 URL 原路径缓存可能无法复用。

## 2. 目标

1. 在代理模式下提升跨仓库复用命中率。
2. 严格识别 Maven release 构件，宁可少识别，不误识别。
3. 同时具备内存热数据与磁盘持久化，重启后可恢复记忆。
4. 对常见 404/410 场景做负缓存，减少重复无效探测。

## 3. 设计原则

1. 保守识别：仅对严格匹配的 release 文件启用复用。
2. 可回退：识别失败时回退到现有 URL 路径缓存，不影响原有行为。
3. 可观测：输出 affinity hit、negative skip 等日志。
4. 可恢复：索引采用内存 + 磁盘双层存储。

## 4. 严格识别规则（首期）

仅识别 release 构件，且路径结构满足：
- `group/artifact/version/file`

文件名需满足：
- `artifact-version(.classifier).ext`
- 其中 ext 仅允许：`pom|jar|module|aar|war`
- 允许校验/签名后缀：`.sha1|.sha256|.sha512|.md5|.asc`

版本规则：
- `version` 不以 `-SNAPSHOT` 结尾（首期只做 release）

仓库前缀归一化（严格白名单）：
- `/maven2/`
- `/m2/`
- `/repository/{repo}/`
- `/artifactory/{repo}/`
- `/nexus/content/repositories/{repo}/`
- `/repositories/{repo}/`

## 5. 双层索引

### 5.1 正向索引（positive）
- key: `canonicalKey`（即归一化后的 `group/artifact/version/file`）
- value: `cachePath`, `fileName`, `host`, `updatedAt`
- 过期策略：无 TTL，不做时间过期；仅在本地文件不存在或发生冲突时移除
- 适用范围：仅二进制资产（`jar|aar|war` 及其签名/校验后缀）参与正向复用；`pom|module` 不做跨仓库正向复用

作用：
- 当 URL 原路径未命中时，优先查正向索引，命中则直接返回缓存文件。

### 5.2 负向索引（negative）
- key: `requestScope|canonicalKey`
- value: `statusCode`, `expireAt`, `updatedAt`
- 过期策略：仅负缓存使用 TTL，到期自动失效

作用：
- 某请求作用域（协议+host:port+pathname）对某构件返回 404/410 后，在 TTL 期间直接跳过同作用域请求。
- 适合 Gradle 连续请求同构件时减少无效前置探测。

### 5.3 冲突索引（conflicts）
- key: `canonicalKey`
- value: 冲突原因与时间

作用：
- 一旦发现同一 canonicalKey 对应文件名不一致，标记冲突并禁用该 key 的跨仓库复用。

## 6. 存储方案（内存 + 磁盘）

### 6.1 内存层
- 使用 Map 持有 positive/negative/conflicts。
- 请求路径上优先查内存，保证低延迟。

### 6.2 磁盘层
- 目录：`MAVEN_AFFINITY_INDEX_DIR`（默认 `data/index`）
- 文件：
  - `maven-affinity.snapshot.json`（快照）
  - `maven-affinity.events.log`（JSONL 事件日志）

### 6.3 写入策略
- 状态变化先写入内存并排队事件。
- 按 `MAVEN_AFFINITY_FLUSH_INTERVAL` 周期 append 到事件日志。
- 事件日志超过 `MAVEN_AFFINITY_EVENT_MAX_MB` 时生成快照并清空日志。
- 退出时强制 flush + snapshot。

## 7. 请求流程（代理模式）

1. 按现有逻辑计算 URL 路径缓存键并先查文件。
2. 若为 Maven 且识别成功：
  - 若为二进制资产，查 positive 索引：命中则直接返回缓存文件（affinity hit）。
   - 查 negative 索引：命中且未过期则直接 404（negative skip）。
3. 未命中则正常回源下载。
4. 下载成功后写 positive。
5. 若回源返回 404/410，写 negative（带 TTL）。

## 8. 配置项

- `MAVEN_AFFINITY_ENABLED`: 是否启用，默认 `true`
- `MAVEN_AFFINITY_INDEX_DIR`: 索引目录，默认 `data/index`（相对配置基准目录）
- `MAVEN_NEGATIVE_CACHE_TTL`: 负缓存 TTL（支持 `s/m/h/d`），默认 `24h`
- `MAVEN_AFFINITY_FLUSH_INTERVAL`: flush 周期（支持 `s/m/h/d`），默认 `5s`
- `MAVEN_AFFINITY_EVENT_MAX_MB`: 事件日志压缩阈值（MB），默认 `8`

## 9. 首期范围与后续

首期：
- 仅 release 资产文件。
- 仅 404/410 负缓存。

后续：
- 加入 snapshot/metadata 的短 TTL 策略。
- 加入命中率、跳过率、冲突率统计输出。
- 对更多仓库前缀做可配置扩展。

## 10. 自动化回放验证

- 脚本：`test/replay-affinity.test.js`
- 命令：`npm test`（或 `npm run replay:affinity`）

脚本会自动完成以下步骤：
1. 清理测试缓存与日志目录。
2. 启动本地两个 mock Maven 仓库（A 返回 404，B 返回 200）。
3. 启动代理服务（独立测试端口）。
4. 依次请求：A(404) -> B(200) -> A(200)。
5. 断言第二次与第三次响应体一致，并验证上游请求计数符合预期（第三次不再回源）。
6. 自动停止进程并清理测试目录。
