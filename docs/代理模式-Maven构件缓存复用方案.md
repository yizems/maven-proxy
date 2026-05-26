# 代理模式 Maven 缓存重构方案（按域名目录 + 仅负向索引）

## 1. 背景与问题

当前 Maven 缓存模块使用了正向索引（positive）与 `canonicalKey` 做跨仓库复用。该方案在复杂仓库前缀与不同域名混用场景下，维护成本高、行为不直观，也容易让问题定位复杂化。

本次重构目标是简化 Maven 缓存行为：
- 不再做跨仓库正向复用。
- 移除 `canonicalKey` 相关能力。
- 保留并强化负向索引（negative）用于减少重复 404/410 探测。
- Maven 缓存目录按域名隔离。
- npm 缓存策略保持现状不变。

## 2. 重构目标

1. 移除正向索引（positive）与 `canonicalKey` 机制。
2. 仅保留负向索引（negative），用于 404/410 的短期抑制。
3. Maven 缓存目录按域名分类存储，域名之间不复用文件。
4. 请求行为简单可预测：
   - 本地文件存在则直接返回；
   - 本地不存在则回源；
   - 回源 404/410 则写 negative；
   - 回源成功则落盘并返回。
5. npm 模块缓存保持现状，不参与本次重构。

## 3. 设计原则

1. 简单优先：请求路径直接映射缓存路径，不再引入 canonical 归一化复用规则。
2. 域名隔离：不同域名缓存独立，避免跨域污染。
3. 失败可控：仅对 404/410 做 negative 缓存，其他状态按现有行为处理。
4. 可观测：保留 negative hit/record 等日志，便于排障。
5. 渐进迁移：重构阶段允许读取旧数据目录，但新写入按新结构落盘。

## 4. Maven 缓存目录模型（新）

在 `CACHE_DIR/maven` 下按域名分层：

```text
data/cache/maven/
  repo1.maven.org/
    maven2/junit/junit/4.13.2/junit-4.13.2.pom
  repo.maven.apache.org/
    maven2/org/apache/commons/commons-lang3/3.14.0/commons-lang3-3.14.0.pom
```

规则说明：
- 目录第一层固定为请求域名（hostname）。
- 域名下按请求 path 原样映射（去掉前导 `/`）。
- 不再做跨域或跨前缀的正向复用。
- 是否启用该目录结构由 `MAVEN_CACHE_USE_DOMAIN_DIR` 控制（默认 `false`）。

## 5. 索引模型（仅 negative）

### 5.1 负向索引（negative）

- key: `requestScope`
- requestScope 定义：`scheme://host:port/pathname`
- value: `statusCode`, `expireAt`, `updatedAt`
- 记录条件：仅当回源状态为 `404` 或 `410`
- 过期策略：TTL 到期自动失效

作用：
- 同一请求作用域在 TTL 内再次请求时可直接返回 404，避免重复无效回源。

### 5.2 删除项

以下能力在新方案中删除：
- 正向索引（positive）
- 冲突索引（conflicts）
- `canonicalKey` 解析与匹配逻辑

## 6. 存储方案（内存 + 磁盘）

### 6.1 内存层

- 使用 Map 持有 negative 索引。
- 请求路径先查内存 negative，命中则快速返回。

### 6.2 磁盘层

- 索引目录：建议沿用现有索引目录（默认 `data/index`），仅保存 negative 数据。
- 文件建议：
  - `maven-negative.snapshot.json`
  - `maven-negative.events.log`

### 6.3 写入策略

- negative 状态变化先写内存，再异步写事件日志。
- 定期 flush 事件；事件文件超过阈值时做快照并滚动日志。
- 进程退出时执行最终 flush。

## 7. 请求流程（代理模式）

1. 判断请求是否属于 Maven 生态（`MAVEN_REPO_DOMAINS` 命中）。
2. 计算目标缓存文件路径：`CACHE_DIR/maven/{hostname}/{url-path}`。
3. 若目标文件已存在，直接返回本地文件。
4. 若文件不存在，检查 negative 索引：
   - 命中且未过期：直接返回 404（negative skip）。
   - 未命中：继续回源请求。
5. 回源结果处理：
   - `404/410`：写 negative 索引并返回 404。
   - `2xx`：下载到 `.temp`，完整性通过后原子改名到目标路径并返回。
   - 其他状态：按现有代理逻辑透传，不写 negative。

## 8. 配置项（重构后）

核心配置：
- `CACHE_DIR`: 缓存根目录（Maven 缓存位于 `CACHE_DIR/maven/{domain}/...`）。
- `MAVEN_REPO_DOMAINS`: Maven 域名识别列表。
- `MAVEN_CACHE_USE_DOMAIN_DIR`: Maven 缓存是否按域名作为一级目录，默认 `false`。
- `MAVEN_CACHE_IGNORE_PATH_PREFIXES`: Maven 缓存应忽略的路径前缀规则（逗号分隔，支持 `host/path` 与 `host:port/path`）。默认：`repo1.maven.org/maven2,repo.maven.apache.org/maven2,jitpack.io/,plugins.gradle.org/m2,dl.google.com/dl/android/maven2,dl.google.com/dl/google/maven`。
- `MAVEN_NEGATIVE_CACHE_TTL`: 负缓存 TTL（支持 `s/m/h/d`），默认 `24h`。

索引持久化配置（命名可在实现阶段最终确定）：
- `MAVEN_NEGATIVE_INDEX_DIR`: negative 索引目录（建议默认 `data/index`）。
- `MAVEN_NEGATIVE_FLUSH_INTERVAL`: negative 事件 flush 周期。
- `MAVEN_NEGATIVE_EVENT_MAX_MB`: negative 事件日志压缩阈值（MB）。

兼容说明（迁移期可选）：
- 若暂不调整环境变量名，可将现有 `MAVEN_AFFINITY_*` 变量语义收敛为 negative 专用。

## 9. 行为差异与影响

1. 取消跨仓库正向复用：不同域名之间不再直接复用 Maven 文件。
2. 缓存命中逻辑更直接：只看“当前域名目录下是否有该文件”。
3. 对 404 探测的优化仍保留：negative TTL 内可避免重复回源。
4. npm 缓存模块与目录结构不变。

## 10. 自动化回放验证（更新）

- 脚本：`test/replay-affinity.test.js`（建议后续重命名为 `test/replay-maven-negative.test.js`）
- 命令：`npm test`（或后续新增专用脚本）

建议验证场景：
1. 同域名首次 200，第二次直接本地命中。
2. 同域名首次 404，TTL 内第二次直接 negative skip（不回源）。
3. 跨域验证：A(404) -> B(200) -> A（TTL 内仍 404），确保不发生跨域正向复用。
4. npm 请求路径与缓存行为保持不变。
