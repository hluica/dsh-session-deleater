# 会话删除功能调查与独立插件提取（dsh-session-deleater）

- 插件目录：`dsh-session-deleater`
- 计划包名：`@local/dsh-session-deleater`
- 调研对象：已安装插件 `dsh-session-manager` 0.7.8（`/Users/hanluica/.dsh/profiles/desktop/node_modules/dsh-session-manager`）
- 调研时 DSH 版本：`0.2.2-rc.3`（Desktop，`DSH_PROFILE=desktop`）
- 调研日期：2026-11-17
- 轮次状态：**仅调研，不产生实现代码**。本文记录现有删除功能的实现、安全性/稳定性判断、提取方案与验收计划；实际代码等待用户新开一轮确认。

---

## 1 目的与范围

### 1.1 目的

1. 调查 `dsh-session-manager` 中“删除会话”功能的完整实现方式。
2. 判断该实现是否足够安全、稳定，尤其是它依赖哪些 DSH 内部结构、这些依赖在升级时会不会静默失效。
3. 评估把这部分功能提取为独立插件 `dsh-session-deleater` 的可行性，并给出可实施的架构、步骤与验收标准。
4. 为后续在本工作区真正构建插件提供依据。

### 1.2 本轮边界

- 只做只读调查与文档，不修改 `dsh-session-manager`，不修改 DSH 安装，不删除任何真实会话。
- 不实现 Host/Client 代码；不初始化 profile 依赖；不推送远程仓库。
- 目标平台是当前 Desktop 安装（`0.2.2-rc.3`）；Web/CLI、其他 DSH 版本仅作为兼容性讨论。
- 讨论的是“删除会话”本身，不把工作区归档、跨工作区移动、预设迁移等其它能力一并提取。

### 1.3 术语

| 术语 | 含义 |
| --- | --- |
| 会话工件 | `<DSH_HOME>/sessions/<projectKey>/<encodeSegment(sessionId)>/session.v4.jsonl.zstd` 等持久化文件。 |
| live 会话 | 当前进程中 `ctx.sessions.get(id)` 能取到的会话。 |
| live writer | 当前进程中为某会话持有写句柄的持久化写入器。 |
| 投影缓存 | `sessionProjectionCache` 持久化的逐会话 checkpoint；位于 `storages/session_projcache/`。 |
| 级联删除 | 删除主会话时，递归删除 `origin === "subagent"` 的后代子智能体会话。 |
| 静默降级 | 内部接口缺失时仍继续执行，只是跳过某项清理，不向用户报错。 |

---

## 2 结论摘要

| 问题 | 结论 | 依据/代价 |
| --- | --- | --- |
| DSH 是否提供官方会话删除 API | **没有** | `dsh-session-persistence/README.zh.md` 明确“无删除或保留接口”；`dsh-workspace/README.zh.md` 明确会话删除“尚未提供”；`dsh-api-session-controller` 未发现删除会话的 Remote/Service 方法。 |
| `dsh-session-manager` 怎么删 | **Host 侧“先安全停活、再脱离注册、再删文件、再清缓存”的带外删除** | Host 在 `/session-manager/api/delete` 中调用 `deleteSession()`；Client 只负责确认与刷新。 |
| 路径/ID 安全 | **较强** | `assertSessionId`、`assertSessionDirectory`、header id 复核、符号链接/junction 拒绝、project/session 两层路径限定。 |
| 认证与授权 | **较强** | 复用 DSH `connection.admit(req)`，要求 `owner` principal；跨站/无凭证失败关闭。 |
| UI 安全性 | **较强** | 所有单条删除都必须经过二次确认；预览子会话失败时禁用确认按钮。 |
| 是否“足够安全” | **对本地单人桌面基本够用，但不是事务性删除** | 仍有不可逆、部分失败后状态不一致、假 `session/disposed`、`pinnedSessionIds` 残留、并发输入竞态等问题。 |
| 是否“足够稳定” | **中等偏脆弱** | 依赖 `sessions.store`、`agents.store`、`persistence.tracker`、`sessionProjectionCache.requireTable`、storage 表 `host.unit.descriptor`、`workspace entity.record` 等私有/未公开结构；部分缺失会静默跳过。 |
| 能否提取为独立插件 | **可行，推荐“复制 + 加固”，不是原样照搬** | 删除核心与 UI 入口都可以独立；Host 可零 npm 依赖；Client 用公开 slot；需保留 MIT 归属并新增兼容探针。 |
| 推荐首期范围 | **单条删除 + 级联 + 预览 + 标题栏/侧栏入口** | 批量删除/管理面板不是首期必需；可二期再做。 |
| 是否需要重启 DSH | 实现完成后需要，因为 Host 插件与 Client bundle 变化不会在现有页面自动生效 | 按工作区规则，到那一步应停止并提示用户重启。 |

---

## 3 现有实现：`dsh-session-manager` 0.7.8

### 3.1 入口与调用链

删除功能有三类 UI 入口：

1. 当前会话标题栏的“删除会话”按钮；
2. 会话管理面板每行的删除按钮；
3. 批量模式中的“删除会话”。

它们最终都调用 Host 的同一个前缀 API：

- 前缀：`/session-manager/api`
- 单条：`POST /delete`，body `{ sessionId }`
- 批量：`POST /batch`，body `{ action: "delete", sessionIds: [...] }`
- 预览：`GET /delete-preview?sessionId=...`（或 `sessionIds=a,b`）

Client 端的单条删除调用在 `lib/client.js:7312` 附近的 `onRemove`：

```js
const response = await callApi("/delete", { sessionId });
if (!response.ok) { ... throw ... }
await annotationStore.load(true);
if (wasCurrent || isCurrentSession(sessionId)) clearCurrentSession();
await ctx.sessions?.refresh?.();
await ctx.workspaces?.refresh?.();
```

Host 端路由注册在 `lib/index.js:2568`，删除分支在 `lib/index.js:2606`。真正的工作由 `deleteSession()`（`lib/index.js:2019`）完成。

### 3.2 Host 删除核心的分步行为

`deleteSession(sessionId)` 的主要步骤：

1. **ID 断言**：`assertSessionId`，拒绝空、`.`、`..`、路径分隔符、控制字符等。
2. **发现后代子智能体**：`findDescendantSubagents([sessionId])`（`lib/index.js:1883`），只沿着 `origin === "subagent"` 且 `parentSession` 指向当前父会话的头链遍历。扫描不完整时直接拒绝删除。
3. **删除前统一预检**：对主会话与所有后代：
   - 再次 `assertSessionId`；
   - `sessionDirOf()` 解析并 `assertSessionDirectory()` 校验目录；
   - `assertAndStopActiveSession()` 检查活动状态，必要时取消并等待空闲。
4. **先删后代，再删主会话**：`deletePlan = [...descendants].reverse()`；每个后代在 `mutate(sub.id, ...)` 中单独删除，删除成功后把 id 记入 `deletedSubagentIds`，并从 `remainingSubagentIds` 移除。
5. **主会话删除**（`lib/index.js:2094` 起）：
   - 解析目录、live session、live agent；
   - 安装投影缓存删除防护 `beginProjectionCacheDeletion`；
   - 取消 agent、等待空闲、从 `ctx.agents.store` 移除注册；
   - `ctx.sessions.flush(session)`，然后 `entry.detach()`，让持久化完成最后一次排空，并让 API controller 发出 `host/session-removed`；
   - 若没有 live entry，则手动 `ctx.emit("session/disposed", { id: sessionId })`；
   - `closeSessionWriters()` 关闭并等待所有写句柄；
   - `detachFromWorkspaces()`、`unarchiveSession()`；
   - `rm(dir, { recursive: true, force: true })` 删除会话目录；
   - 删除投影缓存、旧版聚合缓存；
   - 删除标记存储、工作区归档记录；
   - 返回 `{ ok, warning?, sessionId, wasLive, filesRemoved, deletedSubagents, subagentCount }`。
6. **失败处理**：若会话工件尚未删除，回滚投影缓存 tombstone；若已有后代被删，错误对象带 `deletedSubagentIds`、`remainingSessionIds`、`partialFailure`，HTTP 响应也带这些字段。

### 3.3 路径与工件解析

`lib/session-files.js` 承担文件层安全：

- `assertSessionId`（`:22`）：拒绝路径分隔符、控制字符、`<>"|?*`、结尾点/空格、`.`/`..`。
- `encodeFsSessionSegment`（`:58`）：与 DSH `encodeSegment` 相同的 `~XXXX` 转义规则。
- `candidateSessionDirs`（`:125`）：主编码目录、raw id、旧版 projectKey 形式。
- `assertSessionDirectory`（`:139`）：
  - 只允许 `<sessions root>/<project>/<sessionDir>` 恰好两层；
  - `sessionDir` 必须是候选目录之一；
  - 逐层 `lstat`，拒绝符号链接/junction/普通文件；
  - 逐层 `realpath`，拒绝解析到 root 之外；
  - root 本身允许是符号链接（DSH 允许 home 通过链接配置）。
- `readSessionHeader`（`:189`）：只读第一行，校验 header；`readSessionFile`（`:214`）要求完整 JSONL 且尾部换行。
- 删除前用 `sessionDirOf()`（`lib/index.js:1870`）读工件 header，确认 `header.id === sessionId`，才返回目录。这样“目录名刚好等于用户输入”不会导致误删。

### 3.4 子智能体级联

`findDescendantSubagents` 会合并三类来源：

- `adapter.cachedSessionHeaders()`（workspace registry 的内存 header 缓存）；
- `ctx.sessions.list()` 的 live header；
- `scanSessionHeaders()`（`lib/index.js` 约 `:124`）扫描持久化索引和磁盘目录。

只有 `origin === "subagent"` 且 `parentSession` 链能连到根会话的头才会进入结果；fork 会话（`origin !== "subagent"`）不会被级联删除。每个后代还要求“有可验证目录或 live 状态”，否则不纳入。

扫描结果带 `complete` 标志：只要持久化列表失败、任一目录不可读、header 不一致、目录名与 header 不匹配，`complete` 就是 false，删除预览/删除都会拒绝。这是有意为之的“失败关闭”，代价是**一个损坏会话可能阻塞所有删除**。

### 3.5 活动停止

`assertAndStopActiveSession`（`lib/index.js:1955`）在删除前做：

1. 读 live session 的 `activeTurn`、live agent 的 `status/busy`；
2. 通过 `ctx.waterfall("workspace/session-activity", { sessionId }, ...)` 询问其它插件还有什么活动（后台任务、定时任务等）；
3. 若没有停止接口，直接拒绝；
4. 若有 agent，调用 `agent.cancel({ kind: "disposed" })`，再等 `whenIdle()`；
5. 若 registry 有 `stopSessionActivity`，调用它；否则用 `ctx.parallel("workspace/session-stop", ...)`；
6. 再检查 agent 是否仍在运行、`workspace/session-activity` 是否还有剩余活动；
7. 任何一步超时（`awaitSessionStep` 默认 3000ms）都会抛错并停止后续删除。

`workspace/session-activity` 与 `workspace/session-stop` 是 DSH 组合层面的公开事件：前者是 waterfall，后者是 parallel；`dsh-agent`、`dsh-jobs`、`dsh-schedule`、`dsh-subagent` 等提供方会在这两个事件里报告/停止自己的工作。因此删除一个空闲但仍有活动定时任务的会话时，这些任务会被一并停掉，而不是留到删除后继续投递。

需要注意语义：`workspace/session-stop` 的文档描述是“调用方以 `stopActivity` 归档会话时，停止其运行中的工作”，删除路径是**借用**它来停止活动，因为 DSH 没有 delete 专用的 stop 事件。当前提供方的实现只执行停止动作，不依赖归档集合，所以可用；但如果未来某个提供方开始检查“归档标记是否已持久化”，删除路径的借用就会失配。提取版应把这条调用封装在 `stopSessionActivityForDelete()` 中，并在升级时回归。

### 3.6 持久化 writer 与投影缓存

**writer 处理**（`lib/compat/session-lifecycle.js`）：

- `sessionWriters`（`:17`）从 `persistence.tracker.writers` 和 `persistence.tracker.openHandles` 收集该会话的写句柄。
- `closeSessionWriters`（`:28`）逐个 `writer.close()`，然后等待 `persistence.coordinator.retirements`（如果存在），最后检查 `persistence.coordinator.states` 是否仍有 owner。任何写句柄没有 `close` 方法都会抛错，阻止删文件。
- `awaitSessionStep`（`:2`）统一给这些步骤加 3 秒上限。

**投影缓存**（`lib/compat/projection-cache-delete.js`）：

- `beginProjectionCacheDeletion`（`:16`）在 `table` 的 `put` 上安装 tombstone：删除前把该会话生命周期身份（`createdAt`、`cwd`、`isSeeded`）写入 `removed` 集合；之后同一生命周期的延迟 `put` 被忽略，防止“删了会话又被迟到写入写回缓存”。
- `remove()` 调用 `table.delete(id)`。
- 若删除失败且工件未删，`rollback()` 撤销 tombstone。
- `assertProjectionCachePath`（`:63`）逐段检查缓存路径不是符号链接。
- `removeLegacyProjectionCache`（`:78`）对旧版 `storages/session_projcache.json` 使用独立 lock 文件（`session_projcache.session-manager.lock`）串行化，校验 unit 名称/版本/表结构，然后用 `replaceSessionFile` 原子替换；未知格式拒绝修改。

### 3.7 工作区、归档、标记清理

- `detachFromWorkspaces`（`lib/index.js:606`）遍历 `workspaceRegistry.list()`，用 `entity.record.sessionIds`（私有字段）判断归属，再调用公开的 `entity.detachSession(sessionId)`。
- `unarchiveSession`（`lib/index.js:474`）优先 `uiWorkspace.unarchiveSession`，其次 `workspaceRegistry.unarchiveSession`，最后才用 `enqueueOperation/requireState/setState` 直接改状态。
- 标记存储与工作区归档存储是 `dsh-session-manager` 自己的数据（`annotations.v1.json`、workspace archive store），删除路径会尽力清理；失败只记 warning。
- **没有清理 `pinnedSessionIds`**：删除一个已置顶但未归档的会话后，pin 集合里仍保留该 id。`workspaceRegistry` 有公开的 `unpinSession`（`dsh-workspace/src/index.ts:477`），但删除路径没有调用。

### 3.8 Client UI

- 标题栏删除按钮在 `lib/client.js:6491` 附近；面板行删除按钮在 `:5284` 附近；批量删除在 `:4880` 附近。
- 单条删除的确认对话框在 `:6631`；确认前会请求 `/delete-preview`，加载中或预览失败时 `confirmDisabled` 为 true（`:5982` 附近的批量版本同理）。
- 警告文案包含“正在运行，删除将立即中断它”和“将连带删除 N 个关联的子智能体会话”。
- 删除失败时，`onRemove` 只把 `response.error` 包装成 Error；`runWithAlert`（`:6238`）只显示 `error.message`，**没有展示 `deletedSubagents`/`remainingSessions`**。批量结果对话框则逐条展示。
- 成功后若删的是当前会话，调用 `clearCurrentSession()`，再 `ctx.sessions.refresh()`、`ctx.workspaces.refresh()`。

### 3.9 API 认证

`authenticateApiRequest`（`lib/index.js:2521`）在读取 body 之前调用：

```js
const admission = connection.admit(req);
if ("rejection" in admission) { ... 401/403 ... }
if (admission.peer?.principal?.kind !== "owner") { ... 403 ... }
```

`connection` 是 DSH 的公开 Host 服务；`dsh-client-connection/src/index.ts:151` 自身也用同一 `admit()` 保护 `/api`，`rpc.ts:240` 把 `admit()` 声明在公开接口上。因此这条认证路径是稳定的，且能拒绝无凭证、跨站、非 owner 的请求。

---

## 4 安全性分析

### 4.1 威胁模型

考虑四类风险：

1. **误删/越界删除**：用户输入或恶意请求导致删除 sessions 目录之外的文件。
2. **并发/生命周期错误**：删除时还有写入、运行中的 turn、定时任务或新输入，导致数据损坏或“删了又回来”。
3. **不可逆操作的部分失败**：删除到一半失败，留下既不在列表里、又没删干净的状态。
4. **越权调用**：非 owner 或跨站页面调用删除 API。

### 4.2 做得好、应当保留的部分

| 机制 | 评价 |
| --- | --- |
| ID 白名单式校验 + 路径两层限定 | 强。即使 `sessionId` 来自 HTTP，也无法直接拼接出 `../` 路径。 |
| header id 复核 | 强。不会因为目录名碰巧匹配就删除。 |
| 符号链接/junction 拒绝 + realpath 限定 | 强。root 可链接，但 project/session 子目录不可链接。 |
| 删除前预检所有后代 | 强。避免“删了一半后代才发现主会话不能删”。 |
| `workspace/session-activity` + `workspace/session-stop` | 设计好。让 schedule/jobs 等提供方按公开事件停止自己的工作。 |
| writer close + `flush` + `detach` | 方向正确。先排空、再脱离、再删文件。 |
| 投影缓存 tombstone | 设计好。解决“删除后迟到写入把缓存写回”的竞态。 |
| 旧版缓存 lock + 原子替换 | 设计好。避免并发删除破坏聚合 JSON。 |
| owner-only + 跨站防护 | 强。认证失败关闭。 |
| UI 二次确认 + 预览失败禁用确认 | 强。破坏性操作没有“一键误删”路径。 |
| 部分失败显式返回 | 方向正确。至少 batch 与 HTTP 响应知道哪些后代已删。 |

### 4.3 残余风险

#### R1. 不可逆，且删除中途失败可能出现“文件还在、列表已消失”

**证据**：`lib/index.js:2158-2166` 的顺序是：

```js
await detachFromWorkspaces(sessionId);
await unarchiveSession(sessionId);
if (dir !== undefined) {
  await assertSessionDirectory(...);
  await rm(dir, { recursive: true, force: true });
}
```

在 `rm` 之前，live session 已经被 `detach()`，agent 已经被取消/移除。若 `detachFromWorkspaces`、`unarchiveSession` 或删除前的最后一次 `assertSessionDirectory` 抛错，代码进入 `catch`：

- `artifactsDeleted` 仍为 false，`projectionDeletion.rollback()` 只回滚缓存 tombstone；
- **不会重新 attach session/agent，也不会把会话重新挂回工作区**；
- 文件还在磁盘上，但当前 UI 已收到 `session/disposed`/`host/session-removed`，列表里没有它；
- 用户无法从 UI 重试；下次启动时 boot reconcile 可能把它重新挂回，表现为“删除失败后又回来了”。

这是**最值得在提取版修正的顺序问题**。同理，`closeSessionWriters` 失败、`entry.detach()` 失败也会留下类似状态。

**修法**：把所有“删除后清理”类操作（workspace detach、unpin、unarchive、缓存、标记）移到 `rm` 成功之后，并降级为 warning；`rm` 之前只保留必须前置的验证与 live teardown。若 `rm` 失败，明确报告“会话文件仍在 `<path>`，重启后可能重新出现”，并尽量提供恢复入口。

#### R2. 没有 live entry 时伪造 `session/disposed`

**证据**：`lib/index.js:2148-2150`：

```js
if (!detached) {
  if (typeof ctx.emit === "function") ctx.emit("session/disposed", { id: sessionId });
}
```

但 `session/disposed` 的公开签名是 `(session: Session)`（`dsh-session/src/index.ts:65`、Event Inspect 的 `Session` 类型）。这里传的是 `{ id }`，不是 `Session` 实例。

**影响**：

- API controller 只读 `session.id`，所以列表删除仍然生效；
- 但其它监听器会拿到不合约的对象。多数监听器用 `Map<Session, ...>` 做 key，冷会话通常没有状态，所以实际多半静默无操作；`dsh-session-title`、`dsh-session-projection-cache`、`dsh-client-file-upload`、`dsh-client-ui-trajectory`、`dsh-workspace-changes`、`dsh-session-telemetry` 都属于这一类。
- **没有监听器错误隔离**：真实的 `session/disposed` 由 `SessionStore.emitDisposed`（`dsh-session/src/index.ts:1399-1406`）逐个监听器 `try/catch` 并记录；这里直接 `ctx.emit`，Cordis 的普通 emit 不做这种隔离。任何一个监听器同步抛错，都会在 `entry.detach()` 已经执行之后把异常抛出，触发 `catch (parentErr)`，导致“客户端行已消失、磁盘文件还在、工作区和缓存都没清”的 torn state（与 R1 同源）。
- 风险还在于**依赖了不合法的生命周期边**；未来某个监听器如果对 `session.header`/`session.id` 之外做校验，就可能抛错或误清理。

**修法**：冷会话不要伪造 `session/disposed`。更干净的做法是发一个 payload 精确的 `api-session/removed`（Event Inspect 签名 `(sessionId: SessionId) => void`，`mode: emit`），让 API 列表删除该行；live 会话仍由真实的 `entry.detach()` 发 `session/disposed`。`api-session/removed` 是 `dsh-api-remotes` 转发到客户端的白名单事件，payload 简单，且不需要构造假 Session。即便如此也应 `try/catch`，避免监听器异常影响删除主流程。若担心它属于 API 包内部契约，至少应在提取版把这条路径隔离在一个兼容函数里，并在 DSH 升级时回归。

#### R3. `pinnedSessionIds` 残留

**证据**：删除路径只调用 `unarchiveSession`（`lib/index.js:2159`），没有 `unpinSession`。`dsh-workspace/src/index.ts:477` 有公开的 `unpinSession`。

**影响**：已置顶会话删除后，`storages/workspace.json` 的 `pinnedSessionIds` 仍含该 id。UI 通常会与已知会话取交集，所以不一定显示幽灵行；但状态会积累，且如果 id 被复用（UUID 概率极低）会继承置顶。属于低到中等严重度的清理缺陷。

**修法**：删除成功后尽力调用 `workspaceRegistry.unpinSession(sessionId)`；失败只记 warning。

#### R4. 主会话的“停止活动 → detach”之间仍有新输入竞态

**证据**：主会话在预检里调用一次 `assertAndStopActiveSession`；之后在 `lib/index.js:2094-2155` 只做 `agent.cancel` + `whenIdle` + `flush` + `detach`，没有再次检查 `workspace/session-activity` 或新的 live agent。后代因为 `skipSubagents` 分支会再调用一次 `assertAndStopActiveSession`，主会话没有同等复查。

**影响**：多客户端/定时投递在预检后、detach 前的新输入理论上可以启动新一轮；`cancel({ kind: "disposed" })` 会抑制一部分 re-wake，但代码没有证明所有入口都被堵住。窗口很小，但不是零。

更严重的是 **resume 与重新 materialize 的窗口**：`dsh-session-persistence-jsonl` 的写打开会 `claimWrite`，而持久化批次在 `materialized: false` 时会走 `materialize()`，其内部 `mkdir(project/dir, { recursive: true })`（`.../src/index.ts:911-925`、`:1284-1295`）。如果删除流程在“writer 已关、目录尚未删/刚删”的窗口内遇到并发的 resume 或同 id 新建，理论上可以重新创建会话目录。注意：`open(id, "write")` 对已删除工件会先 `findLog` 并抛 `SessionPersistenceNotFoundError`（`.../src/index.ts:426-427`），所以这条链能否真正触发取决于调用方是否走“新建/待 materialize”路径；本次未做实机复现，**应作为待验证的高风险竞态**，而不是已证实漏洞。

**修法**：在 `flush` 之后、`detach` 之前再次执行活动检查；若出现新活动，停止并报错，不继续删文件。或者引入插件级“deleting”集合，在 API 层拒绝同一会话的新操作（但这不能阻止其它插件的直接调用）。最稳妥的是先 `rename` 会话目录到隔离名（同目录 `.deleting-<id>-<random>`），再删；这样即使有并发 materialize，也会落到新目录，删除完成后可检测并清理。

#### R5. 私有内部结构缺失时静默降级

**证据**：

- `sessionWriters`（`lib/compat/session-lifecycle.js:17`）读 `persistence.tracker.writers/openHandles`；若 `tracker` 不存在，返回空数组。
- `closeSessionWriters`（`:28`）对空数组直接通过，不报错。
- `lib/index.js:2120` 移除 agent 注册时：

  ```js
  else if (!entry || entry === agent || entry.agent === agent) ctx.agents?.store?.delete?.(sessionId);
  ```

  若 `store.delete` 不存在，`?.` 让整句静默跳过，agent 注册可能残留。
- `entry.detach()` 若 `ctx.sessions.store` 不存在，`detached` 为 false，走伪造事件路径。
- `closeSessionWriters` 还会检查 `persistence.coordinator.retirements/states`（`:33-37`）；但 **0.2.2-rc.3 的 JSONL 后端没有 `coordinator`**（对该版本 `@deepseek-ai/*` 的 `src/*.ts` 检索，只有 `dsh-session-telemetry` 使用同名概念，与持久化无关）。因此这段 owner 检查在本版本是死代码，永远静默通过。

**影响**：DSH 升级把 `store`/`tracker`/`detachEntered` 改名或改成原生私有字段后，插件不会在加载时失败，而是**照常返回成功，只是没有关闭 writer / 没有移除 agent / 没有发真实 disposed 事件**。这比直接报错更危险：用户以为删除成功，实际可能留下可继续写入的句柄或幽灵注册。`coordinator` 死代码还会给人“已经检查过 writer owner”的错觉。

**修法**：提取版应把“能力探测”变成前置条件：

- 若存在 live session/agent，但拿不到 `sessions.store`、`entry.detach`、`agents.store`、`agents.detachEntered`，直接在前置检查阶段失败；
- 若存在 live writer 但 `persistence.tracker` 取不到，直接失败；
- `closeSessionWriters` 改为“支持标志 + 期望写句柄数”，不再用空数组表示成功；
- 所有 `?.` 只用于可选的**清理**步骤，不用于关键的**生命周期脱离**步骤。

#### R6. 全局扫描不完整会阻塞所有删除

**证据**：`findDescendantSubagents`（`lib/index.js:1883`）要求 `scanSessionHeaders` 的 `complete` 为 true；`scanSessionHeaders` 对每个无法完整读取的会话目录 `push` error（`lib/index.js` 约 `:203`）。`delete-preview` 失败后，Client 的确认按钮被禁用。

**影响**：一个损坏的会话工件、一个权限异常的目录、一个符号链接项目目录，都可能让**所有会话**无法删除。这是安全优先的取舍，但对用户是“为什么删不掉”的困惑来源。

**修法**：保留失败关闭作为默认，但提供更细的诊断（列出阻塞的目录/原因）；可考虑在提取版加一个明确的“仅删除指定会话，不扫描无关损坏项”的受限模式，但必须确保子会话级联完整性，不能为了可用性牺牲正确性。

#### R7. 删除失败留下的空目录会反过来阻塞后续删除

**证据**：`scanSessionHeaders` 对“扫描到但读不出任何工件”的未知会话目录会 `errors.push("无法完整读取会话目录: ...")`（`lib/index.js` 约 `:203`）。而 `findDescendantSubagents` 只要 `complete === false` 就抛错，`delete-preview` 失败后 Client 禁用确认。

**影响**：R1 的部分 `rm` 失败、手工清理残留、旧版迁移中断，都可能留下一个没有 `session.*.jsonl*` 的目录。这个空目录会让**之后所有删除**的预览都失败，形成“删一次失败，从此删不了”的死锁；用户只能手工去 `~/.dsh/sessions/...` 清理。这是比“单个损坏会话阻塞”更现实的连锁故障。

**修法**：区分“空目录/无工件”与“有工件但不可读”：

- 空目录（没有任何 `session.*.jsonl*`）可以跳过并记 warning，它不可能藏有子会话；
- 有工件但 header 不可读/目录名不一致，才计入 `complete=false`；
- 删除失败时报告残留路径，方便用户清理；
- 提取版的 `scanSessionHeaders` 应把“无关空目录”视为可忽略，而不是全局错误。

#### R8. 旧版缓存 lock 的陈旧锁

**证据**：`removeLegacyProjectionCache`（`lib/compat/projection-cache-delete.js:78`）用 `session_projcache.session-manager.lock`，只在 `finally` 中按 token 删除；进程崩溃会留下 lock 文件，之后 3 秒超时并报“锁正被占用”。

**影响**：0.2.2 默认是 `per-record` 布局，旧聚合文件通常不存在，所以影响面小；但一旦存在，崩溃后需要人工删除 lock 才能继续清理旧缓存。

**修法**：lock 文件写入 pid/时间戳，超时后检查 pid 是否存活或 mtime 是否过旧；或者把旧缓存清理完全降级为“下次启动再试”的后台任务。

另外两个低风险边角：

- **tombstone 成功删除后不回收**：`beginProjectionCacheDeletion` 把该生命周期的 key 写进 `guard.removed`，`remove()` 成功后没有清除（`lib/compat/projection-cache-delete.js:34-36`）。同一进程反复删除会缓慢累积；如果用户从备份还原“同 id + 同 createdAt + 同 cwd”的会话，它的缓存写入会被永久静默丢弃。修法：`remove()` 成功后按 id 清理，或把 guard 限定在短时间窗口。
- **`rm` 半失败时过早回滚 tombstone**：`catch (parentErr)` 只在 `artifactsDeleted === false` 时 `projectionDeletion.rollback()`（`lib/index.js:2217-2218`）。如果 `rm` 已经删了一部分文件才抛错，`artifactsDeleted` 仍为 false，tombstone 被撤销，残存的会话可能重新接受缓存写入，留下不一致的缓存行。修法：在开始 `rm` 前就把“工件正在删除”标记为不可回滚，或在 `rm` 失败后禁止该 id 的缓存写入一段时间。

#### R9. 删除后残留的其它数据

| 数据 | 是否清理 | 影响 |
| --- | --- | --- |
| session 工件目录 | 是 | 主目标 |
| 投影缓存 | 是（失败 warning） | 失败时磁盘残留 |
| `pinnedSessionIds` | **否** | 见 R3 |
| `archivedSessionIds` | 是（`unarchiveSession`） | 正常 |
| workspace `sessionIds` | 是（detach） | 若失败，boot reconcile 兜底 |
| `dsh-session-manager` 的 annotations | 是（尽力） | 独立插件无法知道该格式 |
| `dsh-session-manager` 的 workspace archive store | 是（尽力） | 同上 |
| spill 文件（`dsh-spill-local`） | **否** | 按 `cleanupPeriodDays`（默认 30 天）后清理，或 OS 临时目录清理 |
| attachments | **否** | 内容寻址，可能被其它会话共享；不删是安全的 |
| session query SQLite 索引 | 间接 | 下次搜索 reconcile 时删除；不是实时 |
| 定时任务 | 通过 `workspace/session-stop` | schedule 会删除目标为该会话的活动任务 |
| 后台 jobs | 通过 `workspace/session-stop` | jobs 提供方停止 |
| Git worktree / 项目目录 | **否** | 正确：删除会话不应删除项目或工作树 |

这些残留大多是可接受的“保守清理”，但 README 应如实说明，避免用户误以为“磁盘上一点不剩”。

#### R10. 部分失败的用户告知不足

**证据**：Host 在部分失败时返回 `deletedSubagents`、`remainingSessions`、`partialFailure`；`onRemove`（`lib/client.js:7312`）把这些挂在 Error 上，但 `runWithAlert`（`:6238`）只显示 `error.message`。单条删除的对话框不会列出“已删了哪些子会话、还剩哪些”。

**影响**：用户可能不知道删除已经部分发生，也不知道该重试哪个 id。批量模式的结果对话框做得更好，但单条模式没有对齐。

**修法**：提取版的错误对话框直接渲染 `deletedSubagents` 与 `remainingSessions`；成功但有 warning 时也展示 warning，而不是只 `window.alert`。

#### R11. 标题栏删除路径不显示“正在运行”警告

**证据**：标题栏与“更多操作”菜单打开确认框时只传 `{ id, displayTitle }`（`lib/client.js:6506`、`:6621`），而确认框的警告文案读取 `confirmFor.running`（`:5988`）；行删除路径传的是整行对象 `s`（`:5289`），所以行路径有 running 信息，标题栏路径没有。

**影响**：用户从标题栏删除一个正在运行的会话时，只看到“不可撤销”，看不到“删除将立即中断它”。这不会让删除变得不安全（Host 仍会停止活动），但会让用户对“为什么任务被中断”感到意外。

**修法**：提取版从 `useSessions`/`useSessionStatus` 读取当前 `sessionId` 的 running 状态，传入确认框；不要依赖确认对象里恰好带了 `running`。

#### R12. 其它低风险点

- **TOCTOU**：`assertSessionDirectory` 与 `rm` 之间仍有极短窗口；Node 的 `rm` 不跟随符号链接，且删除前会再校验一次，实际风险低。
- **`entity.record` 私有**：`detachFromWorkspaces` 依赖 `entity.record.sessionIds`；若字段改名，会退化为 `entity.sessionIds` 过滤视图，可能漏掉 stale 成员，但 boot reconcile 会兜底。
- **`ctx.emit` 伪造事件**：见 R2。
- **HTTP body 限制**：64 KiB；批量预览用 query string，200 个 id 可能接近 URL 长度限制；单条删除不受影响。
- **`rm` 的 Windows 重试**：没有 `maxRetries`；Windows 上锁文件/杀毒软件短暂占用可能导致 `EBUSY/EPERM`，删除失败。
- **不可逆**：没有回收站/备份。README 明确“不可逆”，UI 也二次确认，但这是产品选择，不是 bug。

### 4.4 安全性结论

- **越界删除/路径注入**：防护充分，未发现可直接利用的路径穿越。
- **越权调用**：防护充分，owner-only + DSH connection 的 Host/Origin 检查。
- **误操作**：确认流程充分；但“部分失败后列表消失、文件残留”会制造难以理解的状态。
- **数据完整性**：前置验证与 writer/cache 处理方向正确；主要缺陷是“清理顺序”和“私有接口缺失时静默降级”。

**判断**：对本地单人桌面、在固定 DSH 版本上使用，它“基本安全”；但它不是事务性删除，也不是可以无脑信任的通用删除原语。提取版应当保留其防御性设计，并修正 R1/R2/R3/R5/R7/R10/R11。

---

## 5 稳定性与版本耦合

### 5.1 删除路径依赖的 DSH 内部符号

| 符号 | DSH 位置 | 可见性 | 用途 | 缺失时当前行为 |
| --- | --- | --- | --- | --- |
| `ctx.sessions.store` | `dsh-session/src/index.ts:1145` | TS `private` | 取 `SessionEntry`，调用 `entry.detach()` | 退化为 `ctx.emit("session/disposed", {id})`（伪造） |
| `SessionEntry.detach` | `dsh-session/src/index.ts:1326` | 实例字段，非公开 API | 从 store 移除并发 disposed | 同上 |
| `ctx.agents.store` | `dsh-agent/src/index.ts:250` | TS `private` | 取 `AgentEntry`，移除 agent 注册 | `?.` 静默跳过，可能残留 agent |
| `ctx.agents.detachEntered` | `dsh-agent/src/index.ts:511` | TS `private` | 正确移除 agent 并 emit `agent/disposed` | 退化为 `store.delete`，不发 disposed |
| `persistence.tracker` | `dsh-session-persistence-jsonl/src/index.ts:316` | TS `private readonly` | 读写句柄/打开句柄集合 | `sessionWriters` 返回空，删除照常继续 |
| `tracker.writers` | `.../src/storage.ts:395` | TS `private` | 找该会话 writer | 空数组 |
| `tracker.openHandles` | `.../src/storage.ts:393` | `readonly` 公开字段 | 找已打开写句柄 | 空集合 |
| `persistence.coordinator` | 0.2.2-rc.3 **未发现（死代码）** | — | 等待 retirement / 检查 owner | 永远跳过，给人“已检查 owner”的错觉 |
| `sessionProjectionCache.requireTable` | `dsh-session-projection-cache/src/index.ts:398` | TS `private` | 取缓存表，安装 tombstone/删除 | `beginProjectionCacheDeletion` 返回 undefined，缓存清理降级 |
| `table.host.unit.descriptor.layout` | `dsh-storage-domain/src/domain.ts:197` + `dsh-storage-json` 单元的私有 `descriptor` | 深层内部 | 判断 per-record vs 旧聚合 | 旧版判断失效，最坏只留 warning |
| `entity.record` | `dsh-workspace/src/entity.ts:71` | TS `private` | 读持久化 `sessionIds` | 退化为过滤视图，可能漏 stale 成员 |
| `workspaceRegistry.stopSessionActivity` | `dsh-workspace/src/index.ts:504` | TS `private` | 停止活动 | 回退到公开 `ctx.parallel("workspace/session-stop")` |
| `ctx.sessions.flush` | `dsh-session/src/index.ts:1422` | **公开** | 排空缓冲事件 | 不涉及 |
| `ctx.sessions.get/list` | 公开 | 公开 | 读 live 状态 | 不涉及 |
| `ctx.agent.cancel/whenIdle` | `dsh-agent/src/runtime-types.ts:213/221` | 公开 | 取消并等待空闲 | 不涉及 |
| `workspaceRegistry.unarchiveSession` | `dsh-workspace/src/index.ts:420` | 公开 | 移出归档集合 | 有 fallback，最终失败则中止 |
| `workspaceRegistry.unpinSession` | `dsh-workspace/src/index.ts:477` | 公开，但**未使用** | 清理 pin | pin 残留 |
| `SessionPersistence.list` | 公开 | 公开 | 列表 | 磁盘 fallback |
| `SessionPersistence.locate` | `dsh-session-persistence-jsonl/src/index.ts:345` | TS `private` | 定位工件路径的提示 | 回退磁盘扫描（安全降级） |
| `connection.admit` | `dsh-client-connection/src/index.ts:151` + `rpc.ts:240` | 公开接口 | 认证 | 插件不加载（required inject） |

### 5.2 为什么这些私有依赖是必要的

DSH 0.2.2-rc.3 **没有**以下任一官方能力：

- `sessionPersistence.delete()` / `prune()`：`dsh-session-persistence/README.zh.md:153` 明确“无删除或保留接口——剪枝已存储会话属于带外后端维护”。
- `workspaceRegistry.deleteSession()`：`dsh-workspace/README.zh.md:171` 明确“会话删除与文件夹移除是彼此独立且尚未提供的功能”。
- `api-session-controller` 的 delete Remote：没有。
- `AgentHandle.dispose()` 可供第三方使用：`AgentHandle` 是创建者能力，`ctx.agents.get()` 只返回裸 `Agent`，不暴露 handle。
- `SessionReference.release()`：只拆除内存绑定，不删除工件。

因此，**任何第三方删除插件都必须做带外文件删除**，并至少触碰 `sessions` store 与 persistence 的一些内部状态。这是平台缺口，不是 `dsh-session-manager` 的过度设计。

### 5.3 版本升级风险

- 插件 `package.json` 只声明 `peerDependencies: { "@deepseek-ai/cordis": ">=4.0.0-rc <5" }`，没有 DSH 版本范围或运行时版本检查。
- 0.2.x 的 `SessionStore`/`AgentRegistry` 用 TS `private` + 普通字段；当前 JS 运行时属性名是 `store`、`detachEntered`、`tracker`、`writers`。若未来改成 ECMAScript `#private` 或重命名，插件会**静默降级**，而不是加载失败。
- DSH 的 `storage` 表内部（`table.host.unit.descriptor`）是更深的实现细节，升级风险更高，但它只影响旧缓存清理，最坏留 warning。
- boot reconcile（`lib/index.js:2320` 附近）会清理工作区中的 orphan id，能兜底一部分 workspace 残留；但它不清理 `pinnedSessionIds`、不修复“文件还在但列表消失”的中间态。

### 5.4 稳定性结论

- **同一版本内**：删除路径基本稳定；预检、超时、失败关闭做得比多数插件好。
- **跨 DSH 版本**：脆弱。它不是“公开 API 之上”的实现，而是“公开服务 + 私有字段”的混合；升级时必须回归。
- **提取建议**：把私有访问集中到一个 `compat/` 适配层，启动时做能力探测；关键能力缺失时在删除请求上返回 503/明确诊断，而不是继续执行。这样即使升级破坏，也能快速定位，而不是静默出错。

---

## 6 独立提取可行性

### 6.1 结论

**可行**。删除功能与 `dsh-session-manager` 的其它能力（工作区归档、移动、预设迁移、标记、搜索、批量面板）之间是松耦合的；可以只提取：

- Host：`deleteSession` + 后代发现 + 活动停止 + writer/cache 清理 + 认证 API；
- Client：标题栏/侧栏删除入口 + 确认对话框 + 刷新；
- 文件层：`session-files.js` 的 ID/路径/header 读取部分；
- compat：`session-lifecycle.js`、`projection-cache-delete.js`、`zstd-frames.js`。

不需要提取：工作区管理、会话移动、预设迁移、收藏/标签/备注、批量管理面板、更新检查、设置卡片。

### 6.2 方案对比

| 方案 | 做法 | 优点 | 缺点 | 结论 |
| --- | --- | --- | --- | --- |
| A. 原样复制删除代码 | 把 `deleteSession` 及相关文件整体拷入新包 | 快；行为与现有插件一致 | 继承 R1/R2/R3/R5/R7/R10/R11；仍与 `dsh-session-manager` 的标记/归档数据耦合 | 不推荐 |
| B. 复制 + 加固（推荐） | 保留核心算法，修正清理顺序、pin、伪事件、能力探测、错误展示 | 安全性与可维护性更好；可独立发布 | 需要重写/测试约 1,000–1,500 行 | **推荐** |
| C. 等待 DSH 上游提供删除 API | 不实现，向 DSH 提需求 | 最稳定 | 当前不可用；用户目标无法完成 | 长期方向，不是本轮方案 |

### 6.3 推荐架构（方案 B）

#### 6.3.1 目录与包

```text
dsh-session-deleater/
  package.json
  cordis.patch.yml
  index.js
  client.js
  icon.svg
  locale/en.json
  locale/zh.json
  lib/
    session-files.js
    delete-service.js
    compat/
      projection-cache-delete.js
      session-lifecycle.js
      zstd-frames.js
  scripts/            # 由 build-system/sync.mjs 生成/同步
    build.mjs
    verify.mjs
    host-contract.mjs
    lib/...
  README.md
  FEASIBILITY@0.2.2-rc.3.md
  .gitignore
```

- 包名：`@local/dsh-session-deleater`
- 版本：`0.1.0`
- `private: true`
- `type: module`
- `engines.node: ">=20.0.0"`
- `peerDependencies: { "@deepseek-ai/dsh": "^0.2.2-rc.2" }`
- 零 npm 依赖：Host 只用 `node:fs`、`node:path`、`node:crypto`、`node:zlib`、`node:stream` 等内置模块；不声明 `dependencies`，因此 build 走“不建树”分支，没有 `node_modules/` 与 `deps.lock.json`。

#### 6.3.2 Host 半

`index.js`：

```js
export const name = "dsh-session-deleater";
export const inject = [
  "webServer",
  "workspaceRegistry",
  "sessions",
  "agents",
  "sessionPersistence",
  "connection",
];
export function apply(ctx) {
  const service = createDeleteService(ctx);
  ctx.effect(() => ctx.webServer.register({
    kind: "prefix",
    path: "/session-deleater/api",
    handler: (req, res) => service.handle(req, res),
  }), "session-deleater: api");
}
```

API：

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `GET` | `/session-deleater/api/preview?sessionId=` | 返回 `{ subagentCount, subagents: [{id,parentSession}] }`；扫描不完整时 500。 |
| `POST` | `/session-deleater/api/delete` | body `{ sessionId }`；返回 `{ ok, result }` 或 `{ ok:false, error, code?, deletedSubagents, remainingSessions, partialFailure }`。 |
| `POST` | `/session-deleater/api/batch`（二期可选） | body `{ sessionIds }`；逐条结果。 |

认证：

```js
const admission = ctx.connection.admit(req);
if (!admission || "rejection" in admission) return send(res, 401/403, ...);
if (admission.peer?.principal?.kind !== "owner") return send(res, 403, ...);
```

`delete-service.js` 在现有 `deleteSession` 基础上做以下改动：

1. **能力探测前置**：在停止任何东西之前，检查 `sessions.store`、`entry.detach`、`agents.store`、`agents.detachEntered`、`persistence.tracker` 等；关键能力缺失直接抛 `delete-unsupported`，不进入 live teardown。
2. **清理顺序调整**：`rm` 之前只做“必须前置”的验证、活动停止、writer 排空、session/agent 脱离；`rm` 成功后再做 workspace detach、`unpinSession`、`unarchiveSession`、投影缓存、标记清理，全部按 warning 处理。
3. **主会话复查**：`flush` 后、`detach` 前再跑一次活动检查；发现新活动则中止。
4. **冷会话通知**：不再伪造 `session/disposed`；live 会话靠 `entry.detach()`，冷会话发 `api-session/removed(id)`（并封装在 `notifyColdRemoval()` 中，便于升级时替换）。
5. **pin 清理**：成功后调用 `workspaceRegistry.unpinSession`。
6. **writer 支持标志**：`sessionWriters` 返回 `{ supported, writers }`；`closeSessionWriters` 在 live 会话存在但 `supported === false` 时报错，而不是空数组通过。
7. **Windows 重试**：`rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })`。
8. **错误字段**：保留 `deletedSubagents`、`remainingSessionIds`、`partialFailure`，并加 `artifactRemainingPath`（如果 `rm` 失败）。
9. **不依赖 `dsh-session-manager` 的 annotations/workspace archive store**：独立插件只处理 DSH 自己的 registry 状态；如果两个插件共存，旧插件的标记残留由旧插件自己处理（或后续再加可选适配）。
10. **删除期隔离**：在关闭 writer 后、删除前，把会话目录 `rename` 到同 project 下的 `.deleting-<sessionId>-<random>`，再 `rm` 这个隔离目录；这样即使有并发 resume/materialize，也不会在原来的目录名上“复活”，删除完成后可检测隔离目录是否又被写出。若 rename 失败（Windows 锁），回退到直接 rm 并明确报告竞态风险。

#### 6.3.3 Client 半

用公开 slot：

| Slot | 用途 | 备注 |
| --- | --- | --- |
| `conversation.session.header.actions` | 当前会话标题栏删除按钮 | `list`，`replaceRisk: none`，owner props 无额外字段；标准 props 含 `sessionId`、`useSessions`、`useSessionStatus`。 |
| `sidebar.workspaces.session.row.action` | 侧栏每行 hover 删除按钮 | `list`，owner props `{ sessionId, displayTitle }`；内置 `archive` order 100、`pin` 200；建议新按钮 order 300。 |
| `sidebar.workspaces.session.row.hover` | 可选：hover 卡片里的删除说明 | 非必须。 |

注意：

- `sidebar.session.row.trailing` 是“非交互图标”，不要放删除按钮。
- `sidebar.session.row.action` 不存在；正确的 per-row hover 操作槽是 `sidebar.workspaces.session.row.action`。
- 标题栏/侧栏都有 `overflow` 裁剪，确认对话框必须 portal 到 `document.body` 或专用 overlay root；现有插件的 `renderInOverlay` 证明了这条路径。
- 触屏设备会隐藏 hover 操作槽；标题栏入口是触屏的兜底。如果两个入口都保留，触屏至少能打开会话后删除。

Client 流程：

1. 点击删除按钮 → 打开确认对话框；
2. 并行请求 `/preview`，显示“将连带删除 N 个关联子会话”；
3. 用 `useSessions`/`useSessionStatus` 判断当前会话是否 running，显示中断警告；标题栏路径也必须传入该状态（见 R11），不要依赖 `confirmFor.running`；
4. 预览未完成或失败时禁用“确认删除”；
5. 确认 → `POST /delete` → 成功则 `ctx.sessions.refresh()`、`ctx.workspaces.refresh()`，如果删的是当前会话则 `ctx.uiWorkspace?.clearMain?.()` 或 `ctx.sessions.clear?.()`；
6. 失败则显示错误 + `deletedSubagents`/`remainingSessions`；成功但有 warning 也显示 warning。

#### 6.3.4 与 `dsh-session-manager` 共存

如果两个插件同时启用：

- 标题栏会出现两个删除按钮（`session-manager-header` 与新插件）；
- 侧栏行操作会多一个删除按钮（旧插件没有这个入口，算互补）；
- 两者的删除 API 独立，删同一个会话时第二个会返回 `deleted:false`/幂等成功。

可选策略：

1. **默认双入口**，文档说明重复；用户可停用其中一个插件。
2. **新插件只注册侧栏行操作**，把标题栏留给旧插件；但旧插件被卸载后，触屏用户缺少标题栏入口。
3. **运行时检测旧插件**：用 `ctx.slots.entries("conversation.session.header.actions")` 判断是否已有 `session-manager-header`，有则跳过标题栏注册。`ctx.slots.entries` 在 `dsh-paged-workspace` 的调研中被标记为“运行时兼容层，不是稳定公开契约”，会增加脆弱性。
4. **注册相同 id `session-manager-header` 覆盖旧按钮**：不推荐，属于劫持别的插件 cell。

建议首期采用 **1（默认双入口）+ 文档说明**；如果用户更在意界面干净，再选 3。这个决策留给用户。

#### 6.3.5 版本与构建

- 用 `node build-system/sync.mjs dsh-session-deleater` 获取 `scripts/` 五件套与 `host-contract.mjs` 模板。
- `package.json` 需要：
  - `exports["."] = "./index.js"`、`exports["./client"] = "./client.js"`、`exports["./package.json"]`、`exports["./locale/*.json"]`；
  - `dsh.bundle.patch = "./cordis.patch.yml"`；
  - `dsh.client = { platform: "web", immediately: true, inject: ["@deepseek-ai/dsh-client-ui-slots"] }`；
  - `files` 列出 `index.js`、`client.js`、`lib`、`cordis.patch.yml`、`icon.svg`、`locale/*.json`、`README.md`；
  - `locale/en.json` 必须有 `meta.title`（build verify 要求）；
  - `cordis.patch.yml` 的 `id` 与 Host 导出的 entry id 一致，且包含 `@local/dsh-session-deleater`。
- `host-contract.mjs` 建议断言：
  - Host 导出 `name`/`inject`/`apply`；
  - `inject` 含 `webServer`、`workspaceRegistry`、`sessions`、`agents`、`sessionPersistence`、`connection`；
  - Client 在 VM 中注册了 `conversation.session.header.actions` 与 `sidebar.workspaces.session.row.action`；
  - patch 的 entry id 与包名正确；
  - 无 `dependencies`、无 `node_modules/`。
- `npm run build` 自动跑 `verify`；验收以 `npm run verify` 为准。

#### 6.3.6 许可证与归属

`dsh-session-manager` 是 MIT。提取删除核心属于派生作品，应：

- 保留 MIT 许可证文本；
- 在 README/FEASIBILITY 中注明删除核心源自 `hkkz9522/dsh-session-manager` 0.7.8 的 MIT 代码；
- 不复制与删除无关的业务代码、图标、文案。

### 6.4 工作量估计

| 部分 | 估计 |
| --- | --- |
| Host：session-files 裁剪 + delete-service + compat + 路由/认证 | 600–800 行 |
| Client：slots + 确认对话框 + API 调用 + 样式 + locale | 300–500 行 |
| 构建/探针/文档 | 150–250 行 |
| 测试（单元 + 一次性会话手工/脚本） | 200–400 行 |
| **合计** | **约 1,250–1,950 行** |

---

## 7 实施计划（待用户批准）

### 7.1 首期（Phase 1）

1. 初始化插件目录与 Git（`main` 分支），写 `.gitignore`。
2. 写 `FEASIBILITY@0.2.2-rc.3.md`（本文）与实施后的 `README.md`。
3. 从 `build-system/sync.mjs` 同步构建系统；填 `scripts/host-contract.mjs`。
4. 实现 Host：
   - `lib/session-files.js`（裁剪：ID、编码、目录断言、header 读取、zstd 首行读取）；
   - `lib/compat/session-lifecycle.js`（writer 收集/关闭，带支持标志）；
   - `lib/compat/projection-cache-delete.js`（tombstone/旧缓存清理）；
   - `lib/delete-service.js`（后代发现、活动停止、删除主流程、pin/archive/workspace 清理、冷会话通知）；
   - `index.js`（路由 + 认证 + 能力探测）。
5. 实现 Client：
   - 标题栏 + 侧栏行删除按钮；
   - portal 确认对话框与预览；
   - 成功/失败/部分失败展示；
   - locale（中/英）与样式。
6. 写测试：
   - 纯函数测试：ID 校验、目录候选、路径拒绝、header 解析；
   - Host 单元测试：使用临时目录 + 假 persistence/registry，模拟删除、级联、部分失败、缓存 tombstone；
   - 手工验收：在一次性工作区创建会话/子会话，按第 9 节验证。
7. `npm run build` + `npm run verify`。
8. 完成需要重启 DSH 才能生效的改动后，停止并提示用户重启。

### 7.2 二期（可选）

- 批量删除 API + 一个最小的多选管理面板（如果用户需要与旧插件一致的批量能力）。
- 回收站/延迟删除（把工件移动到 `<home>/.trash/sessions/...`，保留 N 天）——这会改变“不可逆”契约，需要单独决策。
- 配置项（是否显示标题栏/行入口、超时、是否启用回收站）——需要引入 `schemastery` 或 DSH 配置 schema，构建系统会要求 vendor 依赖。
- 与 `dsh-session-manager` 的 annotations/workspace archive store 做可选清理适配（如果用户希望两个插件共存时不留残留）。

---

## 8 问题与解决办法

| 症状 | 根因 | 修法 | 注意事项 |
| --- | --- | --- | --- |
| 删除失败后会话从列表消失，但文件还在，重启又出现 | `rm` 前已经 `detach`/取消 agent，且 `detachFromWorkspaces`/`unarchive` 在 `rm` 前可能抛错（R1） | 把清理类步骤移到 `rm` 之后；`rm` 前只保留必要验证与 teardown；失败时报告工件路径 | 不要把 `rm` 之后才该做的事放到 `rm` 前；错误信息要可恢复 |
| 冷会话删除后，某些插件收到 `session/disposed` 但参数不是 Session（R2） | 手动 `ctx.emit("session/disposed", {id})` | 冷会话改发 `api-session/removed(id)`；live 会话用真实 `entry.detach()` | 这是 API 包内部事件；封装在 `notifyColdRemoval()`，升级时回归 |
| 已置顶会话删除后 `pinnedSessionIds` 仍有 id（R3） | 只 `unarchiveSession`，没 `unpinSession` | 成功后调用 `workspaceRegistry.unpinSession` | 失败只 warning，不撤销删除 |
| DSH 升级后删除“成功”但 writer 没关/agent 残留（R5） | 私有字段缺失时 `?.` 静默跳过 | 删除前做能力探测；关键能力缺失直接 503/报错；writer 用 `{supported, writers}` | 不要把“清理可选”与“生命周期必需”混在一起 |
| 一个损坏会话导致所有删除预览失败（R6） | 全局扫描要求 `complete` | 默认保持失败关闭；错误列出阻塞目录；可选受限模式 | 受限模式必须保证子会话完整性 |
| 删除失败留下空会话目录，之后所有删除预览失败（R7） | `scanSessionHeaders` 把“目录存在但无工件”计为 `complete=false` | 区分空目录与损坏工件；空目录跳过并 warning | 空目录不可能藏子会话，跳过是安全的 |
| 旧缓存 lock 崩溃后一直占用（R8） | lock 文件只在 finally 删除 | lock 写 pid/时间戳，超时检查；或后台重试 | 0.2.2 旧聚合文件少见 |
| 删除窗口内并发 resume 可能重新 materialize 目录（R4） | 删除不经过 DSH 的 open/resume 入口，`materialize()` 会 `mkdir -p` | 删除期 id 墓碑 + 先把目录 rename 到隔离名再删 | 需实机复现；不能只靠插件自己的 `mutate` |
| 冷会话删除时伪造 `session/disposed`，监听器抛错会打断删除（R2） | `ctx.emit` 无逐监听器错误隔离 | 改发 `api-session/removed(id)` 并 try/catch | 不要构造假 Session |
| 标题栏删除不显示“正在运行”警告（R11） | 标题栏只传 `{id, displayTitle}`，警告读 `running` | 从 `useSessions`/`useSessionStatus` 取 running 传入 | 行路径目前有，应对齐 |
| tombstone 不回收；`rm` 半失败回滚 tombstone（R8） | `remove()` 未清 key；`artifactsDeleted` 在 rm 后才置位 | 删除成功后清 key；rm 开始即标记不可回滚 | 避免同 id 还原被永久拦截 |
| 部分失败时用户不知道已删了哪些子会话（R10） | 单条 `runWithAlert` 只显示 message | 错误对话框渲染 `deletedSubagents`/`remainingSessions` | 批量结果已有类似结构，复用 |
| 删除当前会话后主面板没清空 | Client 没清 current | 成功后 `clearMain()`/`clear()` | 只在 `wasCurrent` 或当前 id 匹配时清 |
| Windows 上删除偶发 `EBUSY/EPERM` | 锁文件/杀毒软件占用 | `rm` 加 `maxRetries`/`retryDelay` | 失败要报告路径，不要假装成功 |
| 两个插件同时显示删除按钮 | 都注册标题栏 | 文档说明；或运行时检测旧插件；或只保留行入口 | 不要劫持旧插件 id |
| 删除后 spill 文件/附件还在 | 不在删除范围 | README 说明；spill 由自身 30 天清理，附件内容寻址共享 | 不要为了“干净”删共享附件 |

---

## 9 验证与验收

### 9.1 静态与构建

- `npm run build` 成功，且自动 `verify` 通过。
- `npm run verify` 检查：
  - 无符号链接/Finder 替身/macOS 边角文件；
  - 无 `dependencies` 时无 `node_modules/`；
  - `package.json` 的 `exports`、`dsh.bundle.patch`、`dsh.client`、locale 锚点、icon、`files[]` 全部满足；
  - `index.js`/`client.js` 可解析；
  - Host 半在全新进程里可导入；
  - 构建系统共享文件与 `build-system/` 逐字节一致。
- `host-contract.mjs` 的每条断言都打印并通过。

### 9.2 功能验收（一次性工作区）

> 不要用用户真实会话做测试；新建一个临时工作区（例如 `/tmp/dsh-delete-test`）并在其中创建会话。

1. **冷会话删除**：创建会话 → 关闭/重启后不打开 → 从侧栏行删除 → 工件目录、投影缓存行、workspace 成员、pin、archive 均消失。
2. **live 空闲会话删除**：打开会话 → 标题栏删除 → 确认 → 当前面板清空，列表消失，工件删除。
3. **live 运行中会话删除**：发一条长任务 → 删除 → 应取消、等待空闲、删除；若 3 秒内无法停止，应报超时且不删文件（可重试）。
4. **级联**：创建一个父会话与两个子智能体会话 → 预览显示 `subagentCount: 2` → 删除父 → 三个工件都消失；结果含 `deletedSubagents`。
5. **部分失败**：把一个子会话目录设为不可删除（权限/只读）→ 删除父 → 应删除其它可删的后代、主会话保持，错误含已删/剩余 id；修复权限后可重试。
6. **幂等**：同一会话连续删除两次 → 第二次返回成功且 `deleted:false`/`filesRemoved:false`，无异常。
7. **未知/非法 id**：`../x`、绝对路径、控制字符、空 → 400，磁盘无变化。
8. **符号链接**：把 sessions 下某 project/session 目录替换为指向别处的符号链接/junction → 删除被拒绝，目标不动。
9. **header 不一致**：目录名匹配但 header id 不同 → 拒绝。
10. **并发**：两个客户端同时删同一会话 → 不出现双重 `rm` 异常；第二个幂等成功。
11. **投影缓存竞态**：删除时故意延迟 cache `put` → tombstone 应阻止写回；删除后缓存文件不存在。
12. **并发 resume**：一个客户端删除，另一个客户端在删除窗口内尝试发消息/resume；删除完成后原目录不应被重新 materialize。若无法稳定复现，至少用代码审查 + 故障注入确认隔离 rename 生效。
13. **空残留目录**：手工在 `sessions/<proj>/` 造一个空目录 → 删除其它会话的预览不应被阻塞；修复后的扫描器应把它降级为 warning。
14. **pin 清理**：置顶一个会话 → 删除 → `storages/workspace.json` 的 `pinnedSessionIds` 不再含该 id。
15. **标题栏 running**：在运行中的会话上从标题栏打开确认框 → 应显示“删除将立即中断它”。
16. **重启**：删除后重启 DSH → 列表无幽灵行，workspace/pin/archive 一致。

### 9.3 安全验收

- 无 cookie 的 `POST /delete` → 401。
- 非 owner / 跨站 Origin → 403。
- 请求体超过 64 KiB → 400/413，不进入删除。
- `sessionId` 注入路径分隔符/URL 编码 → 400。
- 只读/不可写目录 → 删除失败且不误删其它目录。

### 9.4 UI 验收

- 标题栏与侧栏按钮的 aria-label、tooltip、禁用态正确。
- 确认对话框在浅色/深色主题下可读；portal 不被 sidebar/header 的 overflow 裁剪。
- 预览加载中、失败、子会话数、running 警告均正确。
- 删除成功后当前会话被清空；其它已打开客户端收到列表更新。
- 部分失败时能看到“已删/剩余”信息。
- 触屏宽度下标题栏入口仍可用（hover 入口隐藏时）。

### 9.5 升级回归

- 在 DSH 升级后，先运行 `npm run verify` 与 `host-contract.mjs`；
- 再执行以下探测（可在插件启动日志或 API `/health` 输出）：
  - `sessions.store` / `entry.detach`
  - `agents.store` / `detachEntered`
  - `persistence.tracker` / `writers` / `openHandles`
  - `sessionProjectionCache.requireTable`
  - `workspaceRegistry.unpinSession`
- 任一关键项缺失：删除 API 返回明确错误，不执行 teardown。

---

## 10 决策点（需要用户确认）

1. **首期 UI 范围**：只做“标题栏 + 侧栏行”单条删除，还是同时做批量删除/管理面板？
   - 建议：首期单条；批量二期。
2. **与 `dsh-session-manager` 共存**：默认双删除按钮（简单稳定），还是运行时检测旧插件后隐藏标题栏按钮（界面干净但依赖 `ctx.slots.entries` 兼容层）？
   - 建议：首期双入口 + 文档说明。
3. **回收站/撤销**：是否要把“不可逆”改成“移动到回收站，N 天后清理”？
   - 建议：首期保持不可逆（与现有契约一致）；回收站作为二期可选。
4. **配置项**：是否需要“显示/隐藏标题栏/行入口、超时时间、回收站天数”等配置？
   - 如果需要，构建系统要 vendor `schemastery`，并新增 Host `Config`。
5. **兼容策略**：关键私有接口缺失时，是“插件加载失败”还是“插件加载但删除 API 报 503”？
   - 建议：加载但不提供删除，返回 503 + 诊断；这样不会影响 DSH 启动，也便于用户看到原因。
6. **许可证归属**：是否接受在 README/LICENSE 中注明删除核心源自 MIT 的 `hkkz9522/dsh-session-manager`？
   - 建议：必须注明。

---

## 11 参考坐标

### 11.1 被调查插件

- `~/.dsh/profiles/desktop/node_modules/dsh-session-manager/package.json`
- `.../README.zh.md`（删除、级联、投影缓存、认证的说明，约第 20–27 行）
- `.../lib/index.js`
  - `scanSessionHeaders`：约 `:124`
  - `unarchiveSession`：`:474`
  - `detachFromWorkspaces`：`:606`
  - `readSessionArtifact`：`:1816`
  - `sessionDirOf`：`:1870`
  - `findDescendantSubagents`：`:1883`
  - `assertAndStopActiveSession`：`:1955`
  - `deleteSession`：`:2019`
  - 主会话 teardown：`:2094–2166`
  - 失败/部分失败：`:2217–2228`
  - 认证：`:2521`
  - 路由：`:2568`
  - 删除分支：`:2606`
  - 批量删除：`:2691`
  - 删除预览：`:2762`
- `.../lib/session-files.js`
  - `assertSessionId`：`:22`
  - `encodeFsSessionSegment`：`:58`
  - `candidateSessionDirs`：`:125`
  - `assertSessionDirectory`：`:139`
  - `readSessionHeader`：`:189`
  - `readSessionFile`：`:214`
- `.../lib/compat/session-lifecycle.js`
  - `awaitSessionStep`：`:2`
  - `sessionWriters`：`:17`
  - `closeSessionWriters`：`:28`
- `.../lib/compat/projection-cache-delete.js`
  - `beginProjectionCacheDeletion`：`:16`
  - `assertProjectionCachePath`：`:63`
  - `removeLegacyProjectionCache`：`:78`
- `.../lib/client.js`
  - `ConfirmDialog`：`:3494`
  - 单条删除确认：`:6631`
  - 标题栏删除按钮：`:6491`
  - 认证后的删除调用 `onRemove`：`:7312`
  - slot 注册：`:7414`、`:7421`

### 11.2 DSH 0.2.2-rc.3

- `@deepseek-ai/dsh-session/src/index.ts`
  - `SessionStore`：`:1144`
  - `private store`：`:1145`
  - `enter()` 与 `entry.detach`：`:1311–1344`
  - `private detachEntered`：`:1347`
  - `flush()`：`:1422`
  - `session/disposed` 声明：`:65`
- `@deepseek-ai/dsh-agent/src/index.ts`
  - `AgentRegistry`：`:246`
  - `private store`：`:250`
  - `private detachEntered`：`:511`
  - `get()`：`:580`
- `@deepseek-ai/dsh-session-persistence-jsonl/src/index.ts`
  - `private readonly tracker`：`:316`
- `@deepseek-ai/dsh-session-persistence-jsonl/src/storage.ts`
  - `JsonlBackendTracker`：`:391`
  - `openHandles`：`:393`
  - `private writers`：`:395`
- `@deepseek-ai/dsh-session-persistence-jsonl/src/lease.ts`
  - “POSIX lock 文件永不删除”的说明：`:118–123`
- `@deepseek-ai/dsh-session-projection-cache/src/index.ts`
  - `SessionProjectionCache`：`:105`
  - `private requireTable`：`:398`
- `@deepseek-ai/dsh-storage-domain/src/domain.ts`
  - `KvTable`：`:43`
  - `TableHost`/`host`：`:197`
- `@deepseek-ai/dsh-storage/src/backend.ts`
  - `KvUnit`：`:88`
  - `layout`：`:64`
- `@deepseek-ai/dsh-storage-json/src/index.ts`
  - `descriptor.layout === 'per-record'`：`:69`
  - `PerRecordJsonUnit` 私有 `descriptor`：`per-record-unit.ts:200–201`
- `@deepseek-ai/dsh-workspace/src/entity.ts`
  - `private record`：`:71`
  - `detachSession`：`:175`
- `@deepseek-ai/dsh-workspace/src/index.ts`
  - `unarchiveSession`：`:420`
  - `unpinSession`：`:477`
- `@deepseek-ai/dsh-session-persistence/README.zh.md`
  - “无删除或保留接口”：`:153`
- `@deepseek-ai/dsh-workspace/README.zh.md`
  - 会话删除尚未提供：`:171`
- `@deepseek-ai/dsh-client-connection/src/index.ts`
  - `/api` 的 `connection.admit(req)`：`:151`
- `@deepseek-ai/dsh-client-connection/src/rpc.ts`
  - `HostConnectionHandle.admit`：`:240`

### 11.3 活体 Inspect（2026-11-17）

- `conversation.session.header.actions`：`list`，`replaceRisk: none`，当前 occupants 含 `session-manager-header`（order 0）。
- `sidebar.workspaces.session.row.action`：`list`，`replaceRisk: none`，当前 occupants 为 `archive`（order 100）与 `pin`（order 200）；owner props `{ sessionId, displayTitle }`。
- `sidebar.session.row.trailing`：非交互图标，不适合放删除按钮。
- `sidebar.session.row.action`：不存在（查询返回 `available: false`）。
- `workspace/session-activity`：waterfall；`workspace/session-stop`：parallel。
- `api-session/removed`：emit，签名 `(sessionId: SessionId) => void`。
- `session/disposed`：emit，签名 `(session: Session) => void`。

### 11.4 证据限制

- DSH 源码以 `src/*.ts` 为准；对 `lib/*.js` 只抽查了 `dsh-session`/`dsh-agent` 的 `store` 与 `detachEntered` 仍为普通属性。其余私有字段在编译产物中的确切形状未逐一核对。
- “并发 resume 重新 materialize”来自对 `persistBatch`/`materializePosix` 的静态推理，未在真实 DSH 进程中复现；文中已标为待验证。
- `fs.rm` 对 Windows junction/只读文件的精确行为未在本机实测；相关建议按防御性设计给出。
- 未删除任何真实会话；功能验收必须在一次性工作区进行。

---

## 12 本轮结论

1. `dsh-session-manager` 的删除实现不是简单的 `rm -rf`：它在 ID、路径、header、活动、writer、投影缓存和认证上都做了防御，整体安全性明显高于普通插件。
2. 但它不是事务性删除，也不是公开 API 之上的实现：`rm` 前的清理顺序、私有的 `sessions.store`/`agents.store`/`persistence.tracker`/`requireTable`、伪造且无错误隔离的 `session/disposed`、未清理的 pin、删除窗口内的 resume/materialize 竞态、标题栏缺失的 running 警告，都是提取版应当修正的点。
3. 提取为独立插件完全可行：Host 零 npm 依赖，Client 使用公开 slot；首期做单条删除 + 级联 + 预览 + 标题栏/侧栏入口即可。
4. 本轮按工作区规则只产出调研文档，不写实现代码。下一步需要用户确认第 10 节的决策点，并新开一轮再开始实际编码。
